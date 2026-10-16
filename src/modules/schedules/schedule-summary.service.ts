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

type OpeningDue = Balance & { id: string; memberId: string };
export interface OpeningBalance {
  original_due: number;
  historical_paid: number;
  recovered: number;
  as_of_date?: string;
}
/** Imported paid history stays in the ledger, but is not money to collect again. */
export function openingDueView<T extends OpeningDue>(due: T, profile: unknown) {
  const entry = (profile as {
    opening_import?: { previous_paid?: unknown; as_of_date?: unknown };
  } | null)?.opening_import;
  const imported = entry?.previous_paid;
  const historicalPaid =
    typeof imported === "number" && Number.isSafeInteger(imported) && imported >= 0
      ? Math.min(imported, due.amount, due.paidAmount)
      : 0;
  const adjusted = {
    ...due,
    amount: due.amount - historicalPaid,
    paidAmount: due.paidAmount - historicalPaid,
  };
  return {
    due: adjusted,
    opening_balance: {
      original_due: adjusted.amount,
      historical_paid: historicalPaid,
      recovered: adjusted.paidAmount + adjusted.penaltyPaid,
      ...(typeof entry?.as_of_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.as_of_date)
        ? { as_of_date: entry.as_of_date }
        : {}),
    },
  };
}

export function openingScheduleView<T extends OpeningDue>(
  dues: T[],
  members: { id: string; profile: unknown }[],
  pending: Map<string, { amount: number }>,
) {
  const profiles = new Map(members.map(member => [member.id, member.profile]));
  const all = dues.map(due => openingDueView(due, profiles.get(due.memberId)));
  // Keep original debtors after settlement, but exclude shareholders who never owed.
  const rows = all.filter(row => row.due.amount > 0 || row.due.penaltyDue > 0 || dueRemaining(row.due) > 0);
  const pendingAmount = rows.reduce((sum, row) => sum + (pending.get(row.due.id)?.amount ?? 0), 0);
  return {
    rows,
    collection: summarizeSchedule(rows.map(row => row.due), pendingAmount),
    opening_balance: {
      original_due: rows.reduce((sum, row) => sum + row.opening_balance.original_due, 0),
      historical_paid: all.reduce((sum, row) => sum + row.opening_balance.historical_paid, 0),
      recovered: rows.reduce((sum, row) => sum + row.opening_balance.recovered, 0),
      as_of_date: all.find(row => row.opening_balance.as_of_date)?.opening_balance.as_of_date,
    },
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
