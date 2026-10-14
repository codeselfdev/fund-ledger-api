import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody, validateParams } from '../../core/validation/validate.js';
import { idParamSchema } from '../../core/validation/common.schemas.js';
import { prisma } from '../../core/prisma/client.js';
import { draftSchema, selectAudience } from './campaign.policy.js';
import { campaignSummary, createCampaign, loadPeople, previewCampaign, retryCampaign } from './campaign.service.js';
const router = Router();
router.use(requireProject, requireRoles('owner', 'admin'));
router.get('/audiences', asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req), people = await loadPeople(scope);
  return ok(res, { project_id: scope.projectId, people: people.map(p => ({ id: p.id, name: p.name, inbox: !!p.userId, push: p.push, email: !!p.email, due: p.due, staff: p.staff, member: !!p.memberId })),
    counts: Object.fromEntries(['all', 'due', 'staff'].map(audience => [audience, selectAudience(people, { audience: audience as 'all' | 'due' | 'staff', recipient_ids: [] }).length])) });
}));
router.post('/preview', validateBody(draftSchema), asyncHandler(async (req, res) => {
  const { recipients, ...preview } = await previewCampaign(requireProjectContext(req), req.body);
  return ok(res, preview);
}));
const sendSchema = z.object({ draft: draftSchema, request_id: z.string().uuid(), preview_token: z.string().regex(/^[a-f0-9]{64}$/) });
router.post('/', validateBody(sendSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof sendSchema>;
  return ok(res, await createCampaign(requireProjectContext(req), body.draft, body.request_id, body.preview_token));
}));
router.get('/', asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req);
  const rows = await prisma.notificationCampaign.findMany({ where: { tenantId: scope.tenantId, projectId: scope.projectId }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true } });
  return ok(res, await Promise.all(rows.map(row => campaignSummary(scope, row.id))));
}));
router.post('/:id/retry', validateParams(idParamSchema), asyncHandler(async (req, res) => ok(res, await retryCampaign(requireProjectContext(req), String(req.params.id)))));
export { router as notificationCampaignRouter };
