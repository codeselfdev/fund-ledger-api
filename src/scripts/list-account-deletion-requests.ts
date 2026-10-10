import { prisma } from "../core/prisma/client.js";

// Run only in an authorized server terminal. This prints personal information.
async function main() {
  const requests = await prisma.accountDeletionRequest.findMany({
    where: { status: "pending" }, orderBy: { dueAt: "asc" }
  });
  const users = await prisma.user.findMany({
    where: { id: { in: requests.map(request => request.userId) } },
    select: { id: true, tenantId: true, name: true, email: true, mobile: true }
  });
  const byId = new Map(users.map(user => [user.id, user]));
  console.log(JSON.stringify(requests.map(request => ({
    reference: request.id, user_id: request.userId, tenant_id: request.tenantId,
    requested_at: request.requestedAt, due_at: request.dueAt,
    overdue: request.dueAt.getTime() < Date.now(),
    account: byId.get(request.userId) ?? null
  })), null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
