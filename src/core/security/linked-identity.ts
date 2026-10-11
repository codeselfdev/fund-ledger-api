import { prisma } from "../prisma/client.js";
import { forbidden } from "../http/api-error.js";

/** Links are established by authenticated creation, never by matching contact details. */
export async function linkedIdentityUsers(userId: string) {
  const actor = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const rootId = actor.identityRootId ?? actor.id;
  const root = rootId === actor.id ? actor : await prisma.user.findUniqueOrThrow({ where: { id: rootId } });
  if (!root.isActive || !actor.isActive) throw forbidden("Account is inactive");
  const users = await prisma.user.findMany({ where: { isActive: true, OR: [{ id: rootId }, { identityRootId: rootId }] } });
  return { rootId, users, userIds: users.map(user => user.id) };
}
