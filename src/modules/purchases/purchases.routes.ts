import { changeStock, stockEnabled, stockLocation } from '../inventory/stock.service.js';
import { documentTax, postTax, json, lockSetup } from '../business-setup/service.js';
import { taxSelectionSchema } from '../business-setup/validation.js';
import { financialTransaction } from "../accounting/transaction.js";
import { Router } from "express";
import { z } from "zod";
import { PurchaseStatus } from "@prisma/client";
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

const purchaseLineSchema = z.object({
  item_id: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_cost: z.number().int().min(0)
});

const createPurchaseSchema = z.object({
  location_id: z.string().min(1).optional(),
  vendor_id: z.string().min(1).optional(),
  account_id: z.string().min(1).optional(),
  doc_file_id: z.string().optional(),
  tax_selection: taxSelectionSchema.optional(),
  lines: z.array(purchaseLineSchema).min(1)
});

const receiveSchema = z.object({
  location_id: z.string().min(1).optional(),
  account_id: z.string().min(1).optional()
});

const listQuerySchema = z.object({
  status: z.nativeEnum(PurchaseStatus).optional()
});

router.post("/", requireProject, requireRoles("accountant", "admin"), validateBody(createPurchaseSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createPurchaseSchema>;

  if (body.vendor_id) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: body.vendor_id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!vendor) throw notFound("Vendor not found");
  }

  const itemIds = [...new Set(body.lines.map((line) => line.item_id))];
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: itemIds }, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  const missing = itemIds.filter((itemId) => !items.some((item) => item.id === itemId));
  if (missing.length > 0) throw notFound("Item not found", { missing_item_ids: missing });

  if (body.account_id) {
    const account = await prisma.account.findFirst({
      where: { id: body.account_id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!account) throw notFound("Account not found");
  }



  const purchase = await prisma.$transaction(async (tx) => {
    await lockSetup(tx, auth);
    const location = await stockEnabled(tx, auth) ? await stockLocation(tx, auth, body.location_id) : null;
    const taxSnapshot = await documentTax(tx, auth, 'purchase', body.lines.map(line => line.quantity * line.unit_cost), 0, body.tax_selection);
    const totalAmount = taxSnapshot?.payable ?? body.lines.map(line => line.quantity * line.unit_cost).reduce((a, b) => a + b, 0);
    const createdPurchase = await tx.purchase.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        vendorId: body.vendor_id,
        stockLocationId: location?.id,
        accountId: body.account_id,
        docFileId: body.doc_file_id,
        totalAmount,
        taxSnapshot: taxSnapshot ? json(taxSnapshot) : undefined,
        status: "ordered",
        createdById: auth.userId
      }
    });

    await tx.purchaseItem.createMany({
      data: body.lines.map((line) => ({
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        purchaseId: createdPurchase.id,
        itemId: line.item_id,
        quantity: line.quantity,
        unitCost: line.unit_cost,
        lineTotal: line.quantity * line.unit_cost
      }))
    });

    return createdPurchase;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "purchase.ordered",
    entityType: "purchase",
    entityId: purchase.id,
    after: purchase
  });

  return created(res, purchase);
}));

router.get("/", requireProject, requireRoles("staff"), validateQuery(listQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof listQuerySchema>;

  const purchases = await prisma.purchase.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.status ? { status: query.status } : {})
    },
    include: { vendor: true, account: true, stockLocation: true, lines: { include: { item: true } } },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, purchases);
}));

router.get("/:id", requireProject, requireRoles("staff"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const purchase = await prisma.purchase.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { vendor: true, account: true, stockLocation: true, lines: { include: { item: true } } }
  });
  if (!purchase) throw notFound("Purchase not found");

  return ok(res, purchase);
}));

router.post("/:id/receive", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), validateBody(receiveSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof receiveSchema>;

  const before = await prisma.purchase.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { lines: true }
  });
  if (!before) throw notFound("Purchase not found");
  if (before.status !== "ordered") throw badRequest("Purchase is not awaiting receipt");

  const resolvedAccountId = body.account_id ?? before.accountId;
  if (!resolvedAccountId) throw badRequest("account_id is required before this purchase can be received");

  const account = await prisma.account.findFirst({
    where: { id: resolvedAccountId, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");
  if (account.balance < before.totalAmount) throw badRequest("Source account has insufficient balance");

  const result = await financialTransaction(async (tx) => {
    const linkedBill = await tx.constructionSupplierBill.findFirst({ where: { tenantId: auth.tenantId, projectId: auth.projectId, purchaseId: id, status: { in: ["pending", "approved"] } } });
    if (linkedBill) throw badRequest("Receive this purchase through its Construction supplier bill; payments are recorded separately");
    const current = await tx.purchase.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: "ordered" } });
    if (!current) throw badRequest("Purchase is not awaiting receipt");
    const debit = await tx.account.updateMany({ where: { id: account.id, tenantId: auth.tenantId, projectId: auth.projectId, balance: { gte: before.totalAmount } }, data: { balance: { decrement: before.totalAmount } } });
    if (!debit.count) throw badRequest("Source account has insufficient balance");
    const trackStock = await stockEnabled(tx, auth);
    const location = trackStock ? await stockLocation(tx, auth, body.location_id ?? current.stockLocationId) : null;
    const purchase = await tx.purchase.update({
      where: { id },
      data: {
        status: "received",
        stockTracked: trackStock,
        stockLocationId: location?.id ?? current.stockLocationId,
        accountId: account.id,
        receivedById: auth.userId,
        receivedAt: new Date()
      }
    });

    if (trackStock) for (const line of [...before.lines].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
      await changeStock(tx, auth, { itemId: line.itemId, delta: line.quantity, locationId: location!.id, type: 'purchase_received', referenceType: 'purchase', referenceId: id });
    }

    const updatedAccount = await tx.account.findFirstOrThrow({ where: { id: account.id, tenantId: auth.tenantId, projectId: auth.projectId } });

    await tx.accountTransaction.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        direction: "money_out",
        amount: before.totalAmount,
        referenceType: "purchase",
        referenceId: id,
        description: "Purchase received",
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    });

    await postTax(tx, auth, 'purchase', id, before.taxSnapshot, 'input');
    return purchase;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "purchase.received",
    entityType: "purchase",
    entityId: id,
    before,
    after: result
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: ["auditor", "approver"],
    type: "purchase.received",
    title: "Purchase received",
    body: `A purchase of ${before.totalAmount} was received and stock updated.`,
    entityType: "purchase",
    entityId: id
  });

  return ok(res, result);
}));

router.post("/:id/cancel", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const before = await prisma.purchase.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Purchase not found");
  if (before.status !== "ordered") throw badRequest("Only purchases awaiting receipt can be cancelled");

  const purchase = await financialTransaction(async (tx) => {
    const linkedBill = await tx.constructionSupplierBill.findFirst({ where: { tenantId: auth.tenantId, projectId: auth.projectId, purchaseId: id, status: { in: ["pending", "approved"] } } });
    if (linkedBill) throw badRequest("A Construction supplier bill is attached; reject it before cancelling an unreceived purchase");
    const changed = await tx.purchase.updateMany({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: "ordered" }, data: { status: "cancelled", cancelledById: auth.userId } });
    if (!changed.count) throw badRequest("Only purchases awaiting receipt can be cancelled");
    return tx.purchase.findFirstOrThrow({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "purchase.cancelled",
    entityType: "purchase",
    entityId: id,
    before,
    after: purchase
  });

  return ok(res, purchase);
}));

export { router as purchasesRouter };
