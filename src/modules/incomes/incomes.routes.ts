import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { forbidden, notFound } from "../../core/http/api-error.js";
import { created } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();

const incomeSchema = z.object({
  account_id: z.string().min(1),
  amount: z.number().int().positive(),
  source: z.string().min(2).max(120).optional(),
  note: z.string().max(500).optional()
});

async function getIncomeApprovalFlow(tenantId: string) {
  const progress = await prisma.onboardingProgress.findUnique({
    where: { tenantId },
    select: { incomeApprovalFlow: true }
  });
  return progress?.incomeApprovalFlow ?? "accountant_only";
}

router.post("/", requireProject, requireRoles("accountant", "approver", "admin"), validateBody(incomeSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof incomeSchema>;
  const approvalFlow = await getIncomeApprovalFlow(auth.tenantId);

  if (approvalFlow === "accountant_only") {
    if (!auth.roles.includes("accountant") && !auth.roles.includes("admin")) {
      throw forbidden("Only accountant verification is enabled for income; ask an accountant to record this.");
    }
  } else if (!auth.roles.includes("approver") && !auth.roles.includes("admin")) {
    throw forbidden("Income requires approver verification in the current approval flow.");
  }

  const account = await prisma.account.findFirst({
    where: { id: body.account_id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  const result = await prisma.$transaction(async (tx) => {
    const updatedAccount = await tx.account.update({
      where: { id: account.id },
      data: { balance: { increment: body.amount } }
    });

    const transaction = await tx.accountTransaction.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        direction: "money_in",
        amount: body.amount,
        referenceType: "income",
        referenceId: account.id,
        description: body.note ?? body.source ?? "Manual income entry",
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    });

    return { updatedAccount, transaction };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "income.recorded",
    entityType: "account_transaction",
    entityId: result.transaction.id,
    before: { account_id: account.id, balance: account.balance },
    after: {
      ...result.transaction,
      approval_flow: approvalFlow
    }
  });

  return created(res, {
    id: result.transaction.id,
    account_id: account.id,
    amount: result.transaction.amount,
    balance_after: result.updatedAccount.balance,
    description: result.transaction.description
  });
}));

export { router as incomesRouter };
