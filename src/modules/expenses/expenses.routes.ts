import { Router } from "express";
import { z } from "zod";
import { ExpenseCategory, ExpenseStatus } from "@prisma/client";
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

const router = Router();

async function emailExpenseDecision(input: {
  tenantId: string;
  projectId: string;
  createdById: string;
  title: string;
  decision: "approved" | "rejected";
  reason?: string;
}) {
  const creator = await prisma.user.findUnique({ where: { id: input.createdById } });
  if (!creator?.email) return;

  const cc = await getRoleEmails(input.tenantId, input.projectId, ["accountant", "approver"]);
  try {
    await sendDecisionEmail({
      to: creator.email,
      cc,
      subject: input.decision === "approved" ? "Expense approved" : "Expense rejected",
      entityLabel: `Expense "${input.title}"`,
      decision: input.decision,
      reason: input.reason
    });
  } catch (err) {
    console.error("[mailer] failed to send expense decision email", err);
  }
}

const expenseBodySchema = z.object({
  title: z.string().min(2),
  amount: z.number().int().positive(),
  category: z.nativeEnum(ExpenseCategory).optional(),
  category_def_id: z.string().min(1).optional(),
  vendor: z.string().optional(),
  vendor_id: z.string().min(1).optional(),
  account_id: z.string().min(1),
  doc_file_id: z.string().optional()
}).refine((v) => v.category != null || v.category_def_id != null, {
  message: "category or category_def_id is required",
  path: ["category"]
});

const expenseQuerySchema = z.object({
  status: z.nativeEnum(ExpenseStatus).optional()
});

const rejectSchema = z.object({
  reason: z.string().min(3)
});

const disburseSchema = z.object({
  account_id: z.string().min(1).optional()
});

async function getExpenseApprovalFlow(tenantId: string) {
  const progress = await prisma.onboardingProgress.findUnique({
    where: { tenantId },
    select: { expenseApprovalFlow: true }
  });
  return progress?.expenseApprovalFlow ?? "accountant_and_approver";
}

router.post("/", requireProject, requireRoles("accountant"), validateBody(expenseBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof expenseBodySchema>;
  const approvalFlow = await getExpenseApprovalFlow(auth.tenantId);

  let vendorName = body.vendor ?? null;
  if (body.vendor_id) {
    const v = await prisma.vendor.findFirst({
      where: { id: body.vendor_id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!v) throw notFound("Vendor not found");
    vendorName = v.name;
  }

  let categoryEnum: ExpenseCategory = body.category ?? ExpenseCategory.services;
  if (body.category_def_id) {
    const c = await prisma.expenseCategoryDef.findFirst({
      where: { id: body.category_def_id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!c) throw notFound("Category not found");
    // categoryEnum stays as fallback for legacy consumers.
  }

  const account = await prisma.account.findFirst({
    where: { id: body.account_id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");

  const expense = await prisma.expense.create({
    data: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      title: body.title,
      amount: body.amount,
      category: categoryEnum,
      categoryDefId: body.category_def_id,
      vendor: vendorName ?? undefined,
      vendorId: body.vendor_id,
      accountId: account.id,
      docFileId: body.doc_file_id,
      status: "pending",
      createdById: auth.userId
    }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "expense.submitted",
    entityType: "expense",
    entityId: expense.id,
    after: expense
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: approvalFlow === "accountant_only" ? ["accountant", "admin"] : ["approver"],
    type: "expense.submitted",
    title: approvalFlow === "accountant_only" ? "Expense awaiting accountant verification" : "Expense awaiting approval",
    body: approvalFlow === "accountant_only"
      ? `${expense.title} is pending accountant verification.`
      : `${expense.title} is pending approval.`,
    entityType: "expense",
    entityId: expense.id
  });

  return created(res, expense);
}));

router.get("/", requireProject, requireRoles("staff"), validateQuery(expenseQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof expenseQuerySchema>;
  const expenses = await prisma.expense.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.status ? { status: query.status } : {})
    },
    orderBy: { createdAt: "desc" }
  });
  return ok(res, expenses);
}));

router.post("/:id/approve", requireProject, requireRoles("accountant", "approver", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const approvalFlow = await getExpenseApprovalFlow(auth.tenantId);
  const before = await prisma.expense.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Expense not found");
  if (approvalFlow === "accountant_only") {
    if (!auth.roles.includes("accountant") && !auth.roles.includes("admin")) {
      throw forbidden("Only an accountant can verify this expense in the current approval flow");
    }
  } else if (!auth.roles.includes("approver") && !auth.roles.includes("admin")) {
    throw forbidden("Only an approver can verify this expense in the current approval flow");
  }
  if (before.status !== "pending") throw badRequest("Expense is not pending");
  if (!before.accountId) throw badRequest("account_id is required before this expense can be approved");
  const account = await prisma.account.findFirst({
    where: { id: before.accountId, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");
  if (account.balance < before.amount) throw badRequest("Source account has insufficient balance");

  const expense = await prisma.$transaction(async (tx) => {
    const paidExpense = await tx.expense.update({
      where: { id },
      data: {
        status: "paid",
        approvedById: auth.userId,
        paidAccountId: account.id,
        disbursedById: auth.userId,
        paidAt: new Date()
      }
    });

    const updatedAccount = await tx.account.update({
      where: { id: account.id },
      data: { balance: { decrement: before.amount } }
    });

    await tx.accountTransaction.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        direction: "money_out",
        amount: before.amount,
        referenceType: "expense",
        referenceId: id,
        description: before.title,
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    });

    return paidExpense;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "expense.disbursed",
    entityType: "expense",
    entityId: id,
    before,
    after: expense
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: ["accountant", "auditor"],
    type: "expense.disbursed",
    title: "Expense paid",
    body: `${expense.title} was disbursed on approval.`,
    entityType: "expense",
    entityId: id
  });

  await emailExpenseDecision({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    createdById: before.createdById,
    title: expense.title,
    decision: "approved"
  });

  return ok(res, expense);
}));

router.post("/:id/reject", requireProject, requireRoles("accountant", "approver", "admin"), validateParams(idParamSchema), validateBody(rejectSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof rejectSchema>;
  const approvalFlow = await getExpenseApprovalFlow(auth.tenantId);
  const before = await prisma.expense.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Expense not found");
  if (approvalFlow === "accountant_only") {
    if (!auth.roles.includes("accountant") && !auth.roles.includes("admin")) {
      throw forbidden("Only an accountant can reject this expense in the current approval flow");
    }
  } else if (!auth.roles.includes("approver") && !auth.roles.includes("admin")) {
    throw forbidden("Only an approver can reject this expense in the current approval flow");
  }
  if (before.status !== "pending") throw badRequest("Only pending expenses can be rejected");

  const expense = await prisma.expense.update({
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
    action: "expense.rejected",
    entityType: "expense",
    entityId: id,
    before,
    after: expense
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: ["accountant"],
    type: "expense.rejected",
    title: "Expense rejected",
    body: body.reason,
    entityType: "expense",
    entityId: id
  });

  await emailExpenseDecision({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    createdById: before.createdById,
    title: expense.title,
    decision: "rejected",
    reason: body.reason
  });

  return ok(res, expense);
}));

router.post("/:id/disburse", requireProject, requireRoles("accountant"), validateParams(idParamSchema), validateBody(disburseSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof disburseSchema>;

  const before = await prisma.expense.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
  if (!before) throw notFound("Expense not found");
  if (before.status !== "approved") throw badRequest("Expense is not approved");

  const sourceAccountId = body.account_id ?? before.accountId;
  if (!sourceAccountId) throw badRequest("account_id is required (expense has no target account set)");

  const account = await prisma.account.findFirst({
    where: { id: sourceAccountId, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");
  if (account.balance < before.amount) throw badRequest("Source account has insufficient balance");

  const expense = await prisma.$transaction(async (tx) => {
    const paidExpense = await tx.expense.update({
      where: { id },
      data: {
        status: "paid",
        paidAccountId: account.id,
        disbursedById: auth.userId,
        paidAt: new Date()
      }
    });

    const updatedAccount = await tx.account.update({
      where: { id: account.id },
      data: { balance: { decrement: before.amount } }
    });

    await tx.accountTransaction.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        direction: "money_out",
        amount: before.amount,
        referenceType: "expense",
        referenceId: id,
        description: before.title,
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    });

    return paidExpense;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "expense.disbursed",
    entityType: "expense",
    entityId: id,
    before,
    after: expense
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: ["approver", "auditor"],
    type: "expense.disbursed",
    title: "Expense paid",
    body: `${expense.title} was disbursed.`,
    entityType: "expense",
    entityId: id
  });

  return ok(res, expense);
}));

export { router as expensesRouter };
