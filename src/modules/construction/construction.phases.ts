import { Router } from 'express';
import { z } from 'zod';
import type { ConstructionPhase, Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { created, ok } from '../../core/http/response.js';
import { validateBody } from '../../core/validation/validate.js';
import { atDate, dateSchema, pastDateSchema, day, today, hash, id, requestKey } from '../billing/billing.policy.js';
import { audit, financialTransaction, scope, sameRequest, type ConstructionScope } from './construction.service.js';

const fields = {
  planned_start: dateSchema.nullable(), planned_end: dateSchema.nullable(),
  actual_start: pastDateSchema.nullable(), actual_end: pastDateSchema.nullable(),
  responsible_user_id: id.nullable(),
  status: z.enum(['draft', 'planned', 'active', 'on_hold', 'completed']),
};
function validateDates(v: z.infer<z.ZodObject<typeof fields>>, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.planned_end && (!v.planned_start || v.planned_end < v.planned_start)) issue('planned_end', 'Planned end must follow planned start');
  if (v.actual_end && (!v.actual_start || v.actual_end < v.actual_start)) issue('actual_end', 'Actual end must follow actual start');
  if (v.status !== 'draft' && (!v.planned_start || !v.planned_end)) issue('planned_start', 'Set both planned dates before scheduling a phase');
  if (['active', 'on_hold', 'completed'].includes(v.status) && !v.actual_start) issue('actual_start', 'Record the actual start for work that has begun');
  if ((v.status === 'completed') !== !!v.actual_end) issue('actual_end', 'Only a completed phase has an actual end; completion requires that date');
  if (v.status === 'planned' && v.actual_start) issue('actual_start', 'Use Active or On hold for work that has started');
}
export const createPhaseSchema = z.object({ ...fields, name: z.string().trim().min(2).max(150), request_key: requestKey }).strict().superRefine(validateDates);
export const updatePhaseSchema = z.object({ ...fields, revision: z.number().int().positive() }).strict().superRefine(validateDates);
const difference = (from: string, to: string) => Math.round((atDate(to).getTime() - atDate(from).getTime()) / 86400000);
export function phaseResponse(p: ConstructionPhase & { responsibleUser?: { id: string; name: string } | null }, asOf = today()) {
  const start = p.plannedStart ? day(p.plannedStart) : null, end = p.plannedEnd ? day(p.plannedEnd) : null;
  const actualEnd = p.actualEnd ? day(p.actualEnd) : null;
  return { ...p, requestHash: undefined, requestKey: undefined,
    plannedStart: start, plannedEnd: end, actualStart: p.actualStart ? day(p.actualStart) : null, actualEnd,
    plannedDays: start && end ? difference(start, end) + 1 : null,
    actualDays: p.actualStart && p.actualEnd ? difference(day(p.actualStart), day(p.actualEnd)) + 1 : null,
    overdueDays: end && p.status !== 'completed' ? Math.max(0, difference(end, asOf)) : 0,
    delayDays: end && actualEnd ? Math.max(0, difference(end, actualEnd)) : null,
  };
}
const include = { responsibleUser: { select: { id: true, name: true } } };
const dataFor = (b: z.infer<typeof updatePhaseSchema> | z.infer<typeof createPhaseSchema>) => ({
  plannedStart: b.planned_start ? atDate(b.planned_start) : null, plannedEnd: b.planned_end ? atDate(b.planned_end) : null,
  actualStart: b.actual_start ? atDate(b.actual_start) : null, actualEnd: b.actual_end ? atDate(b.actual_end) : null,
  responsibleUserId: b.responsible_user_id, status: b.status,
});
export const phaseRouter = Router();
export function canChoosePhaseAssignee(a: ReturnType<typeof requireProjectContext>) {
  return a.roles.some(role => ['owner', 'admin', 'accountant'].includes(role)) || a.menuPermissions?.construction_budgets?.write === true;
}
phaseRouter.get('/phases/assignees', asyncHandler(async (req, res) => {
  if (!canChoosePhaseAssignee(requireProjectContext(req))) throw forbidden('Write access to construction budgets is required');
  const rows = await prisma.projectMembership.findMany({ where: { ...scope(requireProjectContext(req)), isActive: true, user: { isActive: true }, OR: [{ role: { not: 'member' } }, { customRoleId: { not: null } }] }, select: { user: { select: { id: true, name: true } } } });
  return ok(res, [...new Map(rows.map(r => [r.user.id, r.user])).values()].sort((a, b) => a.name.localeCompare(b.name)));
}));
phaseRouter.get('/phases', asyncHandler(async (req, res) => {
  const rows = await prisma.constructionPhase.findMany({ where: scope(requireProjectContext(req)), include, orderBy: [{ createdAt: 'asc' }, { name: 'asc' }] });
  return ok(res, rows.map(p => phaseResponse(p)));
}));
phaseRouter.post('/phases', requireRoles('accountant'), validateBody(createPhaseSchema), asyncHandler(async (req, res) => {
  const a = requireProjectContext(req), b = createPhaseSchema.parse(req.body);
  const row = await financialTransaction(async tx => {
    const old = await tx.constructionPhase.findFirst({ where: { ...scope(a), requestKey: b.request_key }, include });
    if (old) {
      if (old.createdById !== a.userId || !old.requestHash) throw conflict('Request key already used');
      sameRequest({ requestHash: old.requestHash }, b); return old;
    }
    if (await tx.constructionPhase.findFirst({ where: { ...scope(a), name: b.name } })) throw conflict('A phase with this name already exists');
    await checkAssignee(tx, a, b.responsible_user_id);
    const row = await tx.constructionPhase.create({ data: { ...scope(a), ...dataFor(b), name: b.name, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId }, include });
    await audit(tx, a, 'phase.created', 'construction_phase', row.id, row); return row;
  });
  return created(res, phaseResponse(row));
}));
phaseRouter.put('/phases/:id', requireRoles('accountant'), validateBody(updatePhaseSchema), asyncHandler(async (req, res) => {
  const a = requireProjectContext(req), b = updatePhaseSchema.parse(req.body);
  const row = await financialTransaction(async tx => {
    const old = await tx.constructionPhase.findFirst({ where: { ...scope(a), id: req.params.id } });
    if (!old) throw notFound('Phase not found');
    if (old.revision !== b.revision) throw conflict('Phase changed. Reload the phase before saving again.');
    // An existing inactive assignee remains visible; only a changed assignment must be active.
    if (b.responsible_user_id !== old.responsibleUserId) await checkAssignee(tx, a, b.responsible_user_id);
    const changed = await tx.constructionPhase.updateMany({ where: { ...scope(a), id: old.id, revision: b.revision }, data: { ...dataFor(b), revision: { increment: 1 } } });
    if (!changed.count) throw conflict('Phase changed. Reload the phase before saving again.');
    const row = await tx.constructionPhase.findFirstOrThrow({ where: { ...scope(a), id: old.id }, include });
    await audit(tx, a, 'phase.updated', 'construction_phase', row.id, { before: old, after: row }); return row;
  });
  return ok(res, phaseResponse(row));
}));
async function checkAssignee(tx: Prisma.TransactionClient, a: ConstructionScope, userId: string | null) {
  if (!userId) return;
  const member = await tx.projectMembership.findFirst({ where: { ...scope(a), userId, isActive: true, user: { isActive: true }, OR: [{ role: { not: 'member' } }, { customRoleId: { not: null } }] } });
  if (!member) throw badRequest('Choose an active project staff user as the phase responsible person');
}
