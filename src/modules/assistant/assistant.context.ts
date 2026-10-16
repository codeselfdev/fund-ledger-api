import { createHash } from "node:crypto";
import { prisma } from "../../core/prisma/client.js";
import { forbidden } from "../../core/http/api-error.js";
/** Re-authorize on every answer, including queued bot jobs and retries. Never trust a prompt for scope. */
export async function assistantContext(tenantId: string, projectId: string, userId: string) {
  const [project, user, memberships] = await Promise.all([
    prisma.project.findFirst({ where: { id: projectId, tenantId, isActive: true }, select: { name: true, projectType: true } }),
    prisma.user.findFirst({ where: { id: userId, tenantId, isActive: true }, select: { id: true } }),
    prisma.projectMembership.findMany({ where: { tenantId, projectId, userId, isActive: true }, select: { role: true, memberId: true } })
  ]);
  if (!project || !user || !memberships.length) throw forbidden("Your project access is no longer active.");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, currency: true } });
  const base = { organization: tenant.name, project: project.name, project_type: project.projectType, currency: tenant.currency, snapshot_at: new Date().toISOString() };
  const finance = memberships.some(m => ["owner", "admin", "accountant", "auditor"].includes(m.role));
  const memberIds = memberships.flatMap(m => m.memberId ? [m.memberId] : []);
  const linked = await prisma.member.findMany({ where: { tenantId, projectId, status: "active", OR: [{ userId }, { id: { in: memberIds } }] }, select: { id: true } });
  const authorization_hash = createHash("sha256").update(JSON.stringify({ tenantId, projectId, userId, roles: memberships.map(m => m.role).sort(), members: linked.map(m => m.id).sort() })).digest("hex");
  const dueScope = { tenantId, projectId, ...(!finance ? { memberId: { in: linked.map(m => m.id) } } : {}) };
  const dues = await prisma.due.aggregate({ where: dueScope, _sum: { amount: true, paidAmount: true, waivedAmount: true, penaltyDue: true, penaltyPaid: true } });
  const d = dues._sum;
  const summary = { scope: finance ? "authorized project totals" : "your linked member records only", billed: d.amount ?? 0, paid: d.paidAmount ?? 0, waived: d.waivedAmount ?? 0, outstanding: Math.max(0, (d.amount ?? 0) - (d.paidAmount ?? 0) - (d.waivedAmount ?? 0)), penalty_outstanding: Math.max(0, (d.penaltyDue ?? 0) - (d.penaltyPaid ?? 0)) };
  if (!finance) return { ...base, authorization_hash, dues: summary };
  const [accounts, members, expenses] = await Promise.all([
    prisma.account.aggregate({ where: { tenantId, projectId }, _sum: { balance: true } }),
    prisma.member.count({ where: { tenantId, projectId, status: "active" } }),
    prisma.expense.groupBy({ by: ["status"], where: { tenantId, projectId }, _sum: { amount: true } })
  ]);
  return { ...base, authorization_hash, dues: summary, account_balance: accounts._sum.balance ?? 0, active_members: members, expenses_by_status: expenses.map(e => ({ status: e.status, amount: e._sum.amount ?? 0 })) };
}
