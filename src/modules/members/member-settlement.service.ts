import { Prisma, type Deposit, type Due } from "@prisma/client";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { prisma } from "../../core/prisma/client.js";

type DueBalanceSource = Pick<Due, "amount" | "paidAmount" | "waivedAmount" | "penaltyDue" | "penaltyPaid">;
type AdvanceSource = Pick<Deposit, "amount" | "refundedAmount"> & {
  allocations: Array<{ amount: number }>;
};
type SettlementClient = Pick<Prisma.TransactionClient, "member" | "due" | "deposit" | "projectMembership">;

const pendingDepositStatuses = ["submitted", "pending_accountant", "pending_approver"] as const;

export function calculateDueBalance(due: DueBalanceSource) {
  const principal = Math.max(0, due.amount - due.paidAmount - due.waivedAmount);
  const penalty = Math.max(0, due.penaltyDue - due.penaltyPaid);
  return { principal, penalty, total: principal + penalty };
}

export function calculateUnusedAdvance(deposit: AdvanceSource) {
  const allocated = deposit.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
  return Math.max(0, deposit.amount - allocated - deposit.refundedAmount);
}

async function readMemberSettlement(db: SettlementClient, tenantId: string, projectId: string, memberId: string) {
  const member = await db.member.findFirst({
    where: { id: memberId, tenantId, projectId }
  });
  if (!member) throw notFound("Member not found");

  const [dues, advances, pendingDeposits] = await Promise.all([
    db.due.findMany({
      where: { tenantId, projectId, memberId },
      select: {
        id: true,
        amount: true,
        paidAmount: true,
        waivedAmount: true,
        penaltyDue: true,
        penaltyPaid: true,
        status: true
      }
    }),
    db.deposit.findMany({
      where: { tenantId, projectId, memberId, status: "confirmed", allocate: "advance" },
      select: {
        id: true,
        amount: true,
        refundedAmount: true,
        accountId: true,
        allocations: { select: { amount: true } }
      }
    }),
    db.deposit.findMany({
      where: { tenantId, projectId, memberId, status: { in: [...pendingDepositStatuses] } },
      select: { id: true, amount: true, status: true, allocate: true }
    })
  ]);

  const dueBalance = dues.reduce((totals, due) => {
    const balance = calculateDueBalance(due);
    totals.principal += balance.principal;
    totals.penalty += balance.penalty;
    totals.total += balance.total;
    if (balance.total > 0) totals.count += 1;
    return totals;
  }, { principal: 0, penalty: 0, total: 0, count: 0 });

  const advanceCredit = advances.reduce((sum, advance) => sum + calculateUnusedAdvance(advance), 0);
  const pendingAmount = pendingDeposits.reduce((sum, deposit) => sum + deposit.amount, 0);
  const blockers = [
    ...(dueBalance.total > 0 ? ["outstanding_due"] : []),
    ...(advanceCredit > 0 ? ["unused_advance"] : []),
    ...(pendingDeposits.length > 0 ? ["pending_deposits"] : [])
  ];

  return {
    member: {
      id: member.id,
      name: member.name,
      mobile: member.mobile,
      status: member.status,
      shares: member.shares
    },
    outstanding_due: dueBalance,
    unused_advance: advanceCredit,
    pending_deposits: {
      count: pendingDeposits.length,
      amount: pendingAmount,
      items: pendingDeposits
    },
    net_balance: dueBalance.total - advanceCredit,
    can_exit: blockers.length === 0,
    blockers
  };
}

export async function getMemberSettlement(tenantId: string, projectId: string, memberId: string) {
  return readMemberSettlement(prisma, tenantId, projectId, memberId);
}

export async function assertMemberCanExit(
  tenantId: string,
  projectId: string,
  memberId: string,
  db: SettlementClient = prisma
) {
  const settlement = await readMemberSettlement(db, tenantId, projectId, memberId);
  if (!settlement.can_exit) {
    throw conflict("Member balance must be zero and pending deposits must be resolved before removal or transfer", {
      settlement
    });
  }
  return settlement;
}

export async function assertNoActiveManagementRoles(
  tenantId: string,
  projectId: string,
  memberId: string,
  db: SettlementClient = prisma
) {
  const roles = await db.projectMembership.findMany({
    where: {
      tenantId,
      projectId,
      memberId,
      isActive: true,
      role: { not: "member" }
    },
    select: { id: true, role: true }
  });
  if (roles.length > 0) {
    throw conflict("Reassign or deactivate the member's management roles before removal or transfer", {
      active_roles: roles
    });
  }
}

export async function settleMemberBalance(input: {
  tenantId: string;
  projectId: string;
  memberId: string;
  actorUserId: string;
  reason: string;
  applyAdvanceToDues: boolean;
  writeOffRemainingDues: boolean;
  refundRemainingAdvance: boolean;
}) {
  const result = await prisma.$transaction(async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: input.memberId, tenantId: input.tenantId, projectId: input.projectId }
    });
    if (!member) throw notFound("Member not found");

    const pendingCount = await tx.deposit.count({
      where: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        memberId: input.memberId,
        status: { in: [...pendingDepositStatuses] }
      }
    });
    if (pendingCount > 0) {
      throw conflict("Resolve pending deposits before adjusting this member's balance", {
        pending_deposits: pendingCount
      });
    }

    let appliedAdvance = 0;
    let writtenOffPrincipal = 0;
    let writtenOffPenalty = 0;
    const advanceApplications: Array<{
      deposit_id: string;
      due_id: string;
      amount: number;
      principal_amount: number;
      penalty_amount: number;
    }> = [];
    const writeOffs: Array<{
      due_id: string;
      principal_amount: number;
      penalty_amount: number;
    }> = [];
    const refunds: Array<{
      deposit_id: string;
      account_id: string;
      transaction_id: string;
      amount: number;
    }> = [];
    const refundTransactions: Array<{
      transaction: Awaited<ReturnType<typeof tx.accountTransaction.create>>;
      balanceBefore: number;
    }> = [];

    if (input.applyAdvanceToDues) {
      const dues = await tx.due.findMany({
        where: { tenantId: input.tenantId, projectId: input.projectId, memberId: input.memberId },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }]
      });
      const advances = await tx.deposit.findMany({
        where: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          memberId: input.memberId,
          status: "confirmed",
          allocate: "advance"
        },
        include: { allocations: { select: { amount: true } } },
        orderBy: { createdAt: "asc" }
      });

      for (const advance of advances) {
        let available = calculateUnusedAdvance(advance);
        if (available <= 0) continue;

        for (const due of dues) {
          if (available <= 0) break;
          const balance = calculateDueBalance(due);
          if (balance.total <= 0) continue;

          const applied = Math.min(available, balance.total);
          const penaltyApplied = Math.min(applied, balance.penalty);
          const principalApplied = applied - penaltyApplied;
          due.penaltyPaid += penaltyApplied;
          due.paidAmount += principalApplied;
          available -= applied;
          appliedAdvance += applied;

          const afterBalance = calculateDueBalance(due);
          await tx.due.update({
            where: { id: due.id },
            data: {
              penaltyPaid: due.penaltyPaid,
              paidAmount: due.paidAmount,
              status: afterBalance.total === 0 ? "paid" : "partial"
            }
          });
          await tx.depositAllocation.upsert({
            where: { depositId_dueId: { depositId: advance.id, dueId: due.id } },
            update: { amount: { increment: applied } },
            create: {
              tenantId: input.tenantId,
              projectId: input.projectId,
              depositId: advance.id,
              dueId: due.id,
              scheduleId: due.scheduleId,
              amount: applied
            }
          });
          advanceApplications.push({
            deposit_id: advance.id,
            due_id: due.id,
            amount: applied,
            principal_amount: principalApplied,
            penalty_amount: penaltyApplied
          });
        }
      }
    }

    if (input.writeOffRemainingDues) {
      const dues = await tx.due.findMany({
        where: { tenantId: input.tenantId, projectId: input.projectId, memberId: input.memberId }
      });
      for (const due of dues) {
        const balance = calculateDueBalance(due);
        if (balance.total <= 0) continue;
        writtenOffPrincipal += balance.principal;
        writtenOffPenalty += balance.penalty;

        await tx.duePenaltyEntry.updateMany({
          where: { dueId: due.id, waivedAt: null },
          data: { waivedAt: new Date(), waivedById: input.actorUserId, reason: input.reason }
        });
        await tx.due.update({
          where: { id: due.id },
          data: {
            waivedAmount: { increment: balance.principal },
            penaltyDue: due.penaltyPaid,
            status: "waived"
          }
        });
        writeOffs.push({
          due_id: due.id,
          principal_amount: balance.principal,
          penalty_amount: balance.penalty
        });
      }
    }

    let refundedAdvance = 0;
    if (input.refundRemainingAdvance) {
      const advances = await tx.deposit.findMany({
        where: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          memberId: input.memberId,
          status: "confirmed",
          allocate: "advance"
        },
        include: { allocations: { select: { amount: true } } },
        orderBy: { createdAt: "asc" }
      });
      const refundsByAccount = new Map<string, number>();
      for (const advance of advances) {
        const amount = calculateUnusedAdvance(advance);
        if (amount <= 0) continue;
        if (!advance.accountId) throw badRequest("A confirmed advance has no account and cannot be refunded");
        refundsByAccount.set(advance.accountId, (refundsByAccount.get(advance.accountId) ?? 0) + amount);
      }

      const accounts = await tx.account.findMany({
        where: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          id: { in: [...refundsByAccount.keys()] }
        }
      });
      for (const [accountId, amount] of refundsByAccount) {
        const account = accounts.find((item) => item.id === accountId);
        if (!account) throw notFound("Advance account not found", { account_id: accountId });
        if (account.balance < amount) {
          throw badRequest("Advance account has insufficient balance for refund", {
            account_id: accountId,
            available: account.balance,
            required: amount
          });
        }
      }

      const runningBalances = new Map(accounts.map((account) => [account.id, account.balance]));
      for (const advance of advances) {
        const amount = calculateUnusedAdvance(advance);
        if (amount <= 0 || !advance.accountId) continue;
        const balanceBefore = runningBalances.get(advance.accountId);
        if (balanceBefore === undefined) throw notFound("Advance account not found");

        const account = await tx.account.update({
          where: { id: advance.accountId },
          data: { balance: { decrement: amount } }
        });
        const transaction = await tx.accountTransaction.create({
          data: {
            tenantId: input.tenantId,
            projectId: input.projectId,
            accountId: advance.accountId,
            direction: "money_out",
            amount,
            referenceType: "advance_refund",
            referenceId: advance.id,
            description: `Advance refund for ${member.name}: ${input.reason}`,
            balanceAfter: account.balance,
            createdById: input.actorUserId
          }
        });
        await tx.deposit.update({
          where: { id: advance.id },
          data: { refundedAmount: { increment: amount } }
        });
        refundedAdvance += amount;
        runningBalances.set(advance.accountId, account.balance);
        refundTransactions.push({ transaction, balanceBefore });
        refunds.push({
          deposit_id: advance.id,
          account_id: advance.accountId,
          transaction_id: transaction.id,
          amount
        });
      }
    }

    return {
      member,
      applied_advance: appliedAdvance,
      written_off_principal: writtenOffPrincipal,
      written_off_penalty: writtenOffPenalty,
      refunded_advance: refundedAdvance,
      advance_applications: advanceApplications,
      write_offs: writeOffs,
      refunds,
      refundTransactions
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  return result;
}
