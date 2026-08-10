import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { created } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();

const transferSchema = z.object({
  from_account_id: z.string().min(1),
  to_account_id: z.string().min(1),
  amount: z.number().int().positive(),
  note: z.string().optional()
});

router.post("/", requireProject, requireRoles("accountant"), validateBody(transferSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof transferSchema>;
  if (body.from_account_id === body.to_account_id) {
    throw badRequest("from_account_id and to_account_id must differ");
  }

  const accounts = await prisma.account.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      id: { in: [body.from_account_id, body.to_account_id] }
    }
  });
  const from = accounts.find((account) => account.id === body.from_account_id);
  const to = accounts.find((account) => account.id === body.to_account_id);
  if (!from || !to) throw notFound("Both accounts must exist in the active project");
  if (from.balance < body.amount) throw badRequest("Source account has insufficient balance");

  const transfer = await prisma.$transaction(async (tx) => {
    const record = await tx.transfer.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: body.amount,
        note: body.note,
        createdById: auth.userId
      }
    });

    const updatedFrom = await tx.account.update({
      where: { id: from.id },
      data: { balance: { decrement: body.amount } }
    });
    const updatedTo = await tx.account.update({
      where: { id: to.id },
      data: { balance: { increment: body.amount } }
    });

    await tx.accountTransaction.createMany({
      data: [
        {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          accountId: from.id,
          direction: "transfer",
          amount: body.amount,
          referenceType: "transfer",
          referenceId: record.id,
          description: body.note ?? `Transfer to ${to.name}`,
          balanceAfter: updatedFrom.balance,
          createdById: auth.userId
        },
        {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          accountId: to.id,
          direction: "transfer",
          amount: body.amount,
          referenceType: "transfer",
          referenceId: record.id,
          description: body.note ?? `Transfer from ${from.name}`,
          balanceAfter: updatedTo.balance,
          createdById: auth.userId
        }
      ]
    });

    return record;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "transfer.created",
    entityType: "transfer",
    entityId: transfer.id,
    after: transfer
  });

  return created(res, transfer);
}));

export { router as transfersRouter };
