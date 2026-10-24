import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Prisma, Session, User } from '@prisma/client';
import { prisma } from '../prisma/client.js';
import { forbidden, notFound, unauthorized } from '../http/api-error.js';

export const IMPERSONATION_TTL_MS = 15 * 60_000;
export const MASTER_LOGIN_MAX_AGE_MS = 30 * 60_000;
const digest = (value: string) => createHash('sha256').update(value).digest();
export function impersonationConfig() {
  const email = (process.env.MASTER_USER_EMAIL?.trim() || process.env.Master_user_email?.trim() || '').toLowerCase();
  const code = process.env.MASTER_IMPERSONATION_CODE ?? '';
  const userId = process.env.MASTER_USER_ID?.trim();
  let origin = '';
  try {
    const url = new URL(process.env.MASTER_WEB_ORIGIN ?? 'https://fundnesta.appnesta.com');
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    origin = url.origin;
  } catch { return null; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || Buffer.byteLength(code) < 32) return null;
  const policyHash = digest(JSON.stringify([email, code, origin, userId])).toString('hex');
  return { email, code, origin, userId, policyHash };
}
export function requireImpersonationWeb(req: Request) {
  const config = impersonationConfig();
  if (!config) throw notFound();
  if (req.header('origin') !== config.origin || req.header('x-client-platform') !== 'web') throw forbidden('Impersonation is available only from the configured web origin.');
  return config;
}
export function validMasterCode(value: string, expected: string) {
  return timingSafeEqual(digest(value), digest(expected));
}
export const masterEmailHash = (email: string) => digest(email).toString('hex');

type Db = Prisma.TransactionClient;
export function isConfiguredMaster(session: Session & { user: User }, config: NonNullable<ReturnType<typeof impersonationConfig>>) {
  return !session.impersonatorSessionId && session.user.isActive
    && session.user.tenantId === session.tenantId
    && session.user.email?.trim().toLowerCase() === config.email
    && session.verifiedEmail?.trim().toLowerCase() === config.email
    && (!config.userId || session.userId === config.userId);
}
export async function requireMasterSession(req: Request, db: Db = prisma) {
  const config = requireImpersonationWeb(req);
  if (!req.auth || req.auth.impersonation) throw notFound();
  const session = await db.session.findFirst({ where: {
    id: req.auth.sessionId, userId: req.auth.userId, tenantId: req.auth.tenantId,
    revokedAt: null, expiresAt: { gt: new Date() }
  }, include: { user: true } });
  if (!session || !isConfiguredMaster(session, config)) throw notFound();
  if (session.createdAt.getTime() < Date.now() - MASTER_LOGIN_MAX_AGE_MS) throw forbidden('Sign in again with Google or an email code before using support access.');
  return { session, config };
}
export async function validateImpersonatedRequest(req: Request, session: Session & { user: User }) {
  const config = requireImpersonationWeb(req);
  if (!session.impersonatorUserId || !session.impersonatorSessionId || session.impersonationPolicyHash !== config.policyHash) throw unauthorized('Support session is no longer valid.');
  const parent = await prisma.session.findFirst({ where: {
    id: session.impersonatorSessionId, userId: session.impersonatorUserId,
    revokedAt: null, expiresAt: { gt: new Date() }
  }, include: { user: true } });
  if (!parent || !isConfiguredMaster(parent, config) || session.user.tenantId !== session.tenantId) throw unauthorized('The master session has ended.');
  const path = req.originalUrl.split('?')[0];
  const permittedPost = req.method === 'POST' && (
    /^\/(?:v1\/)?auth\/(?:switch-project|logout)$/.test(path)
    || /^\/v1\/support\/impersonation\/stop$/.test(path)
  );
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !permittedPost) {
    await prisma.activity.create({ data: {
      tenantId: session.tenantId, actorUserId: parent.userId, action: 'support.impersonation.write_blocked', entityType: 'support_impersonation', entityId: session.id,
      after: { target_user_id: session.userId, parent_session_id: parent.id, method: req.method, path }
    } });
    throw forbidden('Impersonation is view-only. Stop impersonating before making changes.');
  }
  return { actorUserId: parent.userId, parentSessionId: parent.id, expiresAt: session.expiresAt.toISOString(), reason: session.impersonationReason };
}
