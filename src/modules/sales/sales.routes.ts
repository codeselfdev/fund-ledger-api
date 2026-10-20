import { changeStock, stockEnabled, stockLocation } from '../inventory/stock.service.js';
import { financialTransaction } from '../accounting/transaction.js';
import { documentTax, postTax, json, lockSetup } from '../business-setup/service.js';
import { taxSelectionSchema } from '../business-setup/validation.js';
import { Router } from "express";
import { z } from "zod";
import { SaleStatus } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";

const router = Router();

const saleLineSchema = z.object({
  item_id: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().int().min(0).optional()
});

const createSaleSchema = z.object({
  location_id: z.string().min(1).optional(),
  account_id: z.string().min(1),
  customer_name: z.string().max(120).optional(),
  tax_selection: taxSelectionSchema.optional(),
  lines: z.array(saleLineSchema).min(1)
});

const listQuerySchema = z.object({
  status: z.nativeEnum(SaleStatus).optional()
});

router.post("/", requireProject, requireRoles("cashier", "accountant", "admin"), validateBody(createSaleSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createSaleSchema>;

  const account = await prisma.account.findFirst({
    where: { id: body.account_id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  const itemIds = [...new Set(body.lines.map((line) => line.item_id))];
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: itemIds }, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  const missing = itemIds.filter((itemId) => !items.some((item) => item.id === itemId));
  if (missing.length > 0) throw notFound("Item not found", { missing_item_ids: missing });

  const itemsById = new Map(items.map((item) => [item.id, item]));

  const resolvedLines = body.lines.map((line) => {
    const item = itemsById.get(line.item_id)!;
    const unitPrice = line.unit_price ?? item.sellPrice;
    return { item, quantity: line.quantity, unitPrice, lineTotal: line.quantity * unitPrice };
  });


  const result = await financialTransaction(async (tx) => {
    await lockSetup(tx, auth);
    const trackStock = await stockEnabled(tx, auth);
    const location = trackStock ? await stockLocation(tx, auth, body.location_id) : null;
    const taxSnapshot = await documentTax(tx, auth, 'sale', resolvedLines.map(line => line.lineTotal), 0, body.tax_selection);
    const totalAmount = taxSnapshot?.payable ?? resolvedLines.map(line => line.lineTotal).reduce((a, b) => a + b, 0);
    const sale = await tx.sale.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        stockLocationId: location?.id,
        stockTracked: trackStock,
        customerName: body.customer_name,
        totalAmount,
        taxSnapshot: taxSnapshot ? json(taxSnapshot) : undefined,
        status: "completed",
        soldById: auth.userId
      }
    });

    await tx.saleItem.createMany({
      data: resolvedLines.map((line) => ({
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        saleId: sale.id,
        itemId: line.item.id,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal
      }))
    });

    if (trackStock) for (const line of [...resolvedLines].sort((a, b) => a.item.id.localeCompare(b.item.id))) {
      await changeStock(tx, auth, { itemId: line.item.id, delta: -line.quantity, locationId: location!.id, type: 'sale', referenceType: 'sale', referenceId: sale.id });
    }

    const updatedAccount = await tx.account.update({
      where: { id: account.id },
      data: { balance: { increment: totalAmount } }
    });

    await tx.accountTransaction.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        direction: "money_in",
        amount: totalAmount,
        referenceType: "sale",
        referenceId: sale.id,
        description: "Sale",
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    });

    await postTax(tx, auth, 'sale', sale.id, taxSnapshot, 'output');
    return sale;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "sale.created",
    entityType: "sale",
    entityId: result.id,
    after: result
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: ["accountant", "auditor"],
    type: "sale.created",
    title: "Sale recorded",
    body: `A sale of ${result.totalAmount} was recorded.`,
    entityType: "sale",
    entityId: result.id
  });

  return created(res, result);
}));

router.get("/", requireProject, requireRoles("staff", "cashier"), validateQuery(listQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof listQuerySchema>;

  const sales = await prisma.sale.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.status ? { status: query.status } : {})
    },
    include: { account: true, stockLocation: true, lines: { include: { item: true } } },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, sales);
}));

router.get("/:id", requireProject, requireRoles("staff", "cashier"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const sale = await prisma.sale.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { account: true, stockLocation: true, lines: { include: { item: true } } }
  });
  if (!sale) throw notFound("Sale not found");

  return ok(res, sale);
}));

router.post("/:id/cancel", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const before = await prisma.sale.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { lines: true }
  });
  if (!before) throw notFound("Sale not found");
  if (before.status !== "completed") throw badRequest("Only completed sales can be cancelled");

  const account = await prisma.account.findFirstOrThrow({
    where: { id: before.accountId, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (account.balance < before.totalAmount) {
    throw badRequest("Account has insufficient balance to reverse this sale");
  }

  const result = await financialTransaction(async (tx) => {
    await lockSetup(tx, auth);
    const current = await tx.sale.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: 'completed' } });
    if (!current) throw badRequest('Only completed sales can be cancelled');
    const sale = await tx.sale.update({
      where: { id },
      data: { status: "cancelled", cancelledById: auth.userId, cancelledAt: new Date() }
    });

    if (current.stockTracked) for (const line of [...before.lines].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
      await changeStock(tx, auth, { itemId: line.itemId, delta: line.quantity, locationId: current.stockLocationId, type: 'adjustment_increase', referenceType: 'sale_cancel', referenceId: id, reason: 'Sale cancelled', restoring: true });
    }

    const debited = await tx.account.updateMany({
      where: { id: account.id, tenantId: auth.tenantId, projectId: auth.projectId, balance: { gte: before.totalAmount } },
      data: { balance: { decrement: before.totalAmount } }
    });
    if (!debited.count) throw badRequest('Account has insufficient balance to reverse this sale');
    const updatedAccount = await tx.account.findFirstOrThrow({ where: { id: account.id, tenantId: auth.tenantId, projectId: auth.projectId } });

    await tx.accountTransaction.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        direction: "money_out",
        amount: before.totalAmount,
        referenceType: "sale_cancel",
        referenceId: id,
        description: "Sale cancelled — reversal",
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    });

    await postTax(tx, auth, 'sale', id, before.taxSnapshot, 'output', true);
    return sale;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "sale.cancelled",
    entityType: "sale",
    entityId: id,
    before,
    after: result
  });

  return ok(res, result);
}));

export { router as salesRouter };
