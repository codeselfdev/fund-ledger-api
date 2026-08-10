import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();

const createAccountSchema = z.object({
  name: z.string().min(2).max(64),
  type: z.enum(["bank", "cash"]),
  is_default: z.boolean().optional(),
  opening_balance: z.number().int().min(0).optional()
});

const adjustAccountSchema = z.object({
  direction: z.enum(["money_in", "money_out"]),
  amount: z.number().int().positive(),
  reason: z.string().min(3)
});

async function ensureOpeningBalanceIncomeBackfill(input: {
  tenantId: string;
  projectId: string;
  account: { id: string; balance: number };
}) {
  if (input.account.balance <= 0) return;

  const txnCount = await prisma.accountTransaction.count({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      accountId: input.account.id
    }
  });
  if (txnCount > 0) return;

  await prisma.accountTransaction.create({
    data: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      accountId: input.account.id,
      direction: "money_in",
      amount: input.account.balance,
      referenceType: "income",
      referenceId: input.account.id,
      description: "Opening balance income (backfilled)",
      balanceAfter: input.account.balance,
      createdById: null
    }
  });
}

function mapInOutEntries(transactions: Array<{
  id: string;
  direction: "money_in" | "money_out" | "transfer" | "penalty";
  amount: number;
  description: string | null;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}>) {
  return transactions
    .flatMap((transaction) => {
      if (transaction.direction === "money_in") {
        return [{
          id: transaction.id,
          type: "in" as const,
          amount: transaction.amount,
          title: transaction.description ?? transaction.referenceType ?? "Account movement",
          created_at: transaction.createdAt,
          reference_type: transaction.referenceType,
          reference_id: transaction.referenceId
        }];
      }

      if (transaction.direction === "money_out") {
        return [{
          id: transaction.id,
          type: "out" as const,
          amount: transaction.amount,
          title: transaction.description ?? transaction.referenceType ?? "Account movement",
          created_at: transaction.createdAt,
          reference_type: transaction.referenceType,
          reference_id: transaction.referenceId
        }];
      }

      if (transaction.direction === "transfer") {
        const isIncomingTransfer = (transaction.description ?? "").toLowerCase().includes("transfer from");
        return [{
          id: transaction.id,
          type: isIncomingTransfer ? "in" as const : "out" as const,
          amount: transaction.amount,
          title: transaction.description ?? "Transfer",
          created_at: transaction.createdAt,
          reference_type: transaction.referenceType,
          reference_id: transaction.referenceId
        }];
      }

      return [];
    });
}

router.post("/", requireProject, requireRoles("accountant", "admin"), validateBody(createAccountSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createAccountSchema>;

  const existing = await prisma.account.findFirst({
    where: { projectId: auth.projectId, name: body.name }
  });
  if (existing) throw conflict("An account with this name already exists");

  const shouldBeDefault = body.is_default === true;
  const openingBalance = body.opening_balance ?? 0;
  const result = await prisma.$transaction(async (tx) => {
    if (shouldBeDefault) {
      await tx.account.updateMany({
        where: { projectId: auth.projectId, isDefault: true },
        data: { isDefault: false }
      });
    }

    const createdAccount = await tx.account.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        name: body.name,
        type: body.type,
        balance: openingBalance,
        isDefault: shouldBeDefault
      }
    });

    if (openingBalance > 0) {
      const openingTransaction = await tx.accountTransaction.create({
        data: {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          accountId: createdAccount.id,
          direction: "money_in",
          amount: openingBalance,
          referenceType: "income",
          referenceId: createdAccount.id,
          description: "Opening balance income",
          balanceAfter: createdAccount.balance,
          createdById: auth.userId
        }
      });

      return { account: createdAccount, openingTransaction };
    }

    return { account: createdAccount, openingTransaction: null };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "account.created",
    entityType: "account",
    entityId: result.account.id,
    after: result.account
  });

  if (result.openingTransaction) {
    await writeAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      action: "income.recorded",
      entityType: "account_transaction",
      entityId: result.openingTransaction.id,
      before: { account_id: result.account.id, balance: 0 },
      after: result.openingTransaction
    });
  }

  return created(res, result.account);
}));

router.get("/", requireProject, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const accounts = await prisma.account.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }]
  });
  const total = accounts.reduce((sum, account) => sum + account.balance, 0);
  return ok(res, { accounts, total_balance: total });
}));

router.post("/:id/adjust", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), validateBody(adjustAccountSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof adjustAccountSchema>;

  const account = await prisma.account.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  if (body.direction === "money_out" && account.balance < body.amount) {
    throw badRequest("Account has insufficient balance for this adjustment");
  }

  const result = await prisma.$transaction(async (tx) => {
    const updatedAccount = await tx.account.update({
      where: { id },
      data: {
        balance: body.direction === "money_in" ? { increment: body.amount } : { decrement: body.amount }
      }
    });

    const transaction = await tx.accountTransaction.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: id,
        direction: body.direction,
        amount: body.amount,
        referenceType: "adjustment",
        description: body.reason,
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    });

    return { account: updatedAccount, transaction };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "account.adjusted",
    entityType: "account",
    entityId: id,
    before: { balance: account.balance },
    after: result.account
  });

  return ok(res, result.account);
}));

router.get("/:id/transactions", requireProject, requireRoles("staff"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const account = await prisma.account.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  await ensureOpeningBalanceIncomeBackfill({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    account: { id: account.id, balance: account.balance }
  });

  const transactions = await prisma.accountTransaction.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, accountId: id },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, { account, transactions });
}));

router.get("/:id/in-out", requireProject, requireRoles("staff"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const account = await prisma.account.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  await ensureOpeningBalanceIncomeBackfill({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    account: { id: account.id, balance: account.balance }
  });

  const transactions = await prisma.accountTransaction.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      accountId: id,
      direction: { in: ["money_in", "money_out", "transfer"] }
    },
    orderBy: { createdAt: "desc" }
  });

  const entries = mapInOutEntries(transactions);

  const totals = entries.reduce((acc, entry) => {
    if (entry.type === "in") acc.total_in += entry.amount;
    else acc.total_out += entry.amount;
    return acc;
  }, { total_in: 0, total_out: 0 });

  return ok(res, {
    account: {
      id: account.id,
      name: account.name,
      type: account.type,
      balance: account.balance
    },
    entries,
    ...totals
  });
}));

router.get("/:id/entries", requireProject, requireRoles("staff"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const account = await prisma.account.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  await ensureOpeningBalanceIncomeBackfill({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    account: { id: account.id, balance: account.balance }
  });

  const transactions = await prisma.accountTransaction.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      accountId: id,
      direction: { in: ["money_in", "money_out", "transfer"] }
    },
    orderBy: { createdAt: "desc" }
  });

  const entries = mapInOutEntries(transactions);
  const totals = entries.reduce((acc, entry) => {
    if (entry.type === "in") acc.total_in += entry.amount;
    else acc.total_out += entry.amount;
    return acc;
  }, { total_in: 0, total_out: 0 });

  return ok(res, {
    account: {
      id: account.id,
      name: account.name,
      type: account.type,
      balance: account.balance
    },
    entries,
    ...totals
  });
}));

export { router as accountsRouter };
