import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateQuery } from "../../core/validation/validate.js";

const router = Router();

const ledgerQuerySchema = z.object({
  account_id: z.string().optional(),
  direction: z.enum(["in", "out", "transfer", "penalty"]).optional(),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional()
});

const dashboardQuerySchema = z.object({
  chart_months: z.coerce.number().int().min(1).max(24).default(6)
});

function startOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addUtcMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function monthKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function mapDirection(direction?: string) {
  if (direction === "in") return "money_in";
  if (direction === "out") return "money_out";
  return direction;
}

router.get("/dashboard", requireProject, requireRoles("staff", "admin", "owner"), validateQuery(dashboardQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as unknown as z.infer<typeof dashboardQuerySchema>;
  const currentMonth = startOfUtcMonth(new Date());
  const chartStart = addUtcMonths(currentMonth, -(query.chart_months - 1));
  const [depositsAwaitingMe, expensesPending, schedules, dues, accounts, cashflowTransactions] = await Promise.all([
    prisma.deposit.count({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        status: auth.roles.includes("accountant") ? "pending_accountant" : "pending_approver"
      }
    }),
    prisma.expense.count({ where: { tenantId: auth.tenantId, projectId: auth.projectId, status: "pending" } }),
    prisma.schedule.findMany({
      where: { tenantId: auth.tenantId, projectId: auth.projectId, purpose: "contribution" }
    }),
    prisma.due.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId } }),
    prisma.account.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId } }),
    prisma.accountTransaction.findMany({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        direction: { in: ["money_in", "money_out"] },
        createdAt: { gte: chartStart }
      },
      select: { direction: true, amount: true, createdAt: true }
    })
  ]);

  const dueTotal = dues.reduce((sum, due) => sum + due.amount - due.waivedAmount + due.penaltyDue, 0);
  const paidTotal = dues.reduce((sum, due) => sum + due.paidAmount + due.penaltyPaid, 0);
  const remainingReceivable = Math.max(0, dueTotal - paidTotal);
  const monthlyCashflow = Array.from({ length: query.chart_months }, (_, index) => {
    const date = addUtcMonths(chartStart, index);
    return {
      period: monthKey(date),
      label: date.toLocaleString("en", { month: "short", timeZone: "UTC" }),
      income: 0,
      expense: 0
    };
  });
  const cashflowByMonth = new Map(monthlyCashflow.map((item) => [item.period, item]));
  for (const transaction of cashflowTransactions) {
    const bucket = cashflowByMonth.get(monthKey(transaction.createdAt));
    if (!bucket) continue;
    if (transaction.direction === "money_in") bucket.income += transaction.amount;
    if (transaction.direction === "money_out") bucket.expense += transaction.amount;
  }
  const incomeTotal = monthlyCashflow.reduce((sum, item) => sum + item.income, 0);
  const expenseTotal = monthlyCashflow.reduce((sum, item) => sum + item.expense, 0);

  return ok(res, {
    deposits_awaiting_me: depositsAwaitingMe,
    expenses_pending: expensesPending,
    schedules_total: schedules.length,
    fund_collected_percent: dueTotal === 0 ? 0 : Math.round((paidTotal / dueTotal) * 100),
    account_total: accounts.reduce((sum, account) => sum + account.balance, 0),
    charts: {
      receivable: {
        goal: dueTotal,
        achieved: paidTotal,
        remaining: remainingReceivable,
        achieved_percent: dueTotal === 0 ? 0 : Math.min(100, Math.round((paidTotal / dueTotal) * 100)),
        series: [
          { key: "achieved", label: "Achieved", value: paidTotal },
          { key: "remaining", label: "Remaining", value: remainingReceivable }
        ]
      },
      income_vs_expense: {
        period_months: query.chart_months,
        income_total: incomeTotal,
        expense_total: expenseTotal,
        net: incomeTotal - expenseTotal,
        series: monthlyCashflow
      }
    }
  });
}));

router.get("/ledger", requireProject, requireRoles("staff", "member"), validateQuery(ledgerQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof ledgerQuerySchema>;
  const transactions = await prisma.accountTransaction.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.account_id ? { accountId: query.account_id } : {}),
      ...(query.direction ? { direction: mapDirection(query.direction) as never } : {}),
      ...(query.date_from || query.date_to ? {
        createdAt: {
          ...(query.date_from ? { gte: query.date_from } : {}),
          ...(query.date_to ? { lte: query.date_to } : {})
        }
      } : {})
    },
    include: { account: true },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, transactions);
}));

export { router as dashboardRouter };
