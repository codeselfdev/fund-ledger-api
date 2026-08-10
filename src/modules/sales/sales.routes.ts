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
  account_id: z.string().min(1),
  customer_name: z.string().max(120).optional(),
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
  for (const line of body.lines) {
    const item = itemsById.get(line.item_id)!;
    if (line.quantity > item.quantity) {
      throw badRequest(`Insufficient stock for "${item.name}"`, { item_id: item.id, available: item.quantity });
    }
  }

  const resolvedLines = body.lines.map((line) => {
    const item = itemsById.get(line.item_id)!;
    const unitPrice = line.unit_price ?? item.sellPrice;
    return { item, quantity: line.quantity, unitPrice, lineTotal: line.quantity * unitPrice };
  });
  const totalAmount = resolvedLines.reduce((sum, line) => sum + line.lineTotal, 0);

  const result = await prisma.$transaction(async (tx) => {
    const sale = await tx.sale.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        customerName: body.customer_name,
        totalAmount,
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

    for (const line of resolvedLines) {
      const item = await tx.inventoryItem.update({
        where: { id: line.item.id },
        data: { quantity: { decrement: line.quantity } }
      });

      await tx.stockMovement.create({
        data: {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          itemId: line.item.id,
          type: "sale",
          quantity: line.quantity,
          quantityAfter: item.quantity,
          referenceType: "sale",
          referenceId: sale.id,
          createdById: auth.userId
        }
      });
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
    body: `A sale of ${totalAmount} was recorded.`,
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
    include: { account: true, lines: { include: { item: true } } },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, sales);
}));

router.get("/:id", requireProject, requireRoles("staff", "cashier"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const sale = await prisma.sale.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { account: true, lines: { include: { item: true } } }
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

  const result = await prisma.$transaction(async (tx) => {
    const sale = await tx.sale.update({
      where: { id },
      data: { status: "cancelled", cancelledById: auth.userId, cancelledAt: new Date() }
    });

    for (const line of before.lines) {
      const item = await tx.inventoryItem.update({
        where: { id: line.itemId },
        data: { quantity: { increment: line.quantity } }
      });

      await tx.stockMovement.create({
        data: {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          itemId: line.itemId,
          type: "adjustment_increase",
          quantity: line.quantity,
          quantityAfter: item.quantity,
          referenceType: "sale_cancel",
          referenceId: id,
          reason: "Sale cancelled",
          createdById: auth.userId
        }
      });
    }

    const updatedAccount = await tx.account.update({
      where: { id: account.id },
      data: { balance: { decrement: before.totalAmount } }
    });

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
