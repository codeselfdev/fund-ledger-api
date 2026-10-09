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
import { writeAccountTransactionAudit, writeAudit } from "../../core/audit/audit.service.js";
import { getRoleEmails, notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { sendDecisionEmail } from "../../core/mail/mailer.service.js";
import { sendWhatsAppGroupMessage } from "../../core/whatsapp/whatsapp.service.js";

import { expenseBodySchema, toExpenseDate } from "./expense-input.js";

const router = Router();

async function announcePaidExpense(input: {
  tenantId: string;
  projectId: string;
  actorUserId: string;
  expense: { id: string; title: string; amount: number; category: ExpenseCategory; categoryDefId: string | null };
}) {
  const category = input.expense.categoryDefId
    ? await prisma.expenseCategoryDef.findFirst({
        where: { id: input.expense.categoryDefId, tenantId: input.tenantId, projectId: input.projectId },
        select: { name: true }
      })
    : null;
  const expenseHead = category?.name ?? input.expense.category.charAt(0).toUpperCase() + input.expense.category.slice(1);
  const message = `Expense posted: ${input.expense.title}. Amount: BDT ${input.expense.amount.toLocaleString("en-US")}. Head: ${expenseHead}.`;
  try {
    await notifyProjectMembers({
      tenantId: input.tenantId,
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      type: "expense.posted",
      title: "Expense posted",
      body: message,
      entityType: "expense",
      entityId: input.expense.id
    });
  } catch (error) {
    console.error("[notifications] failed to announce posted expense", error);
  }
  await sendWhatsAppGroupMessage({ tenantId: input.tenantId, projectId: input.projectId, message });
}

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

router.post("/", requireProject, validateBody(expenseBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof expenseBodySchema>;
  const approvalFlow = await getExpenseApprovalFlow(auth.tenantId);

  let vendorName = body.vendor ?? null;
  let vendorPhone = body.vendor_phone ?? null;
  if (body.vendor_id) {
    const v = await prisma.vendor.findFirst({
      where: { id: body.vendor_id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!v) throw notFound("Vendor not found");
    vendorName = v.name;
    vendorPhone = body.vendor_phone !== undefined ? body.vendor_phone : v.phone;
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

  const isOwnerOrAdmin = auth.roles.includes("owner") || auth.roles.includes("admin");
  const isAccountant = !isOwnerOrAdmin && auth.roles.includes("accountant");
  const status: ExpenseStatus = isOwnerOrAdmin ? "paid" : isAccountant ? "approved" : "pending";

  const result = await prisma.$transaction(async (tx) => {
    let updatedAccount = null;
    if (isOwnerOrAdmin) {
      const debit = await tx.account.updateMany({
        where: { id: account.id, tenantId: auth.tenantId, projectId: auth.projectId, balance: { gte: body.amount } },
        data: { balance: { decrement: body.amount } }
      });
      if (debit.count !== 1) throw badRequest("Source account has insufficient balance");
      updatedAccount = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
    }
    const expense = await tx.expense.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        title: body.title,
        amount: body.amount,
        category: categoryEnum,
        categoryDefId: body.category_def_id,
        vendor: vendorName ?? undefined,
        vendorId: body.vendor_id,
        vendorPhone,
        expenseDate: toExpenseDate(body.expense_date),
        accountId: account.id,
        docFileId: body.doc_file_id,
        status,
        createdById: auth.userId,
        approvedById: status === "pending" ? null : auth.userId,
        ...(isOwnerOrAdmin ? { disbursedById: auth.userId, paidAccountId: account.id, paidAt: new Date() } : {})
      }
    });
    const accountTransaction = updatedAccount ? await tx.accountTransaction.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        accountId: account.id,
        direction: "money_out",
        amount: body.amount,
        referenceType: "expense",
        referenceId: expense.id,
        description: expense.title,
        balanceAfter: updatedAccount.balance,
        createdById: auth.userId
      }
    }) : null;
    return { expense, accountTransaction, balanceBefore: updatedAccount ? updatedAccount.balance + body.amount : null };
  });
  const { expense } = result;

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: isOwnerOrAdmin ? "expense.posted" : isAccountant ? "expense.approved" : "expense.submitted",
    entityType: "expense",
    entityId: expense.id,
    after: expense
  });

  if (result.accountTransaction) {
    await writeAccountTransactionAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      transaction: result.accountTransaction,
      balanceBefore: result.balanceBefore ?? account.balance
    });
  }

  if (isOwnerOrAdmin) {
    await announcePaidExpense({ tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, expense });
  } else if (isAccountant) {
    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      roles: ["owner", "admin"],
      type: "expense.approved",
      title: "Expense ready for disbursement",
      body: `${expense.title} was posted by an accountant and is ready for admin disbursement.`,
      entityType: "expense",
      entityId: expense.id
    });
  } else {
    // Regular accountant flow - send for approval
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
  }

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
    orderBy: [{ expenseDate: "desc" }, { createdAt: "desc" }]
  });
  return ok(res, expenses);
}));

router.get("/by-category", requireProject, requireRoles("owner", "staff"), validateQuery(expenseQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof expenseQuerySchema>;
  const expenses = await prisma.expense.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.status ? { status: query.status } : {})
    },
    include: { categoryDef: { select: { id: true, name: true } } },
    orderBy: [{ expenseDate: "desc" }, { paidAt: "desc" }, { createdAt: "desc" }]
  });

  const grouped = new Map<string, {
    category_id: string | null;
    category_key: string;
    category_name: string;
    total_amount: number;
    expense_count: number;
    items: Array<typeof expenses[number] & { occurred_at: Date }>;
  }>();
  for (const expense of expenses) {
    const categoryKey = expense.categoryDef?.id ?? expense.category;
    const categoryName = expense.categoryDef?.name
      ?? expense.category.charAt(0).toUpperCase() + expense.category.slice(1);
    const group = grouped.get(categoryKey) ?? {
      category_id: expense.categoryDef?.id ?? null,
      category_key: categoryKey,
      category_name: categoryName,
      total_amount: 0,
      expense_count: 0,
      items: []
    };
    group.total_amount += expense.amount;
    group.expense_count += 1;
    group.items.push({ ...expense, occurred_at: expense.expenseDate ?? expense.paidAt ?? expense.createdAt });
    grouped.set(categoryKey, group);
  }

  return ok(res, Array.from(grouped.values()).sort((a, b) => b.total_amount - a.total_amount));
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

  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.expense.updateMany({
      where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: "pending" },
      data: { status: "paid" }
    });
    if (claim.count !== 1) throw badRequest("Expense is no longer pending");
    const debit = await tx.account.updateMany({
      where: { id: account.id, tenantId: auth.tenantId, projectId: auth.projectId, balance: { gte: before.amount } },
      data: { balance: { decrement: before.amount } }
    });
    if (debit.count !== 1) throw badRequest("Source account has insufficient balance");
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

    const updatedAccount = await tx.account.findUniqueOrThrow({ where: { id: account.id } });

    const accountTransaction = await tx.accountTransaction.create({
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

    return { expense: paidExpense, accountTransaction };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "expense.approved",
    entityType: "expense",
    entityId: id,
    before,
    after: result.expense
  });

  await writeAccountTransactionAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    transaction: result.accountTransaction,
    balanceBefore: result.accountTransaction.balanceAfter + before.amount
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: ["accountant", "auditor"],
    type: "expense.disbursed",
    title: "Expense paid",
    body: `${result.expense.title} was disbursed on approval.`,
    entityType: "expense",
    entityId: id
  });
  await announcePaidExpense({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    expense: result.expense
  });

  await emailExpenseDecision({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    createdById: before.createdById,
    title: result.expense.title,
    decision: "approved"
  });

  return ok(res, result.expense);
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

router.post("/:id/disburse", requireProject, requireRoles("accountant", "admin", "owner"), validateParams(idParamSchema), validateBody(disburseSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof disburseSchema>;

  const before = await prisma.expense.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
  if (!before) throw notFound("Expense not found");
  if (before.status !== "approved") throw badRequest("Expense is not approved");
  if (before.approvedById === before.createdById && !auth.roles.includes("admin") && !auth.roles.includes("owner")) {
    throw forbidden("Only an admin can disburse an accountant-posted expense");
  }

  const sourceAccountId = body.account_id ?? before.accountId;
  if (!sourceAccountId) throw badRequest("account_id is required (expense has no target account set)");

  const account = await prisma.account.findFirst({
    where: { id: sourceAccountId, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!account) throw notFound("Account not found");
  if (account.balance < before.amount) throw badRequest("Source account has insufficient balance");

  const result = await prisma.$transaction(async (tx) => {
    const claim = await tx.expense.updateMany({
      where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: "approved" },
      data: { status: "paid" }
    });
    if (claim.count !== 1) throw badRequest("Expense has already been disbursed");
    const debit = await tx.account.updateMany({
      where: { id: account.id, tenantId: auth.tenantId, projectId: auth.projectId, balance: { gte: before.amount } },
      data: { balance: { decrement: before.amount } }
    });
    if (debit.count !== 1) throw badRequest("Source account has insufficient balance");
    const paidExpense = await tx.expense.update({
      where: { id },
      data: {
        status: "paid",
        paidAccountId: account.id,
        disbursedById: auth.userId,
        paidAt: new Date()
      }
    });

    const updatedAccount = await tx.account.findUniqueOrThrow({ where: { id: account.id } });

    const accountTransaction = await tx.accountTransaction.create({
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

    return { expense: paidExpense, accountTransaction };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "expense.disbursed",
    entityType: "expense",
    entityId: id,
    before,
    after: result.expense
  });

  await writeAccountTransactionAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    transaction: result.accountTransaction,
    balanceBefore: result.accountTransaction.balanceAfter + before.amount
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: ["approver", "auditor"],
    type: "expense.disbursed",
    title: "Expense paid",
    body: `${result.expense.title} was disbursed.`,
    entityType: "expense",
    entityId: id
  });
  await announcePaidExpense({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    expense: result.expense
  });

  return ok(res, result.expense);
}));

export { router as expensesRouter };
