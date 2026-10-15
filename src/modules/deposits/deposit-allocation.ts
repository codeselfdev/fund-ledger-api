import { createHash } from "node:crypto";
import type { DueStatus } from "@prisma/client";
import { calculateDueBalance } from "../members/member-settlement.service.js";

export function allocatePayment(due: {
  amount: number;
  paidAmount: number;
  waivedAmount: number;
  penaltyDue: number;
  penaltyPaid: number;
}, amount: number, allocate: string) {
  let remaining = amount;
  let penaltyPaid = due.penaltyPaid;
  let paidAmount = due.paidAmount;

  const payPenalty = () => {
    const outstandingPenalty = Math.max(0, due.penaltyDue - penaltyPaid);
    const applied = Math.min(remaining, outstandingPenalty);
    penaltyPaid += applied;
    remaining -= applied;
  };

  const payPrincipal = () => {
    const outstandingPrincipal = Math.max(0, due.amount - paidAmount - due.waivedAmount);
    const applied = Math.min(remaining, outstandingPrincipal);
    paidAmount += applied;
    remaining -= applied;
  };

  if (allocate === "principal_first") {
    payPrincipal();
    payPenalty();
  } else {
    payPenalty();
    payPrincipal();
  }

  const status: DueStatus = paidAmount + due.waivedAmount >= due.amount && penaltyPaid >= due.penaltyDue
    ? "paid"
    : paidAmount > 0 || penaltyPaid > 0
      ? "partial"
      : "due";

  return { paidAmount, penaltyPaid, status };
}

type AllocationDue = {
  id: string;
  scheduleId: string;
  dueDate: Date;
  amount: number;
  paidAmount: number;
  waivedAmount: number;
  penaltyDue: number;
  penaltyPaid: number;
};

/** The preview and final posting must always use the same ordering and fee rules. */
export function planDepositAllocation<T extends AllocationDue>(dues: T[], amount: number, allocate: string) {
  let remaining = amount;
  return [...dues].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.id.localeCompare(b.id)).map(due => {
    const appliedToThisDue = Math.min(remaining, calculateDueBalance(due).total);
    remaining -= appliedToThisDue;
    const allocation = allocatePayment(due, appliedToThisDue, allocate);
    return {
      due, appliedToThisDue, allocation,
      principalAmount: allocation.paidAmount - due.paidAmount,
      penaltyAmount: allocation.penaltyPaid - due.penaltyPaid
    };
  });
}

/** Detect changes after a reviewer has seen the preview, including fee/principal changes. */
export function depositAllocationVersion(depositId: string, amount: number, allocate: string, plan: ReturnType<typeof planDepositAllocation>) {
  return createHash("sha256").update(JSON.stringify({ depositId, amount, allocate, dues: plan.map(row => ({
    id: row.due.id, dueDate: row.due.dueDate.toISOString(), amount: row.due.amount,
    paid: row.due.paidAmount, waived: row.due.waivedAmount, penaltyDue: row.due.penaltyDue,
    penaltyPaid: row.due.penaltyPaid, assigned: row.appliedToThisDue
  })) })).digest("hex");
}
