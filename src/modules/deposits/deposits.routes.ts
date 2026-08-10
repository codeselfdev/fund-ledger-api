import { Router } from "express";
import { z } from "zod";
import { DepositStatus, DueStatus, PaymentMethod, Prisma } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { getRoleEmails, notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { sendDecisionEmail } from "../../core/mail/mailer.service.js";
import { canUserPayOnBehalf } from "../../core/security/deposit-delegate.service.js";

const router = Router();

const depositBodySchema = z.object({
  schedule_ids: z.array(z.string().min(1)).min(1),
  member_id: z.string().min(1),
  account_id: z.string().min(1),
  amount: z.number().int().positive(),
  method: z.nativeEnum(PaymentMethod),
  proof_file_id: z.string().optional(),
  reference: z.string().optional(),
  allocate: z.enum(["penalty_first", "principal_first"]).default("penalty_first")
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
  account_id: z.string().min(1).optional()
});

async function canSubmitForMember(auth: {
  roles: string[];
  memberId: string | null;
  userId: string;
  tenantId: string;
  projectId: string;
}, memberId: string) {
  if (auth.roles.includes("admin")) return true;
  if (auth.roles.includes("accountant")) return true;
  if (auth.roles.includes("cashier")) return true;
  if (auth.roles.includes("member") && auth.memberId === memberId) return true;
  if (!auth.roles.includes("member")) return false;

  const tenant = await prisma.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { contact: true }
  });
  if (!tenant) return false;
  return canUserPayOnBehalf(tenant.contact, auth.projectId, auth.userId);
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

function allocatePayment(due: {
  amount: number;
  paidAmount: number;
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
    const outstandingPrincipal = Math.max(0, due.amount - paidAmount);
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

  const status: DueStatus = paidAmount >= due.amount && penaltyPaid >= due.penaltyDue
    ? "paid"
    : paidAmount > 0 || penaltyPaid > 0
      ? "partial"
      : "due";

  return { paidAmount, penaltyPaid, status };
}

async function finalizeDepositConfirmation(input: {
  auth: { tenantId: string; projectId: string; userId: string };
  depositId: string;
  before: {
    id: string;
    amount: number;
    memberId: string;
    accountId: string | null;
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
    (sum, due) => sum + Math.max(0, due.amount + due.penaltyDue - due.paidAmount - due.penaltyPaid),
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

  let remaining = input.before.amount;
  const perDueAllocations = dues.map((due) => {
    const dueOutstanding = Math.max(0, due.amount + due.penaltyDue - due.paidAmount - due.penaltyPaid);
    const appliedToThisDue = Math.min(remaining, dueOutstanding);
    remaining -= appliedToThisDue;
    const allocation = allocatePayment(due, appliedToThisDue, input.before.allocate ?? "penalty_first");
    return { due, appliedToThisDue, allocation };
  });

  const result = await prisma.$transaction(async (tx) => {
    const deposit = await tx.deposit.update({
      where: { id: input.depositId },
      data: {
        status: "confirmed",
        approverById: input.auth.userId,
        confirmedAt: new Date()
      }
    });

    const receipt = await tx.receipt.create({
      data: {
        tenantId: input.auth.tenantId,
        projectId: input.auth.projectId,
        depositId: input.depositId,
        memberId: input.before.memberId,
        receiptNo,
        amount: input.before.amount
      }
    });

    for (const { due, appliedToThisDue, allocation } of perDueAllocations) {
      await tx.due.update({
        where: { id: due.id },
        data: {
          paidAmount: allocation.paidAmount,
          penaltyPaid: allocation.penaltyPaid,
          status: allocation.status
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

    await tx.accountTransaction.create({
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

    return { deposit, receipt };
  });

  return { ...result, receiptNo };
}

async function finalizeAdvanceDepositConfirmation(input: {
  auth: { tenantId: string; projectId: string; userId: string };
  depositId: string;
  before: {
    amount: number;
    memberId: string;
    accountId: string | null;
  };
}) {
  if (!input.before.accountId) {
    throw badRequest("This advance deposit has no account set — ask the accountant to set one before approving");
  }

  const account = await prisma.account.findFirstOrThrow({
    where: { id: input.before.accountId, tenantId: input.auth.tenantId, projectId: input.auth.projectId }
  });
  const receiptNo = `RCT-${Date.now()}-${input.depositId.slice(-4).toUpperCase()}`;

  const result = await prisma.$transaction(async (tx) => {
    const deposit = await tx.deposit.update({
      where: { id: input.depositId },
      data: {
        status: "confirmed",
        approverById: input.auth.userId,
        confirmedAt: new Date()
      }
    });

    const receipt = await tx.receipt.create({
      data: {
        tenantId: input.auth.tenantId,
        projectId: input.auth.projectId,
        depositId: input.depositId,
        memberId: input.before.memberId,
        receiptNo,
        amount: input.before.amount
      }
    });

    const updatedAccount = await tx.account.update({
      where: { id: account.id },
      data: { balance: { increment: input.before.amount } }
    });

    await tx.accountTransaction.create({
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

    return { deposit, receipt };
  });

  return { ...result, receiptNo };
}

router.post("/", requireProject, requireRoles("member", "cashier", "accountant", "admin"), validateBody(depositBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof depositBodySchema>;
  const submittedByAccountant = auth.roles.includes("accountant");
  if (!(await canSubmitForMember(auth, body.member_id))) {
    throw forbidden("You are not allowed to submit deposit for this member");
  }
  if (auth.roles.includes("member") && !body.proof_file_id) {
    throw badRequest("proof_file_id is required for member submissions");
  }

  const scheduleIds = [...new Set(body.schedule_ids)];
  const dues = await prisma.due.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      scheduleId: { in: scheduleIds },
      memberId: body.member_id
    }
  });
  const missing = scheduleIds.filter((scheduleId) => !dues.some((due) => due.scheduleId === scheduleId));
  if (missing.length > 0) {
    throw notFound("Due not found for member and schedule", { missing_schedule_ids: missing });
  }

  const outstanding = dues.reduce(
    (sum, due) => sum + Math.max(0, due.amount + due.penaltyDue - due.paidAmount - due.penaltyPaid),
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
        status: submittedByAccountant ? "pending_approver" : "pending_accountant",
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

  if (submittedByAccountant) {
    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      roles: ["approver"],
      type: "deposit.pending_approver",
      title: "Deposit awaiting final confirmation",
      body: "An accountant submitted and approved a member deposit for final review.",
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
      body: "A member payment was submitted with proof.",
      entityType: "deposit",
      entityId: deposit.id
    });
  }

  return created(res, { id: deposit.id, status: deposit.status });
}));

router.post("/advance", requireProject, requireRoles("member", "cashier", "accountant", "admin"), validateBody(advanceDepositBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof advanceDepositBodySchema>;
  const submittedByAccountant = auth.roles.includes("accountant");
  if (!(await canSubmitForMember(auth, body.member_id))) {
    throw forbidden("You are not allowed to submit deposit for this member");
  }
  if (auth.roles.includes("member") && !body.proof_file_id) {
    throw badRequest("proof_file_id is required for member submissions");
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
      status: submittedByAccountant ? "pending_approver" : "pending_accountant",
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

  if (submittedByAccountant) {
    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      roles: ["approver"],
      type: "deposit.pending_approver",
      title: "Advance deposit awaiting final confirmation",
      body: "An accountant submitted and approved an advance deposit for final review.",
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
  if (before.status !== "pending_accountant") {
    throw badRequest("Deposit can only be removed before accountant review");
  }

  await prisma.deposit.delete({ where: { id } });

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
      ...statusWhere
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

router.post("/:id/approve", requireProject, requireRoles("accountant", "approver", "admin"), validateParams(idParamSchema), validateBody(approveSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof approveSchema>;
  const before = await prisma.deposit.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Deposit not found");
  if (before.status === "pending_accountant") {
    if (!auth.roles.includes("accountant") && !auth.roles.includes("admin")) {
      throw forbidden("Only an accountant or admin can process this approval stage");
    }

    const resolvedAccountId = body.account_id ?? before.accountId;
    if (!resolvedAccountId) throw badRequest("account_id is required before this deposit can be approved");

    const account = await prisma.account.findFirst({
      where: { id: resolvedAccountId, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!account) throw notFound("Account not found");

    const deposit = await prisma.deposit.update({
      where: { id },
      data: {
        status: "pending_approver",
        accountantById: auth.userId,
        accountId: account.id
      }
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
      roles: ["approver"],
      type: "deposit.pending_approver",
      title: "Deposit awaiting final confirmation",
      body: "An accountant approved a deposit for final review.",
      entityType: "deposit",
      entityId: id
    });

    return ok(res, { id: deposit.id, status: deposit.status, accountant_by: deposit.accountantById });
  }

  if (before.status !== "pending_approver") {
    throw badRequest("Only pending deposits can be approved");
  }
  if (!auth.roles.includes("approver") && !auth.roles.includes("admin")) {
    throw forbidden("Only an approver or admin can finalize this deposit");
  }
  if (before.allocate === "advance" && !before.accountantById) {
    throw badRequest("Advance deposit must be approved by an accountant before approver confirmation");
  }

  const result = before.allocate === "advance"
    ? await finalizeAdvanceDepositConfirmation({
      auth,
      depositId: id,
      before
    })
    : await finalizeDepositConfirmation({
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

router.post("/:id/confirm", requireProject, requireRoles("approver", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const before = await prisma.deposit.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Deposit not found");
  if (before.status !== "pending_approver") throw badRequest("Deposit is not in approver queue");
  if (before.allocate === "advance" && !before.accountantById) {
    throw badRequest("Advance deposit must be approved by an accountant before approver confirmation");
  }
  const result = before.allocate === "advance"
    ? await finalizeAdvanceDepositConfirmation({
      auth,
      depositId: id,
      before
    })
    : await finalizeDepositConfirmation({
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
  if (before.status !== "pending_accountant" && before.status !== "pending_approver") {
    throw badRequest("Only pending deposits can be rejected");
  }

  const deposit = await prisma.deposit.update({
    where: { id },
    data: {
      status: "rejected",
      rejectedById: auth.userId,
      rejectReason: body.reason
    }
  });

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
