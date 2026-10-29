import { prisma } from "../prisma/client.js";
import { forbidden } from "../http/api-error.js";
import { tenantAccounts } from "../identity/tenant-accounts.js";
/** Organization access comes exclusively from memberships of one global user. */
export async function linkedIdentityUsers(accountId: string) {
  const actor = await tenantAccounts(prisma).findUniqueOrThrow({where:{id:accountId}});
  if (!actor.isActive) throw forbidden("Account is inactive");
  const users = await tenantAccounts(prisma).findMany({where:{userId:actor.userId,isActive:true}});
  return {rootId:actor.userId,users,userIds:users.map(user=>user.id)};
}
