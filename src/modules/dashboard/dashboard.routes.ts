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

function mapDirection(direction?: string) {
  if (direction === "in") return "money_in";
  if (direction === "out") return "money_out";
  return direction;
}

router.get("/dashboard", requireProject, requireRoles("staff", "admin", "owner"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const [depositsAwaitingMe, expensesPending, schedules, dues, accounts] = await Promise.all([
    prisma.deposit.count({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        status: auth.roles.includes("accountant") ? "pending_accountant" : "pending_approver"
      }
    }),
    prisma.expense.count({ where: { tenantId: auth.tenantId, projectId: auth.projectId, status: "pending" } }),
    prisma.schedule.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId } }),
    prisma.due.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId } }),
    prisma.account.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId } })
  ]);

  const dueTotal = dues.reduce((sum, due) => sum + due.amount + due.penaltyDue, 0);
  const paidTotal = dues.reduce((sum, due) => sum + due.paidAmount + due.penaltyPaid, 0);

  return ok(res, {
    deposits_awaiting_me: depositsAwaitingMe,
    expenses_pending: expensesPending,
    schedules_total: schedules.length,
    fund_collected_percent: dueTotal === 0 ? 0 : Math.round((paidTotal / dueTotal) * 100),
    account_total: accounts.reduce((sum, account) => sum + account.balance, 0)
  });
}));

router.get("/ledger", requireProject, requireRoles("staff"), validateQuery(ledgerQuerySchema), asyncHandler(async (req, res) => {
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
