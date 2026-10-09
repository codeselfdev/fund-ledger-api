import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCommitmentsForDeposit } from "./followups.service.js";

function fixture(input: { promised: string; submitted: string; paid: number; outstanding?: number }) {
  const commitment = {
    id: "commitment",
    tenantId: "tenant",
    projectId: "project",
    memberId: "member",
    callLogId: null,
    amount: 100,
    promisedDate: new Date(`${input.promised}T00:00:00.000Z`),
    summary: "Will pay",
    status: "pending",
    outstandingAtCreate: 100,
    supersededById: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedDepositId: null,
    resolveReason: null,
    createdById: "admin",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z")
  } as const;
  let updated: Record<string, unknown> | null = null;
  const tx = {
    paymentCommitment: {
      findFirst: async ({ where }: { where: { status: string } }) => where.status === "pending" ? commitment : null,
      update: async ({ data }: { data: Record<string, unknown> }) => { updated = data; return { ...commitment, ...data }; }
    },
    deposit: { findMany: async () => [{ amount: input.paid, refundedAmount: 0 }] },
    due: { findMany: async () => input.outstanding === 0 ? [] : [{ amount: input.outstanding ?? 100, paidAmount: 0, waivedAmount: 0, penaltyDue: 0, penaltyPaid: 0 }] },
    activity: { create: async () => ({}) }
  };
  const deposit = { id: "deposit", tenantId: "tenant", projectId: "project", memberId: "member", createdAt: new Date(input.submitted) };
  return { tx, deposit, updated: () => updated };
}

test("a sufficient deposit submitted by the promise date is kept even when approved later", async () => {
  const item = fixture({ promised: "2026-10-10", submitted: "2026-10-10T17:30:00.000Z", paid: 100 });
  await resolveCommitmentsForDeposit(item.tx as never, item.deposit, "approver");
  assert.equal(item.updated()?.status, "kept");
});

test("a sufficient deposit submitted after the promise date is kept late", async () => {
  const item = fixture({ promised: "2026-10-10", submitted: "2026-10-10T18:30:00.000Z", paid: 100 });
  await resolveCommitmentsForDeposit(item.tx as never, item.deposit, "approver");
  assert.equal(item.updated()?.status, "kept_late");
});

test("a partial deposit leaves the commitment open", async () => {
  const item = fixture({ promised: "2026-10-10", submitted: "2026-10-10T10:00:00.000Z", paid: 40, outstanding: 60 });
  const resolved = await resolveCommitmentsForDeposit(item.tx as never, item.deposit, "approver");
  assert.equal(resolved, null);
  assert.equal(item.updated(), null);
});
