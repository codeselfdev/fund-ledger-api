import type { Deposit, Prisma } from "@prisma/client";
import { badRequest } from "../../core/http/api-error.js";
import { calculateDueBalance } from "../members/member-settlement.service.js";
import { depositAllocationVersion, planDepositAllocation } from "./deposit-allocation.js";

type ReviewClient = Pick<Prisma.TransactionClient, "due" | "depositAllocation">;
type Payment = Pick<Deposit, "id" | "tenantId" | "projectId" | "memberId" | "amount" | "allocate">;
export type ReviewScope = "selected" | "member_dues";

export async function depositReview(db: ReviewClient, deposit: Payment, scope: ReviewScope = "selected") {
  const priority = deposit.allocate ?? "penalty_first";
  if (priority === "advance") {
    if (scope !== "selected") throw badRequest("This payment is already an advance deposit");
    return {
      deposit_id: deposit.id, amount: deposit.amount, kind: "advance" as const, allocate: priority, scope,
      allocation_version: depositAllocationVersion(deposit.id, deposit.amount, priority, []),
      total_allocated: 0, unallocated_amount: 0, advance_amount: deposit.amount,
      can_confirm: true, reason: null, items: []
    };
  }
  const dues = scope === "member_dues"
    ? (await db.due.findMany({
      where: { tenantId: deposit.tenantId, projectId: deposit.projectId, memberId: deposit.memberId },
      include: { schedule: true }
    })).filter(due => calculateDueBalance(due).total > 0)
    : (await db.depositAllocation.findMany({
      where: { depositId: deposit.id, tenantId: deposit.tenantId, projectId: deposit.projectId },
      include: { due: { include: { schedule: true } } }
    })).map(row => row.due);
  if (dues.some(due => due.tenantId !== deposit.tenantId || due.projectId !== deposit.projectId || due.memberId !== deposit.memberId)) {
    throw badRequest("A linked due does not belong to this payment's member and project");
  }
  const plan = planDepositAllocation(dues, deposit.amount, priority);
  const total = plan.reduce((sum, row) => sum + row.appliedToThisDue, 0);
  const unallocated = Math.max(0, deposit.amount - total);
  return {
    deposit_id: deposit.id, amount: deposit.amount, kind: "dues" as const, allocate: priority, scope,
    // An alternative preview can never be passed directly to final confirmation.
    allocation_version: depositAllocationVersion(scope === "selected" ? deposit.id : `${deposit.id}:member_dues`, deposit.amount, priority, plan),
    total_allocated: total, unallocated_amount: unallocated, advance_amount: 0,
    can_confirm: plan.length > 0 && unallocated === 0,
    reason: unallocated === 0 && plan.length > 0 ? null : total === 0
      ? "The selected dues are already settled or no longer available. Check whether this is a duplicate submission or a separate payment received."
      : "The dues have changed since submission. Part of this payment cannot be assigned. Review it before approval.",
    items: plan.map(row => ({
      due_id: row.due.id, schedule_id: row.due.scheduleId,
      schedule_name: row.due.schedule.name, due_date: row.due.dueDate.toISOString(),
      amount: row.appliedToThisDue, principal_amount: row.principalAmount, penalty_amount: row.penaltyAmount,
      outstanding_before: calculateDueBalance(row.due).total,
      outstanding_after: Math.max(0, calculateDueBalance(row.due).total - row.appliedToThisDue)
    }))
  };
}
