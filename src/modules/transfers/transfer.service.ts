import { badRequest, notFound } from "../../core/http/api-error.js";
import { prisma } from "../../core/prisma/client.js";
import { writeAccountTransactionAudit, writeAudit } from "../../core/audit/audit.service.js";

export type CreateAccountTransferInput = {
  tenantId: string;
  projectId: string;
  actorUserId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  note?: string;
};

export async function createAccountTransfer(input: CreateAccountTransferInput) {
  if (input.fromAccountId === input.toAccountId) {
    throw badRequest("Source and destination accounts must be different");
  }

  const accounts = await prisma.account.findMany({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      id: { in: [input.fromAccountId, input.toAccountId] }
    }
  });
  const from = accounts.find((account) => account.id === input.fromAccountId);
  const to = accounts.find((account) => account.id === input.toAccountId);
  if (!from || !to) throw notFound("Both accounts must exist in the active project");
  if (from.balance < input.amount) throw badRequest("Source account has insufficient balance");

  const result = await prisma.$transaction(async (tx) => {
    const record = await tx.transfer.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        fromAccountId: from.id,
        toAccountId: to.id,
        amount: input.amount,
        note: input.note,
        createdById: input.actorUserId
      }
    });

    const debit = await tx.account.updateMany({
      where: { id: from.id, balance: { gte: input.amount } },
      data: { balance: { decrement: input.amount } }
    });
    if (debit.count !== 1) throw badRequest("Source account has insufficient balance");

    const updatedFrom = await tx.account.findUniqueOrThrow({ where: { id: from.id } });
    const updatedTo = await tx.account.update({
      where: { id: to.id },
      data: { balance: { increment: input.amount } }
    });

    const fromTransaction = await tx.accountTransaction.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        accountId: from.id,
        direction: "transfer",
        amount: input.amount,
        referenceType: "transfer",
        referenceId: record.id,
        description: input.note ?? `Transfer to ${to.name}`,
        balanceAfter: updatedFrom.balance,
        createdById: input.actorUserId
      }
    });

    const toTransaction = await tx.accountTransaction.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        accountId: to.id,
        direction: "transfer",
        amount: input.amount,
        referenceType: "transfer",
        referenceId: record.id,
        description: input.note ?? `Transfer from ${from.name}`,
        balanceAfter: updatedTo.balance,
        createdById: input.actorUserId
      }
    });

    return { record, updatedFrom, updatedTo, fromTransaction, toTransaction };
  });

  await writeAudit({
    tenantId: input.tenantId,
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    action: "transfer.created",
    entityType: "transfer",
    entityId: result.record.id,
    before: {
      from_account: { id: from.id, balance: from.balance },
      to_account: { id: to.id, balance: to.balance }
    },
    after: result.record
  });

  await writeAccountTransactionAudit({
    tenantId: input.tenantId,
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    transaction: result.fromTransaction,
    balanceBefore: from.balance
  });

  await writeAccountTransactionAudit({
    tenantId: input.tenantId,
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    transaction: result.toTransaction,
    balanceBefore: to.balance
  });

  return {
    ...result.record,
    from_account: {
      id: from.id,
      name: from.name,
      balance_before: from.balance,
      balance_after: result.updatedFrom.balance
    },
    to_account: {
      id: to.id,
      name: to.name,
      balance_before: to.balance,
      balance_after: result.updatedTo.balance
    },
    transaction_ids: [result.fromTransaction.id, result.toTransaction.id]
  };
}
