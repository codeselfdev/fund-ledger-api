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
  vendor_id: z.string().min(1).optional(),
  account_id: z.string().min(1).optional(),
  doc_file_id: z.string().optional(),
  lines: z.array(purchaseLineSchema).min(1)
});

const receiveSchema = z.object({
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

  const totalAmount = body.lines.reduce((sum, line) => sum + line.quantity * line.unit_cost, 0);

  const purchase = await prisma.$transaction(async (tx) => {
    const createdPurchase = await tx.purchase.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        vendorId: body.vendor_id,
        accountId: body.account_id,
        docFileId: body.doc_file_id,
        totalAmount,
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
    include: { vendor: true, account: true, lines: { include: { item: true } } },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, purchases);
}));

router.get("/:id", requireProject, requireRoles("staff"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const purchase = await prisma.purchase.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { vendor: true, account: true, lines: { include: { item: true } } }
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

  const result = await prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.update({
      where: { id },
      data: {
        status: "received",
        accountId: account.id,
        receivedById: auth.userId,
        receivedAt: new Date()
      }
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
          type: "purchase_received",
          quantity: line.quantity,
          quantityAfter: item.quantity,
          referenceType: "purchase",
          referenceId: id,
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
        referenceType: "purchase",
        referenceId: id,
        description: "Purchase received",
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    });

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

  const purchase = await prisma.purchase.update({
    where: { id },
    data: { status: "cancelled", cancelledById: auth.userId }
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
