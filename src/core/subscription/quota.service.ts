import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client.js";
import { ApiError } from "../http/api-error.js";
import { PACKAGES, packageId, MAX_DOCUMENT_BYTES } from "./packages.js";

export function assertDocumentSize(size: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_DOCUMENT_BYTES)
    throw new ApiError(413, "DOCUMENT_TOO_LARGE", "Each document must be 5 MB or smaller.");
}
export async function tenantQuota(tenantId: string, tx: Prisma.TransactionClient = prisma) {
  const [tenant, documents, users, projects] = await Promise.all([
    tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { contact: true } }),
    tx.upload.count({ where: { tenantId, deletedAt: null } }),
    tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM organization_quota_identities(${tenantId}, NULL, NULL)`,
    tx.project.count({ where: { tenantId } })
  ]);
  const id = packageId(tenant.contact), plan = PACKAGES[id];
  return { package: id, max_document_bytes: MAX_DOCUMENT_BYTES,
    documents: { used: documents, limit: plan.documents }, users: { used: Number(users[0]?.count ?? 0), limit: plan.users }, projects: { used: projects, limit: plan.projects } };
}
export async function assertProjectCapacity(tenantId: string) {
  const quota = await tenantQuota(tenantId);
  if (quota.projects.limit !== null && quota.projects.used >= quota.projects.limit)
    throw new ApiError(409, "PROJECT_QUOTA_EXCEEDED", "Your organization has reached its project limit. Upgrade your package to create more projects.", quota);
  return quota;
}
export async function assertPersonCapacity(tenantId: string, input: { user_id?: string; mobile?: string; email?: string }) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { contact: true } });
  if (PACKAGES[packageId(tenant.contact)].users === null) return;
  const quota = await tenantQuota(tenantId);
  if (quota.users.limit === null || quota.users.used < quota.users.limit) return quota;
  const matches = [ ...(input.user_id ? [{ id: input.user_id }] : []), ...(input.mobile ? [{ mobile: input.mobile }] : []), ...(input.email ? [{ email: { equals: input.email, mode: "insensitive" as const } }] : []) ];
  const user = matches.length ? await prisma.user.findFirst({ where: { tenantId, OR: matches } }) : null;
  const member = await prisma.member.findFirst({ where: { tenantId, status: "active", OR: [ ...(user ? [{ userId: user.id }] : []), ...(input.mobile ? [{ mobile: input.mobile }] : []), ...(input.email ? [{ email: { equals: input.email, mode: "insensitive" as const } }] : []) ] } });
  if (user?.isActive || member) return quota;
  throw new ApiError(409, "USER_QUOTA_EXCEEDED", "Your organization has reached its user/member limit. Upgrade your package to add more people.", { quota });
}
export async function assertDocumentCapacity(tenantId: string) {
  const quota = await tenantQuota(tenantId);
  if (quota.documents.limit !== null && quota.documents.used >= quota.documents.limit)
    throw new ApiError(409, "DOCUMENT_QUOTA_EXCEEDED", "Your organization has reached its document limit. Remove a document or upgrade your package.", { quota });
  return quota;
}
