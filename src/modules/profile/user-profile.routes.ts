import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { requireAuthContext } from '../../core/security/auth.context.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { conflict, notFound } from '../../core/http/api-error.js';
import { ok } from '../../core/http/response.js';
import { financialTransaction } from '../accounting/transaction.js';
const router = Router();
export const professionalProfileSchema = z.object({ revision: z.number().int().nonnegative(), name: z.string().trim().min(2).max(120), designation: z.string().trim().max(120), mobile: z.string().regex(/^(|\+[1-9]\d{6,14})$/, 'Use a mobile number with country code'), email: z.union([z.literal(''), z.string().trim().email().max(200)]) }).strict();
export function professionalProfile(user: { name: string; mobile: string; email: string | null; professionalProfile?: unknown }) {
  const p = user.professionalProfile as { revision?: number; designation?: string; mobile?: string; email?: string } | null;
  return { revision: p?.revision ?? 0, name: user.name, designation: p?.designation ?? '', mobile: p?.mobile ?? user.mobile, email: p?.email ?? user.email ?? '' };
}
router.get('/', asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req), user = await prisma.user.findFirst({ where: { id: auth.userId, tenantId: auth.tenantId, isActive: true } });
  if (!user) throw notFound('Profile not found');
  return ok(res, professionalProfile(user));
}));
router.patch('/', asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req), body = professionalProfileSchema.parse(req.body);
  const result = await financialTransaction(async tx => {
    const user = await tx.user.findFirst({ where: { id: auth.userId, tenantId: auth.tenantId, isActive: true } });
    if (!user) throw notFound('Profile not found');
    const before = professionalProfile(user);
    if (body.revision !== before.revision) throw conflict('Your profile changed. Reload before saving.');
    const profile = { revision: body.revision + 1, designation: body.designation, mobile: body.mobile, email: body.email };
    const updated = await tx.user.update({ where: { id: user.id }, data: { name: body.name, professionalProfile: profile } });
    const after = professionalProfile(updated);
    await tx.activity.create({ data: { tenantId: auth.tenantId, actorUserId: auth.userId, action: 'user.professional_profile.updated', entityType: 'user', entityId: user.id, before, after } });
    return after;
  }); return ok(res, result);
}));
export { router as userProfileRouter };
