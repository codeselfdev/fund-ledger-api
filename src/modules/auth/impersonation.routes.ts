import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { authenticateAccount } from '../../core/security/auth.middleware.js';
import { requireMasterSession } from '../../core/security/impersonation-policy.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { startImpersonation, stopImpersonation } from './impersonation.service.js';

const router = Router();
router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }); next(); });
router.use(rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));
router.use(authenticateAccount);
router.get('/status', asyncHandler(async (req, res) => {
  if (req.auth!.impersonation) return ok(res, { active: true, read_only: true, target_user_id: req.auth!.userId, ...req.auth!.impersonation });
  await requireMasterSession(req);
  return ok(res, { active: false, available: true, read_only: true, max_minutes: 15 });
}));
router.get('/users', asyncHandler(async (req, res) => {
  const { session, config } = await requireMasterSession(req);
  const query = z.object({ search: z.string().trim().max(100).default(''), cursor: z.string().max(100).optional() }).parse(req.query);
  const rows = await prisma.user.findMany({ where: {
    isActive: true, id: { not: session.userId, ...(query.cursor ? { gt: query.cursor } : {}) },
    email: { not: null }, NOT: { email: { equals: config.email, mode: 'insensitive' } },
    memberships: { some: { isActive: true, project: { isActive: true } } },
    ...(query.search ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { email: { contains: query.search, mode: 'insensitive' } }, { tenant: { name: { contains: query.search, mode: 'insensitive' } } }] } : {})
  }, orderBy: { id: 'asc' }, take: 21, select: {
    id: true, name: true, email: true, tenant: { select: { id: true, name: true, slug: true } },
    memberships: { where: { isActive: true, project: { isActive: true } }, select: { role: true, project: { select: { id: true, name: true } } } }
  } });
  await prisma.activity.create({ data: { tenantId: session.tenantId, actorUserId: session.userId, action: 'support.impersonation.directory_read', entityType: 'support_impersonation', after: { result_count: Math.min(rows.length, 20) } } });
  return ok(res, { users: rows.slice(0, 20), next_cursor: rows.length > 20 ? rows[19].id : null });
}));
router.post('/start', asyncHandler(async (req, res) => {
  const body = z.object({ user_id: z.string().min(1).max(100), project_id: z.string().min(1).max(100).optional(), code: z.string().min(1).max(256), reason: z.string().trim().min(10).max(500) }).strict().parse(req.body);
  return ok(res, await startImpersonation(req, body));
}));
router.post('/stop', asyncHandler(async (req, res) => ok(res, await stopImpersonation(req))));

export { router as impersonationRouter };
