import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../../core/prisma/client.js';
import { ApiError, forbidden, notFound } from '../../core/http/api-error.js';
import { hashToken, signAccessToken } from '../../core/security/jwt.js';
import { IMPERSONATION_TTL_MS, MASTER_LOGIN_MAX_AGE_MS, masterEmailHash, requireMasterSession, validMasterCode, impersonationConfig } from '../../core/security/impersonation-policy.js';
import { summarizeProjectMemberships } from '../../core/security/project-access.js';

type Db = Prisma.TransactionClient;
const membershipInclude = { memberships: { where: { isActive: true, project: { isActive: true } }, include: { project: true } }, tenant: { include: { subscription: true } } } as const;
async function targetUser(db: Db, id: string) {
  const user = await tenantAccounts(db).findFirst({ where: { id, isActive: true, email: { not: null } }, include: membershipInclude });
  if (!user) throw notFound('This account is unavailable.');
  return user;
}
function payload(user: Awaited<ReturnType<typeof targetUser>>, token: string, projectId: string, session: { id: string; expiresAt: Date; impersonationReason: string | null }) {
  return {
    token, identity_root_id: user.id,
    user: { id: user.id, name: user.name, email: user.email, mobile: user.mobile },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
    active_project_id: projectId,
    memberships: summarizeProjectMemberships(user.memberships.filter(row => row.tenantId === user.tenantId)),
    impersonation: { session_id: session.id, target_email: user.email, expires_at: session.expiresAt.toISOString(), read_only: true, reason: session.impersonationReason }
  };
}
function chooseProject(user: Awaited<ReturnType<typeof targetUser>>, requested?: string) {
  const membership = user.memberships.find(row => row.tenantId === user.tenantId && (!requested || row.projectId === requested));
  if (!membership) throw forbidden('No active access to the selected project.');
  return membership.projectId;
}
async function createChild(db: Db, user: Awaited<ReturnType<typeof targetUser>>, projectId: string, input: {
  actorUserId: string; parentSessionId: string; expiresAt: Date; reason: string | null; policyHash: string;
}) {
  const session = await db.session.create({ data: {
    tenantId: user.tenantId, userId: user.id, activeProjectId: projectId, tokenHash: 'pending', expiresAt: input.expiresAt,
    impersonatorUserId: input.actorUserId, impersonatorSessionId: input.parentSessionId,
    impersonationReason: input.reason, impersonationPolicyHash: input.policyHash
  } });
  const token = signAccessToken({ sessionId: session.id, userId: user.id, tenantId: user.tenantId, impersonation: true }, input.expiresAt);
  await db.session.update({ where: { id: session.id }, data: { tokenHash: hashToken(token) } });
  return { token, session };
}
async function audit(db: Db, input: { tenantId: string; actorUserId: string; projectId?: string; action: string; entityId?: string; after: Prisma.InputJsonValue }) {
  await db.activity.create({ data: { ...input, entityType: 'support_impersonation' } });
}

export async function startImpersonation(req: Request, input: { user_id: string; project_id?: string; code: string; reason: string }) {
  const { config } = await requireMasterSession(req);
  // The database lock and account-wide audit counter work across replicas and logins.
  const result = await prisma.$transaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-impersonation:${config.email}`}, 0))::text`;
    const { session: parent } = await requireMasterSession(req, db);
    const emailHash = masterEmailHash(config.email);
    const failures = await db.activity.count({ where: {
      action: 'security.impersonation.invalid_code', createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
      after: { path: ['master_email_hash'], equals: emailHash }
    } });
    if (failures >= 5) return { denied: 'locked' } as const;
    if (!validMasterCode(input.code, config.code)) {
      await audit(db, { tenantId: parent.tenantId, actorUserId: parent.userId, action: 'security.impersonation.invalid_code',
        after: { master_email_hash: emailHash, parent_session_id: parent.id } });
      return { denied: 'code' } as const;
    }
    const user = await targetUser(db, input.user_id);
    if (user.id === parent.userId || user.email?.trim().toLowerCase() === config.email) throw forbidden('The master account cannot be impersonated.');
    const projectId = chooseProject(user, input.project_id);
    const expiresAt = new Date(Math.min(Date.now() + IMPERSONATION_TTL_MS, parent.expiresAt.getTime(), parent.createdAt.getTime() + MASTER_LOGIN_MAX_AGE_MS));
    // One support session per master login; never revoke the target's real sessions.
    await db.session.updateMany({ where: { impersonatorSessionId: parent.id, revokedAt: null }, data: { revokedAt: new Date() } });
    const child = await createChild(db, user, projectId, { actorUserId: parent.userId, parentSessionId: parent.id, expiresAt, reason: input.reason, policyHash: config.policyHash });
    await audit(db, { tenantId: user.tenantId, projectId, actorUserId: parent.userId, action: 'support.impersonation.started', entityId: child.session.id,
      after: { target_user_id: user.id, parent_session_id: parent.id, reason: input.reason, read_only: true, expires_at: expiresAt.toISOString() } });
    return { login: payload(user, child.token, projectId, child.session) } as const;
  });
  if ('denied' in result) throw new ApiError(result.denied === 'locked' ? 429 : 403, 'IMPERSONATION_DENIED', result.denied === 'locked' ? 'Too many failed master-code attempts. Try again in 15 minutes.' : 'The master code was not accepted.');
  return result.login;
}
export async function switchImpersonationProject(req: Request, projectId: string) {
  const auth = req.auth!;
  if (!auth.impersonation) throw forbidden();
  return prisma.$transaction(async db => {
    const config = impersonationConfig();
    if (!config) throw forbidden();
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-impersonation:${config.email}`}, 0))::text`;
    const current = await db.session.findFirst({ where: { id: auth.sessionId, userId: auth.userId, revokedAt: null, expiresAt: { gt: new Date() } } });
    if (!current?.impersonatorUserId || !current.impersonatorSessionId || !current.impersonationPolicyHash) throw forbidden();
    const user = await targetUser(db, auth.userId);
    chooseProject(user, projectId);
    const claimed = await db.session.updateMany({ where: { id: current.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count !== 1) throw forbidden('This support session has already changed.');
    const child = await createChild(db, user, projectId, { actorUserId: current.impersonatorUserId, parentSessionId: current.impersonatorSessionId,
      expiresAt: current.expiresAt, reason: current.impersonationReason, policyHash: current.impersonationPolicyHash });
    await audit(db, { tenantId: user.tenantId, projectId, actorUserId: current.impersonatorUserId, action: 'support.impersonation.project_switched', entityId: child.session.id,
      after: { target_user_id: user.id, previous_session_id: current.id, parent_session_id: current.impersonatorSessionId } });
    return payload(user, child.token, projectId, child.session);
  });
}

export async function stopImpersonation(req: Request) {
  const auth = req.auth!;
  if (!auth.impersonation) await requireMasterSession(req);
  await prisma.$transaction(async db => {
    const config = impersonationConfig();
    if (config) await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-impersonation:${config.email}`}, 0))::text`;
    await db.session.updateMany({ where: { impersonatorSessionId: auth.impersonation?.parentSessionId ?? auth.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(db, { tenantId: auth.tenantId, actorUserId: auth.impersonation?.actorUserId ?? auth.userId,
      action: 'support.impersonation.stopped', entityId: auth.sessionId,
      after: { target_user_id: auth.userId, parent_session_id: auth.impersonation?.parentSessionId ?? auth.sessionId } });
  });
  return { revoked: true };
}
