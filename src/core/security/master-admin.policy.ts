import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { prisma } from '../prisma/client.js';
import { ApiError, forbidden } from '../http/api-error.js';
import { IMPERSONATION_TTL_MS, MASTER_LOGIN_MAX_AGE_MS, masterEmailHash, requireMasterSession, validMasterCode } from './impersonation-policy.js';

const signature = (payload: string, secret: string) => createHmac('sha256', secret).update(`master-admin:v1:${payload}`).digest();
export async function unlockMasterAdmin(req: Request, code: string) {
  const { config } = await requireMasterSession(req);
  const result = await prisma.$transaction(async db => {
    // Share the impersonation lock and failure counter across sessions and replicas.
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`support-impersonation:${config.email}`}, 0))::text`;
    const { session, config: current } = await requireMasterSession(req, db);
    const emailHash = masterEmailHash(current.email);
    const failures = await db.activity.count({ where: {
      action: 'security.impersonation.invalid_code', createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
      after: { path: ['master_email_hash'], equals: emailHash }
    } });
    if (failures >= 5) return { denied: 'locked' } as const;
    if (!validMasterCode(code, current.code)) {
      await db.activity.create({ data: { tenantId: session.tenantId, actorUserId: session.userId,
        action: 'security.impersonation.invalid_code', entityType: 'support_impersonation',
        after: { master_email_hash: emailHash, parent_session_id: session.id } } });
      return { denied: 'code' } as const;
    }
    const expires = Math.min(Date.now() + IMPERSONATION_TTL_MS, session.expiresAt.getTime(), session.createdAt.getTime() + MASTER_LOGIN_MAX_AGE_MS);
    const payload = Buffer.from(JSON.stringify({ session: session.id, policy: current.policyHash, expires })).toString('base64url');
    await db.internalAudit.create({ data: { actor: `master:${session.userId}`, action: 'master_admin.unlocked',
      metadata: { session_id: session.id, expires_at: new Date(expires).toISOString() } } });
    return { grant: `${payload}.${signature(payload, current.code).toString('base64url')}`, expires_at: new Date(expires).toISOString() };
  });
  if ('denied' in result) throw new ApiError(result.denied === 'locked' ? 429 : 403, 'MASTER_ADMIN_DENIED',
    result.denied === 'locked' ? 'Too many failed master-code attempts. Try again in 15 minutes.' : 'The master code was not accepted.');
  return result;
}

export async function requireMasterAdmin(req: Request) {
  const identity = await requireMasterSession(req);
  const raw = req.header('x-master-grant') ?? '';
  if (!raw || raw.length > 2048) throw forbidden('Unlock administration with your master code.');
  try {
    const [payload, mac, extra] = raw.split('.');
    const provided = Buffer.from(mac ?? '', 'base64url'), expected = signature(payload, identity.config.code);
    if (extra !== undefined || provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw Error();
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.session !== identity.session.id || data.policy !== identity.config.policyHash
      || !Number.isFinite(data.expires) || data.expires <= Date.now()
      || data.expires > identity.session.createdAt.getTime() + MASTER_LOGIN_MAX_AGE_MS) throw Error();
  } catch { throw forbidden('Administration access expired. Unlock again with your master code.'); }
  return identity;
}
