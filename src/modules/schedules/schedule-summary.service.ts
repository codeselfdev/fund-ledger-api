import { prisma } from "../../core/prisma/client.js";

type Balance = {
  amount: number;
  paidAmount: number;
  waivedAmount: number;
  penaltyDue: number;
  penaltyPaid: number;
};
export function dueRemaining(due: Balance) {
  return (
    Math.max(0, due.amount - due.paidAmount - due.waivedAmount) +
    Math.max(0, due.penaltyDue - due.penaltyPaid)
  );
}

type PendingDue = Balance & {
  id: string;
  memberId: string;
  scheduleId: string;
  dueDate: Date;
};
type PendingDeposit = {
  id: string;
  memberId: string;
  scheduleId: string | null;
  amount: number;
  createdAt: Date;
  allocations: { due: PendingDue }[];
};

// Pending allocation amounts are zero until confirmation. Forecast the same
// oldest-due-first distribution, reserving each due once across pending deposits.
export function pendingByDue(deposits: PendingDeposit[], dues: PendingDue[]) {
  const pending = new Map<string, { amount: number; depositIds: string[] }>();
  for (const deposit of [...deposits].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  )) {
    let remaining = deposit.amount;
    const targets = deposit.allocations.length
      ? deposit.allocations.map((a) => a.due)
      : dues.filter(
          (d) =>
            d.scheduleId === deposit.scheduleId &&
            d.memberId === deposit.memberId,
        );
    const seen = new Set<string>();
    for (const due of [...targets].sort(
      (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
    )) {
      if (due.memberId !== deposit.memberId || seen.has(due.id)) continue;
      seen.add(due.id);
      const current = pending.get(due.id) ?? { amount: 0, depositIds: [] };
      const amount = Math.min(
        remaining,
        Math.max(0, dueRemaining(due) - current.amount),
      );
      if (amount > 0)
        pending.set(due.id, {
          amount: current.amount + amount,
          depositIds: [...current.depositIds, deposit.id],
        });
      remaining -= amount;
      if (remaining <= 0) break;
    }
  }
  return pending;
}

export function summarizeSchedule(dues: Balance[], pending: number) {
  const total = dues.reduce(
    (n, d) => n + Math.max(0, d.amount - d.waivedAmount) + d.penaltyDue,
    0,
  );
  const collected = dues.reduce((n, d) => n + d.paidAmount + d.penaltyPaid, 0);
  const remaining = dues.reduce((n, d) => n + dueRemaining(d), 0);
  return {
    total,
    collected,
    remaining,
    pending: Math.min(remaining, pending),
    waived: dues.reduce((n, d) => n + d.waivedAmount, 0),
    paid_count: dues.filter((d) => dueRemaining(d) === 0).length,
    dues_count: dues.length,
    collected_percent: total
      ? Math.min(100, Math.round((collected / total) * 100))
      : 0,
  };
}

export async function scheduleCollectionData(
  tenantId: string,
  projectId: string,
) {
  const scope = { tenantId, projectId };
  const [dues, deposits] = await Promise.all([
    prisma.due.findMany({ where: scope }),
    prisma.deposit.findMany({
      where: {
        ...scope,
        status: { in: ["pending_accountant", "pending_approver"] },
      },
      include: { allocations: { where: scope, include: { due: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const scopedDeposits = deposits.map((d) => ({
    ...d,
    allocations: d.allocations.filter(
      (a) => a.due.tenantId === tenantId && a.due.projectId === projectId,
    ),
  }));
  return { dues, pending: pendingByDue(scopedDeposits, dues) };
}
