import { Router } from "express";
import { z } from "zod";
import { DepositStatus, PaymentMethod, Prisma } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { writeAccountTransactionAudit, writeAudit } from "../../core/audit/audit.service.js";
import { getRoleEmails, notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { sendDecisionEmail } from "../../core/mail/mailer.service.js";
import { canUserPayOnBehalf } from "../../core/security/deposit-delegate.service.js";
import { calculateDueBalance } from "../members/member-settlement.service.js";
import { sendWhatsAppGroupMessage } from "../../core/whatsapp/whatsapp.service.js";
import { resolveCommitmentsForDeposit } from "../follow-ups/followups.service.js";

import { projectDepositRoute } from "../../core/projects/project-settings.js";

import { planDepositAllocation, depositAllocationVersion } from "./deposit-allocation.js";

import { depositReview } from "./deposit-allocation-review.js";

const router = Router();
const MEMBER_RECEIPT_REQUIRED_MESSAGE = "Please upload a receipt before submitting this payment";

async function announceConfirmedPayment(input: {
  tenantId: string;
  projectId: string;
  actorUserId: string;
  memberId: string;
  amount: number;
  receiptId: string;
}) {
  const member = await prisma.member.findFirst({
    where: { id: input.memberId, tenantId: input.tenantId, projectId: input.projectId },
    select: { name: true }
  });
  const message = `${member?.name ?? "A member"} payment of BDT ${input.amount.toLocaleString("en-US")} was approved and posted.`;
  try {
    await notifyProjectMembers({
      tenantId: input.tenantId,
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      type: "payment.posted",
      title: "Payment posted",
      body: message,
      entityType: "receipt",
      entityId: input.receiptId
    });
  } catch (error) {
    console.error("[notifications] failed to announce posted payment", error);
  }
  await sendWhatsAppGroupMessage({ tenantId: input.tenantId, projectId: input.projectId, message });
}

const depositBodySchema = z.object({
  schedule_ids: z.array(z.string().min(1)).min(1).optional(),
  settle_all_dues: z.boolean().default(false),
  member_id: z.string().min(1),
  account_id: z.string().min(1),
  amount: z.number().int().positive(),
  method: z.nativeEnum(PaymentMethod),
  proof_file_id: z.string().optional(),
  reference: z.string().optional(),
  allocate: z.enum(["penalty_first", "principal_first"]).default("penalty_first")
}).superRefine((value, ctx) => {
  if (!value.settle_all_dues && !value.schedule_ids?.length) {
    ctx.addIssue({ code: "custom", path: ["schedule_ids"], message: "Select schedules or request settlement of all member dues" });
  }
  if (value.settle_all_dues && value.schedule_ids !== undefined) {
    ctx.addIssue({ code: "custom", path: ["schedule_ids"], message: "Choose either selected schedules or all member dues" });
  }
});

const advanceDepositBodySchema = z.object({
  member_id: z.string().min(1),
  account_id: z.string().min(1),
  amount: z.number().int().positive(),
  method: z.nativeEnum(PaymentMethod),
  proof_file_id: z.string().optional(),
  reference: z.string().optional()
});

const depositQuerySchema = z.object({
  status: z.nativeEnum(DepositStatus).optional()
});

const rejectSchema = z.object({
  reason: z.string().min(3)
});

const approveSchema = z.object({
  allocation_version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  account_id: z.string().min(1).optional()
});

const allocationPreviewQuerySchema = z.object({ scope: z.enum(["selected", "member_dues"]).default("selected") });
const resolutionBase = { source_version: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(3).max(500) };
const resolveAllocationSchema = z.discriminatedUnion("action", [
  z.object({ ...resolutionBase, action: z.literal("reassign"), allocation_version: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ ...resolutionBase, action: z.literal("advance") }).strict()
]);

async function lockReviewedDeposit(tx: Prisma.TransactionClient, input: {
  auth: { tenantId: string; projectId: string }; depositId: string;
  before: { status: DepositStatus; amount: number; allocate: string | null; memberId: string; accountId: string | null };
}) {
  await tx.$queryRaw`SELECT id FROM deposits WHERE id = ${input.depositId} AND tenant_id = ${input.auth.tenantId} AND project_id = ${input.auth.projectId} FOR UPDATE`;
  const current = await tx.deposit.findFirst({ where: { id: input.depositId, tenantId: input.auth.tenantId, projectId: input.auth.projectId } });
  if (!current || current.status !== input.before.status || current.amount !== input.before.amount || current.allocate !== input.before.allocate || current.memberId !== input.before.memberId || current.accountId !== input.before.accountId) {
    throw conflict("This payment changed or was already reviewed. Refresh the list before approving.");
  }
  return current;
}

async function canSubmitForMember(auth: {
  memberIds?: string[];
  roles: string[];
  memberId: string | null;
  userId: string;
  tenantId: string;
  projectId: string;
}, memberId: string) {
  if (auth.roles.includes("admin") || auth.roles.includes("owner")) return true;
  if (auth.roles.includes("accountant")) return true;
  if (auth.roles.includes("cashier")) return true;
  if (auth.roles.includes("member") && (auth.memberId === memberId || auth.memberIds?.includes(memberId))) return true;
  if (!auth.roles.includes("member")) return false;

  const beneficiary = await prisma.member.findFirst({
    where: { id: memberId, tenantId: auth.tenantId, projectId: auth.projectId, status: "active" },
    select: { id: true }
  });
  if (!beneficiary) return false;

  const tenant = await prisma.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { contact: true }
  });
  if (!tenant) return false;
  return canUserPayOnBehalf(tenant.contact, auth.projectId, auth.userId, memberId);
}

async function emailDepositDecision(input: {
  tenantId: string;
  projectId: string;
  memberId: string;
  decision: "approved" | "rejected";
  reason?: string;
}) {
  const member = await prisma.member.findUnique({ where: { id: input.memberId } });
  if (!member?.email) return;

  const cc = await getRoleEmails(input.tenantId, input.projectId, ["accountant", "approver"]);
  try {
    await sendDecisionEmail({
      to: member.email,
      cc,
      subject: input.decision === "approved" ? "Your payment was confirmed" : "Your payment was rejected",
      entityLabel: "Your payment",
      decision: input.decision,
      reason: input.reason
    });
  } catch (err) {
    console.error("[mailer] failed to send deposit decision email", err);
  }
}

async function finalizeDepositConfirmation(input: {
  auth: { tenantId: string; projectId: string; userId: string };
  depositId: string;
  allocationVersion?: string;
  before: {
    id: string;
    amount: number;
    memberId: string;
    accountId: string | null;
    status: DepositStatus;
    allocate: string | null;
  };
}) {
  if (!input.before.accountId) {
    throw badRequest("This deposit has no account set — ask the accountant to set one before approving");
  }

  const allocations = await prisma.depositAllocation.findMany({
    where: { depositId: input.depositId },
    include: { due: true }
  });
  if (allocations.length === 0) throw badRequest("Deposit has no due allocations");

  const dues = allocations.map((allocation) => allocation.due).sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime()
  );

  const freshOutstanding = dues.reduce(
    (sum, due) => sum + calculateDueBalance(due).total,
    0
  );
  if (input.before.amount > freshOutstanding) {
    throw badRequest("Outstanding balance across the selected schedules has changed since submission", {
      outstanding: freshOutstanding
    });
  }

  const account = await prisma.account.findFirstOrThrow({
    where: { id: input.before.accountId, tenantId: input.auth.tenantId, projectId: input.auth.projectId }
  });
  const receiptNo = `RCT-${Date.now()}-${input.depositId.slice(-4).toUpperCase()}`;

  const perDueAllocations = planDepositAllocation(dues, input.before.amount, input.before.allocate ?? "penalty_first");
  if (input.allocationVersion && input.allocationVersion !== depositAllocationVersion(input.depositId, input.before.amount, input.before.allocate ?? "penalty_first", perDueAllocations)) {
    throw badRequest("Schedule amounts changed since review. Reload the breakdown before confirming.");
  }

  const result = await prisma.$transaction(async (tx) => {
    await lockReviewedDeposit(tx, input);
    // Lock dues in a stable order so another confirmation cannot change the
    // reviewed amounts between validation and posting.
    await tx.$queryRaw`SELECT id FROM dues
      WHERE tenant_id = ${input.auth.tenantId} AND project_id = ${input.auth.projectId}
        AND id IN (${Prisma.join(dues.map(due => due.id).sort())})
      ORDER BY id FOR UPDATE`;
    const lockedAllocations = await tx.depositAllocation.findMany({
      where: { depositId: input.depositId }, include: { due: true }
    });
    const lockedPlan = planDepositAllocation(lockedAllocations.map(row => row.due), input.before.amount, input.before.allocate ?? "penalty_first");
    const reviewedVersion = input.allocationVersion ?? depositAllocationVersion(input.depositId, input.before.amount, input.before.allocate ?? "penalty_first", perDueAllocations);
    if (reviewedVersion !== depositAllocationVersion(input.depositId, input.before.amount, input.before.allocate ?? "penalty_first", lockedPlan)) {
      throw badRequest("Schedule amounts changed since review. Reload the breakdown before confirming.");
    }

    const claimed = await tx.deposit.updateMany({
      where: { id: input.depositId, tenantId: input.auth.tenantId, projectId: input.auth.projectId, status: input.before.status },
      data: { status: "confirmed", approverById: input.auth.userId, confirmedAt: new Date() }
    });
    if (claimed.count !== 1) throw badRequest("Deposit was already reviewed. Refresh the list.");
    const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: input.depositId } });

    const receipt = await tx.receipt.create({
      data: {
        tenantId: input.auth.tenantId,
        projectId: input.auth.projectId,
        depositId: input.depositId,
        memberId: input.before.memberId,
        receiptNo,
        amount: input.before.amount,
        method: deposit.method
      }
    });

    for (const { due, appliedToThisDue, allocation } of lockedPlan) {
      await tx.due.update({
        where: { id: due.id },
        data: {
          paidAmount: allocation.paidAmount,
          penaltyPaid: allocation.penaltyPaid,
          status: allocation.status,
          // Submission time is the member-controlled payment time; approval delay must not count as late.
          paidAt: allocation.status === "paid" ? (due.paidAt ?? deposit.createdAt) : due.paidAt
        }
      });

      await tx.depositAllocation.updateMany({
        where: { depositId: input.depositId, dueId: due.id },
        data: { amount: appliedToThisDue }
      });
    }

    const updatedAccount = await tx.account.update({
      where: { id: account.id },
      data: { balance: { increment: input.before.amount } }
    });

    const accountTransaction = await tx.accountTransaction.create({
      data: {
        tenantId: input.auth.tenantId,
        projectId: input.auth.projectId,
        accountId: account.id,
        direction: "money_in",
        amount: input.before.amount,
        referenceType: "deposit",
        referenceId: input.depositId,
        description: `Deposit receipt ${receiptNo}`,
        balanceAfter: updatedAccount.balance,
        createdById: input.auth.userId
      }
    });

    const resolvedCommitment = await resolveCommitmentsForDeposit(tx, deposit, input.auth.userId);

    return { deposit, receipt, accountTransaction, resolvedCommitment };
  });

  return { ...result, receiptNo, accountBalanceBefore: account.balance };
}

async function finalizeAdvanceDepositConfirmation(input: {
  auth: { tenantId: string; projectId: string; userId: string };
  depositId: string;
  allocationVersion?: string;
  before: {
    amount: number;
    allocate: string | null;
    memberId: string;
    accountId: string | null;
    status: DepositStatus;
  };
}) {
  if (input.allocationVersion && input.allocationVersion !== depositAllocationVersion(input.depositId, input.before.amount, "advance", [])) {
    throw badRequest("The advance amount changed since review. Reload before confirming.");
  }
  if (!input.before.accountId) {
    throw badRequest("This advance deposit has no account set — ask the accountant to set one before approving");
  }

  const account = await prisma.account.findFirstOrThrow({
    where: { id: input.before.accountId, tenantId: input.auth.tenantId, projectId: input.auth.projectId }
  });
  const receiptNo = `RCT-${Date.now()}-${input.depositId.slice(-4).toUpperCase()}`;

  const result = await prisma.$transaction(async (tx) => {
    await lockReviewedDeposit(tx, input);
    const claimed = await tx.deposit.updateMany({
      where: { id: input.depositId, tenantId: input.auth.tenantId, projectId: input.auth.projectId, status: input.before.status },
      data: { status: "confirmed", approverById: input.auth.userId, confirmedAt: new Date() }
    });
    if (claimed.count !== 1) throw badRequest("Deposit was already reviewed. Refresh the list.");
    const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: input.depositId } });

    const receipt = await tx.receipt.create({
      data: {
        tenantId: input.auth.tenantId,
        projectId: input.auth.projectId,
        depositId: input.depositId,
        memberId: input.before.memberId,
        receiptNo,
        amount: input.before.amount,
        method: deposit.method
      }
    });

    const updatedAccount = await tx.account.update({
      where: { id: account.id },
      data: { balance: { increment: input.before.amount } }
    });

    const accountTransaction = await tx.accountTransaction.create({
      data: {
        tenantId: input.auth.tenantId,
        projectId: input.auth.projectId,
        accountId: account.id,
        direction: "money_in",
        amount: input.before.amount,
        referenceType: "deposit",
        referenceId: input.depositId,
        description: `Advance deposit receipt ${receiptNo}`,
        balanceAfter: updatedAccount.balance,
        createdById: input.auth.userId
      }
    });

    const resolvedCommitment = await resolveCommitmentsForDeposit(tx, deposit, input.auth.userId);

    return { deposit, receipt, accountTransaction, resolvedCommitment };
  });

  return { ...result, receiptNo, accountBalanceBefore: account.balance };
}

router.post("/", requireProject, requireRoles("member", "cashier", "accountant", "admin"), validateBody(depositBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof depositBodySchema>;
  const approvalRoute = await projectDepositRoute(auth.tenantId, auth.projectId);
  const submittedByAccountant = approvalRoute === "accountant" && auth.roles.includes("accountant");
  if (!(await canSubmitForMember(auth, body.member_id))) {
    throw forbidden("You are not allowed to submit deposit for this member");
  }
  if (auth.roles.includes("member") && !body.proof_file_id) {
    throw badRequest(MEMBER_RECEIPT_REQUIRED_MESSAGE);
  }

  const scheduleIds = [...new Set(body.schedule_ids ?? [])];
  // Imported previous installments are hidden from the schedule browser, but are
  // real member dues. Resolve member-level payments from the ledger itself.
  const memberDues = await prisma.due.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(body.settle_all_dues ? {} : { scheduleId: { in: scheduleIds } }),
      memberId: body.member_id
    }
  });
  const dues = body.settle_all_dues ? memberDues.filter(due => calculateDueBalance(due).total > 0) : memberDues;
  const missing = scheduleIds.filter((scheduleId) => !dues.some((due) => due.scheduleId === scheduleId));
  if (missing.length > 0) {
    throw notFound("Due not found for member and schedule", { missing_schedule_ids: missing });
  }

  const outstanding = dues.reduce(
    (sum, due) => sum + calculateDueBalance(due).total,
    0
  );
  if (body.amount > outstanding) {
    throw badRequest("Deposit amount cannot exceed outstanding balance across the selected schedules", { outstanding });
  }

  const account = await prisma.account.findFirst({
    where: { id: body.account_id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  const deposit = await prisma.$transaction(async (tx) => {
    const createdDeposit = await tx.deposit.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        scheduleId: dues.length === 1 ? dues[0].scheduleId : null,
        memberId: body.member_id,
        accountId: account.id,
        amount: body.amount,
        method: body.method,
        proofFileId: body.proof_file_id,
        reference: body.reference,
        allocate: body.allocate,
        status: approvalRoute === "admin" || submittedByAccountant ? "pending_approver" : "pending_accountant",
        approvalRoute,
        submittedById: auth.userId,
        accountantById: submittedByAccountant ? auth.userId : undefined
      }
    });

    await tx.depositAllocation.createMany({
      data: dues.map((due) => ({
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        depositId: createdDeposit.id,
        dueId: due.id,
        scheduleId: due.scheduleId
      }))
    });

    return createdDeposit;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: submittedByAccountant ? "deposit.approved_by_accountant" : "deposit.submitted",
    entityType: "deposit",
    entityId: deposit.id,
    after: deposit
  });

  if (approvalRoute === "admin" || submittedByAccountant) {
    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      roles: approvalRoute === "admin" ? ["owner", "admin"] : ["approver", "owner", "admin"],
      type: "deposit.pending_approver",
      title: "Deposit awaiting final confirmation",
      body: approvalRoute === "admin" ? "A member deposit is awaiting admin approval." : "An accountant submitted and approved a member deposit for final review.",
      entityType: "deposit",
      entityId: deposit.id
    });
  } else {
    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      roles: ["accountant"],
      type: "deposit.submitted",
      title: "Deposit awaiting accountant review",
      body: "A member payment was submitted with a receipt.",
      entityType: "deposit",
      entityId: deposit.id
    });
  }

  return created(res, { id: deposit.id, status: deposit.status });
}));

router.post("/advance", requireProject, requireRoles("member", "cashier", "accountant", "admin"), validateBody(advanceDepositBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof advanceDepositBodySchema>;
  const approvalRoute = await projectDepositRoute(auth.tenantId, auth.projectId);
  const submittedByAccountant = approvalRoute === "accountant" && auth.roles.includes("accountant");
  if (!(await canSubmitForMember(auth, body.member_id))) {
    throw forbidden("You are not allowed to submit deposit for this member");
  }
  if (auth.roles.includes("member") && !body.proof_file_id) {
    throw badRequest(MEMBER_RECEIPT_REQUIRED_MESSAGE);
  }

  const account = await prisma.account.findFirst({
    where: { id: body.account_id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  const deposit = await prisma.deposit.create({
    data: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      scheduleId: null,
      memberId: body.member_id,
      accountId: account.id,
      amount: body.amount,
      method: body.method,
      proofFileId: body.proof_file_id,
      reference: body.reference,
      allocate: "advance",
      status: approvalRoute === "admin" || submittedByAccountant ? "pending_approver" : "pending_accountant",
      approvalRoute,
      submittedById: auth.userId,
      accountantById: submittedByAccountant ? auth.userId : undefined
    }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: submittedByAccountant ? "deposit.approved_by_accountant" : "deposit.advance_submitted",
    entityType: "deposit",
    entityId: deposit.id,
    after: deposit
  });

  if (approvalRoute === "admin" || submittedByAccountant) {
    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      roles: approvalRoute === "admin" ? ["owner", "admin"] : ["approver", "owner", "admin"],
      type: "deposit.pending_approver",
      title: "Advance deposit awaiting final confirmation",
      body: approvalRoute === "admin" ? "An advance deposit is awaiting admin approval." : "An accountant submitted and approved an advance deposit for final review.",
      entityType: "deposit",
      entityId: deposit.id
    });
  } else {
    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      roles: ["accountant"],
      type: "deposit.submitted",
      title: "Advance deposit awaiting accountant review",
      body: "A member submitted an advance payment.",
      entityType: "deposit",
      entityId: deposit.id
    });
  }

  return created(res, { id: deposit.id, status: deposit.status, kind: "advance" });
}));

router.delete("/:id", requireProject, requireRoles("member", "cashier"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const before = await prisma.deposit.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Deposit not found");
  if (before.submittedById !== auth.userId) throw forbidden("You may only remove your own deposit submissions");
  const removableStatuses: DepositStatus[] = ["submitted", "pending_accountant", "pending_approver"];
  if (!removableStatuses.includes(before.status)) {
    throw badRequest("Only payments awaiting final approval can be removed");
  }

  // Compete with confirmation's conditional update on the same deposit row.
  // If posting wins, this delete cannot remove its receipt or account history.
  const removed = await prisma.deposit.deleteMany({
    where: {
      id, tenantId: auth.tenantId, projectId: auth.projectId,
      submittedById: auth.userId, status: { in: removableStatuses }
    }
  });
  if (removed.count !== 1) throw badRequest("Payment was already reviewed or removed. Refresh the list.");

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "deposit.cancelled",
    entityType: "deposit",
    entityId: id,
    before
  });

  return ok(res, { id, removed: true });
}));

router.get("/", requireProject, requireRoles("staff"), validateQuery(depositQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof depositQuerySchema>;
  const isAccountant = auth.roles.includes("accountant");
  const isApprover = auth.roles.includes("approver");
  const isOversight = auth.roles.includes("admin") || auth.roles.includes("auditor");

  if (query.status === "pending_accountant" && !isAccountant && !isOversight) {
    throw forbidden("Only accountants can access accountant queue items");
  }
  if (query.status === "pending_approver" && !isApprover && !isOversight) {
    throw forbidden("Only approvers can access approver queue items");
  }

  let statusWhere: Prisma.DepositWhereInput;
  if (query.status) {
    statusWhere = { status: query.status };
  } else if (isOversight) {
    statusWhere = { status: { not: "rejected" as DepositStatus } };
  } else if (isAccountant && isApprover) {
    statusWhere = { status: { in: ["pending_accountant", "pending_approver"] as DepositStatus[] } };
  } else if (isAccountant) {
    statusWhere = { status: "pending_accountant" as DepositStatus };
  } else if (isApprover) {
    statusWhere = { status: "pending_approver" as DepositStatus };
  } else {
    statusWhere = { status: { not: "rejected" as DepositStatus } };
  }

  const deposits = await prisma.deposit.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...statusWhere,
      ...(!isOversight ? { approvalRoute: "accountant" as const } : {})
    },
    include: {
      member: true,
      schedule: true,
      receipt: true,
      account: true,
      allocations: { include: { schedule: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, deposits);
}));

router.get("/:id/allocation-preview", requireProject, requireRoles("staff"), validateParams(idParamSchema), validateQuery(allocationPreviewQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const deposit = await prisma.deposit.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!deposit) throw notFound("Deposit not found");
  if (deposit.status !== "pending_accountant" && deposit.status !== "pending_approver") {
    throw badRequest("This payment is no longer awaiting approval. Refresh the list.");
  }
  const oversight = auth.roles.some(role => ["owner", "admin", "auditor"].includes(role));
  if (!oversight && deposit.approvalRoute === "admin") throw forbidden("This payment is in the admin approval queue");
  if (!oversight && !(deposit.status === "pending_accountant" && auth.roles.includes("accountant")) &&
      !(deposit.status === "pending_approver" && auth.roles.includes("approver"))) throw forbidden("This payment is in another approval queue");

  const { scope } = req.query as z.infer<typeof allocationPreviewQuerySchema>;
  if (scope === "member_dues" && !auth.roles.some(role => ["owner", "admin"].includes(role))) throw forbidden("Only an admin can reassign payment dues");
  return ok(res, await depositReview(prisma, deposit, scope));
}));

router.post("/:id/resolve-allocation", requireProject, requireRoles("admin"), validateParams(idParamSchema), validateBody(resolveAllocationSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof resolveAllocationSchema>;
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM deposits WHERE id = ${id} AND tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} FOR UPDATE`;
    const before = await tx.deposit.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
    if (!before) throw notFound("Deposit not found");
    if (!["pending_accountant", "pending_approver"].includes(before.status) || before.allocate === "advance") {
      throw conflict("This payment is no longer awaiting allocation review. Refresh the list.");
    }
    await tx.$queryRaw`SELECT id FROM dues WHERE tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} AND member_id = ${before.memberId} ORDER BY id FOR UPDATE`;
    const current = await depositReview(tx, before);
    if (current.allocation_version !== body.source_version) throw conflict("The payment breakdown changed. Refresh it and review the resolution again.");
    if (current.can_confirm) throw conflict("This payment can already be assigned in full. Review its latest breakdown before approving.");
    const candidate = body.action === "reassign" ? await depositReview(tx, before, "member_dues") : null;
    if (candidate && body.action === "reassign" && candidate.allocation_version !== body.allocation_version) throw conflict("The other unpaid dues changed. Review the updated amounts before reassigning.");
    if (candidate && !candidate.can_confirm) throw badRequest("The member does not have enough unpaid dues for this payment. No allocation was changed.");
    const oldAllocations = await tx.depositAllocation.findMany({ where: { depositId: id, tenantId: auth.tenantId, projectId: auth.projectId } });
    const items = candidate?.items.filter(item => item.amount > 0) ?? [];
    // Any change invalidates the earlier accountant endorsement. It never posts money.
    const status = before.approvalRoute === "accountant" ? "pending_accountant" as const : "pending_approver" as const;
    const updated = await tx.deposit.updateMany({
      where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: before.status },
      data: { allocate: body.action === "advance" ? "advance" : before.allocate,
        scheduleId: items.length === 1 ? items[0].schedule_id : null,
        status, accountantById: null, approverById: null }
    });
    if (updated.count !== 1) throw conflict("This payment was already reviewed. Refresh the list.");
    await tx.depositAllocation.deleteMany({ where: { depositId: id, tenantId: auth.tenantId, projectId: auth.projectId } });
    if (items.length) await tx.depositAllocation.createMany({ data: items.map(item => ({
      tenantId: auth.tenantId, projectId: auth.projectId, depositId: id,
      dueId: item.due_id, scheduleId: item.schedule_id, amount: 0
    })) });
    await tx.activity.create({ data: {
      tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId,
      action: "deposit.allocation_resolved", entityType: "deposit", entityId: id,
      before: JSON.parse(JSON.stringify({ deposit: before, allocations: oldAllocations })),
      after: { action: body.action, reason: body.reason, status, allocate: body.action === "advance" ? "advance" : before.allocate,
        assigned_dues: items.map(item => ({ due_id: item.due_id, amount: item.amount })),
        advance_amount: body.action === "advance" ? before.amount : 0 }
    } });
    return { id, status, allocate: body.action === "advance" ? "advance" : before.allocate };
  });
  return ok(res, result);
}));


router.post("/:id/approve", requireProject, requireRoles("accountant", "approver", "admin"), validateParams(idParamSchema), validateBody(approveSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof approveSchema>;
  const before = await prisma.deposit.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Deposit not found");
  const admin = auth.roles.includes("admin") || auth.roles.includes("owner");
  const directAdmin = before.approvalRoute === "admin" || (before.status === "pending_accountant" && await projectDepositRoute(auth.tenantId, auth.projectId) === "admin");
  if (directAdmin && !admin) throw forbidden("Only an admin can approve this deposit");

  if (before.status === "pending_accountant" && !directAdmin) {
    if (!auth.roles.includes("accountant") && !admin) {
      throw forbidden("Only an accountant or admin can process this approval stage");
    }

    const deposit = await prisma.$transaction(async tx => {
      const current = await lockReviewedDeposit(tx, { auth, depositId: id, before });
      await tx.$queryRaw`SELECT id FROM dues WHERE tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} AND member_id = ${current.memberId} ORDER BY id FOR UPDATE`;
      const review = await depositReview(tx, current);
      if (body.allocation_version && body.allocation_version !== review.allocation_version) throw badRequest("Schedule amounts changed since review. Reload the breakdown before approving.");
      if (!review.can_confirm) throw badRequest("The dues have changed. Resolve this payment's allocation before approving.");
      const resolvedAccountId = body.account_id ?? current.accountId;
      if (!resolvedAccountId) throw badRequest("account_id is required before this deposit can be approved");
      const account = await tx.account.findFirst({ where: { id: resolvedAccountId, tenantId: auth.tenantId, projectId: auth.projectId } });
      if (!account) throw notFound("Account not found");
      const claimed = await tx.deposit.updateMany({
        where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: "pending_accountant" },
        data: { status: "pending_approver", accountantById: auth.userId, accountId: account.id }
      });
      if (claimed.count !== 1) throw badRequest("Deposit was already reviewed. Refresh the list.");
      return tx.deposit.findUniqueOrThrow({ where: { id } });
    });

    await writeAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      action: "deposit.approved_by_accountant",
      entityType: "deposit",
      entityId: id,
      before,
      after: deposit
    });

    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      roles: ["approver", "owner", "admin"],
      type: "deposit.pending_approver",
      title: "Deposit awaiting final confirmation",
      body: "An accountant approved a deposit for final review.",
      entityType: "deposit",
      entityId: id
    });

    return ok(res, { id: deposit.id, status: deposit.status, accountant_by: deposit.accountantById });
  }

  if (before.status !== "pending_approver" && !(directAdmin && before.status === "pending_accountant")) {
    throw badRequest("Only pending deposits can be approved");
  }
  if (!auth.roles.includes("approver") && !admin) {
    throw forbidden("Only an approver or admin can finalize this deposit");
  }
  if (before.allocate === "advance" && !before.accountantById && !directAdmin) {
    throw badRequest("Advance deposit must be approved by an accountant before approver confirmation");
  }

  const result = before.allocate === "advance"
    ? await finalizeAdvanceDepositConfirmation({
      allocationVersion: body.allocation_version,
      auth,
      depositId: id,
      before
    })
    : await finalizeDepositConfirmation({
      allocationVersion: body.allocation_version,
      auth,
      depositId: id,
      before
    });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "deposit.confirmed",
    entityType: "deposit",
    entityId: id,
    before,
    after: result
  });

  await writeAccountTransactionAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    transaction: result.accountTransaction,
    balanceBefore: result.accountBalanceBefore
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    memberIds: [before.memberId],
    type: "deposit.confirmed",
    title: "Deposit confirmed",
    body: `Receipt ${result.receiptNo} was issued for your payment.`,
    entityType: "receipt",
    entityId: result.receipt.id
  });
  await announceConfirmedPayment({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    memberId: before.memberId,
    amount: result.receipt.amount,
    receiptId: result.receipt.id
  });

  await emailDepositDecision({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    memberId: before.memberId,
    decision: "approved"
  });

  return ok(res, {
    id: result.deposit.id,
    status: result.deposit.status,
    receipt_id: result.receipt.id,
    receipt_no: result.receipt.receiptNo
  });
}));

router.post("/:id/confirm", requireProject, requireRoles("approver", "admin"), validateParams(idParamSchema), validateBody(approveSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof approveSchema>;
  const before = await prisma.deposit.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Deposit not found");
  const admin = auth.roles.includes("admin") || auth.roles.includes("owner");
  const directAdmin = before.approvalRoute === "admin" || (before.status === "pending_accountant" && await projectDepositRoute(auth.tenantId, auth.projectId) === "admin");
  if (directAdmin && !admin) throw forbidden("Only an admin can approve this deposit");

  if (before.status !== "pending_approver" && !(directAdmin && before.status === "pending_accountant")) throw badRequest("Deposit is not in approver queue");
  if (before.allocate === "advance" && !before.accountantById && !directAdmin) {
    throw badRequest("Advance deposit must be approved by an accountant before approver confirmation");
  }
  const result = before.allocate === "advance"
    ? await finalizeAdvanceDepositConfirmation({
      allocationVersion: body.allocation_version,
      auth,
      depositId: id,
      before
    })
    : await finalizeDepositConfirmation({
      allocationVersion: body.allocation_version,
      auth,
      depositId: id,
      before
    });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "deposit.confirmed",
    entityType: "deposit",
    entityId: id,
    before,
    after: result
  });

  await writeAccountTransactionAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    transaction: result.accountTransaction,
    balanceBefore: result.accountBalanceBefore
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    memberIds: [before.memberId],
    type: "deposit.confirmed",
    title: "Deposit confirmed",
    body: `Receipt ${result.receiptNo} was issued for your payment.`,
    entityType: "receipt",
    entityId: result.receipt.id
  });
  await announceConfirmedPayment({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    memberId: before.memberId,
    amount: result.receipt.amount,
    receiptId: result.receipt.id
  });

  await emailDepositDecision({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    memberId: before.memberId,
    decision: "approved"
  });

  return ok(res, {
    id: result.deposit.id,
    status: result.deposit.status,
    receipt_id: result.receipt.id,
    receipt_no: result.receipt.receiptNo
  });
}));

router.post("/:id/reject", requireProject, requireRoles("accountant", "approver", "admin"), validateParams(idParamSchema), validateBody(rejectSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof rejectSchema>;
  const before = await prisma.deposit.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Deposit not found");
  if (before.approvalRoute === "admin" && !auth.roles.includes("admin") && !auth.roles.includes("owner")) throw forbidden("Only an admin can reject this deposit");
  if (before.status !== "pending_accountant" && before.status !== "pending_approver") {
    throw badRequest("Only pending deposits can be rejected");
  }

  const claimed = await prisma.deposit.updateMany({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: before.status },
    data: { status: "rejected", rejectedById: auth.userId, rejectReason: body.reason }
  });
  if (claimed.count !== 1) throw conflict("This payment was already reviewed. Refresh the list.");
  const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id } });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "deposit.rejected",
    entityType: "deposit",
    entityId: id,
    before,
    after: deposit
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    memberIds: [before.memberId],
    type: "deposit.rejected",
    title: "Deposit rejected",
    body: body.reason,
    entityType: "deposit",
    entityId: id
  });

  await emailDepositDecision({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    memberId: before.memberId,
    decision: "rejected",
    reason: body.reason
  });

  return ok(res, { id: deposit.id, status: deposit.status });
}));

export { router as depositsRouter };
