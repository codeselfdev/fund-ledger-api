import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { ok, created } from '../../core/http/response.js';
import { validateBody } from '../../core/validation/validate.js';
import { atDate, hash, json, today } from '../billing/billing.policy.js';
import { siteSaveSchema, siteContentSchema, wasteLimitSchema, decisionSchema, dateSchema, estimated } from './construction.policy.js';
import { scope, financialTransaction, head, boq, audit, moveMaterialInTransaction } from './construction.service.js';

const router = Router(), write = requireRoles('accountant');
const querySchema = z.object({ from: dateSchema, to: dateSchema, include_pending: z.literal('true').optional() }).refine(v => v.from <= v.to && (+atDate(v.to) - +atDate(v.from)) <= 90 * 86400000, 'Select a date range of up to 90 days');
router.get('/site-logs', asyncHandler(async (req, res) => {
 const a = requireProjectContext(req), range = querySchema.parse(req.query);
 const rows = await prisma.constructionSiteLog.findMany({ where: { ...scope(a), OR: [{ workDate: { gte: atDate(range.from), lte: atDate(range.to) } }, ...(range.include_pending ? [{ status: 'pending' }] : [])] }, orderBy: { workDate: 'asc' } });
 const ids = [...new Set(rows.flatMap(row => siteContentSchema.parse(row.content).expense_ids))];
 const expenses = ids.length ? await prisma.expense.findMany({ where: { ...scope(a), id: { in: ids } }, select: { id: true, title: true, amount: true, status: true, docFileId: true, expenseDate: true } }) : [];
 return ok(res, rows.map(row => ({ ...row, expenses: expenses.filter(e => siteContentSchema.parse(row.content).expense_ids.includes(e.id)) })));
}));
router.put('/site-logs', write, validateBody(siteSaveSchema), asyncHandler(async (req, res) => {
 const a = requireProjectContext(req), b = siteSaveSchema.parse(req.body);
 const result = await financialTransaction(async tx => {
  const old = await tx.constructionSiteLog.findFirst({ where: { ...scope(a), workDate: atDate(b.work_date) } });
  if ((old?.version ?? 0) !== b.version) throw conflict('This daily log changed. Reload it before saving.');
  if (old && old.status !== 'draft') throw conflict('Submitted logs are locked.');
  for (const l of b.content.labor) { await head(tx, a, l.cost_head_id); estimated(l.workers, l.rate); }
  for (const m of b.content.materials) {
   if (!await tx.inventoryItem.findFirst({ where: { id: m.item_id, ...scope(a), isActive: true } })) throw notFound('Active site material not found');
   if (m.boq_id) await boq(tx, a, m.boq_id);
  }
  for (const id of new Set(b.content.expense_ids)) {
   if (!await tx.expense.findFirst({ where: { id, ...scope(a), expenseDate: atDate(b.work_date), status: { not: 'rejected' } } })) throw badRequest('Select a non-rejected expense from this project and work date');
  }
  for (const id of new Set(b.content.photo_ids)) {
   const file = await tx.upload.findFirst({ where: { id, ...scope(a), deletedAt: null } });
   if (!file || !file.mimeType.startsWith('image/')) throw notFound('Project photo not found');
  }
  const data = { content: json(b.content), createdById: a.userId, version: b.version + 1 };
  const row = old ? await tx.constructionSiteLog.update({ where: { id: old.id }, data }) : await tx.constructionSiteLog.create({ data: { ...scope(a), workDate: atDate(b.work_date), ...data } });
  await audit(tx, a, 'site_log.saved', 'construction_site_log', row.id, row);
  return row;
 });
 return ok(res, result);
}));
router.post('/site-logs/:id/submit', write, validateBody(z.object({ version: z.number().int().positive() }).strict()), asyncHandler(async (req, res) => {
 const a = requireProjectContext(req);
 const row = await financialTransaction(async tx => {
  const log = await tx.constructionSiteLog.findFirst({ where: { id: req.params.id, ...scope(a) } });
  if (!log) throw notFound('Site log not found');
  // A retry after commit returns the original result without reposting labor or stock.
  if (log.status !== 'draft') return log;
  if (log.version !== req.body.version) throw conflict('This log changed. Reload it before submitting.');
  if (log.workDate > atDate(today())) throw badRequest('Cannot submit a future day');
  const content = siteContentSchema.parse(log.content), laborIds: string[] = [], materialIds: string[] = [];
  if (!content.labor.length && !content.materials.length && !content.expense_ids.length && !content.note && !content.photo_ids.length) throw badRequest('Add site activity before submitting');
  for (const [i, l] of content.labor.entries()) {
   await head(tx, a, l.cost_head_id);
   const payload = { cost_head_id: l.cost_head_id, worker_name: l.role, work_date: log.workDate.toISOString().slice(0,10), units: l.workers, rate: l.rate, note: `Site log ${log.id}`, request_key: `site:${log.id}:labor:${i}` };
   const labor = await tx.constructionLaborEntry.create({ data: { ...scope(a), costHeadId: l.cost_head_id, workerName: l.role, workDate: log.workDate, units: l.workers, rate: l.rate, amount: estimated(l.workers, l.rate), createdById: a.userId, requestKey: payload.request_key, requestHash: hash(payload), note: payload.note } });
   laborIds.push(labor.id);
  }
  for (const [i, m] of content.materials.entries()) {
   const entry = await moveMaterialInTransaction(tx, a, { ...m, kind: 'consume', entry_date: log.workDate.toISOString().slice(0,10), reason: `Daily site log ${log.id}`, request_key: `site:${log.id}:material:${i}` });
   materialIds.push(entry.id);
  }
  const result = await tx.constructionSiteLog.update({ where: { id: log.id }, data: { status: 'pending', createdById: a.userId, laborIds, materialIds, submittedAt: new Date(), version: { increment: 1 } } });
  await audit(tx, a, 'site_log.submitted', 'construction_site_log', log.id, result);
  return result;
 }, 15000);
 return created(res, row);
}));
router.post('/site-logs/:id/decision', requireRoles('approver'), validateBody(decisionSchema), asyncHandler(async (req, res) => {
 const a = requireProjectContext(req), status = decisionSchema.parse(req.body).decision === 'approve' ? 'approved' : 'rejected';
 const result = await financialTransaction(async tx => {
  const log = await tx.constructionSiteLog.findFirst({ where: { id: req.params.id, ...scope(a) } });
  if (!log) throw notFound('Site log not found');
  if (log.createdById === a.userId) throw conflict('A different administrator or approver must review this log');
  if (log.status === status) return log;
  if (log.status !== 'pending') throw conflict('Only submitted logs can be reviewed');
  for (const id of log.laborIds) {
   const entry = await tx.constructionLaborEntry.findFirst({ where: { id, ...scope(a) } });
   if (!entry || entry.status !== 'pending') throw conflict('Linked wages were already reviewed separately. Review the labor records.');
   if (status === 'approved') await head(tx, a, entry.costHeadId);
   await tx.constructionLaborEntry.update({ where: { id }, data: { status, decidedById: a.userId, decidedAt: new Date() } });
   await audit(tx, a, `labor.${status}`, 'construction_labor', id, { siteLogId: log.id });
  }
  const row = await tx.constructionSiteLog.update({ where: { id: log.id }, data: { status, decidedById: a.userId, decidedAt: new Date(), version: { increment: 1 } } });
  // Stock reflects physical consumption even when the daily report is rejected.
  await audit(tx, a, `site_log.${status}`, 'construction_site_log', log.id, row);
  return row;
 });
 return ok(res, result);
}));
router.get('/wastage', asyncHandler(async (req, res) => {
 const a = requireProjectContext(req);
 const result = await financialTransaction(async tx => {
  const [entries, limits] = await Promise.all([
   tx.constructionMaterialEntry.findMany({ where: scope(a), include: { item: true }, orderBy: { entryDate: 'desc' } }),
   tx.constructionWasteLimit.findMany({ where: scope(a) })
  ]);
  const materials = new Map<string, { itemId: string; name: string; unit: string; used: number; wasted: number; value: number; allowanceBps: number | null; excess: number; percent: number; over: boolean }>();
  for (const e of entries) {
   const row = materials.get(e.itemId) ?? { itemId: e.itemId, name: e.item.name, unit: e.item.unit, used: 0, wasted: 0, value: 0, allowanceBps: limits.find(l => l.itemId === e.itemId)?.allowanceBps ?? null, excess: 0, percent: 0, over: false };
   if (e.kind === 'consume') row.used += e.quantity - e.returnedQuantity;
   if (e.kind === 'waste') { row.wasted += e.quantity; row.value += e.quantity * (e.unitRate ?? e.item.costPrice); }
   materials.set(e.itemId, row);
  }
  for (const row of materials.values()) {
   row.percent = row.used ? row.wasted / row.used * 100 : row.wasted ? 100 : 0;
   row.over = row.allowanceBps !== null && row.percent > row.allowanceBps / 100;
   row.excess = row.allowanceBps === null ? 0 : Math.round(Math.max(0, row.wasted - row.used * row.allowanceBps / 10000) * (row.wasted ? row.value / row.wasted : 0));
  }
  const wasted = entries.filter(e => e.kind === 'waste');
  return { materials: [...materials.values()], entries: wasted.map(e => ({ ...e, value: e.quantity * (e.unitRate ?? e.item.costPrice) })), total: [...materials.values()].reduce((n,m) => n + m.value, 0), excess: [...materials.values()].reduce((n,m) => n + m.excess, 0), chargeable: wasted.filter(e => e.chargeContractId && !e.chargeBillId).reduce((n,e) => n + e.quantity * (e.unitRate ?? e.item.costPrice), 0) };
 });
 return ok(res, result);
}));
router.put('/wastage/allowance', requireRoles('admin'), validateBody(wasteLimitSchema), asyncHandler(async (req, res) => {
 const a = requireProjectContext(req), b = wasteLimitSchema.parse(req.body);
 return ok(res, await financialTransaction(async tx => {
  if (!await tx.inventoryItem.findFirst({ where: { id: b.item_id, ...scope(a) } })) throw notFound('Project material not found');
  const old = await tx.constructionWasteLimit.findFirst({ where: { ...scope(a), itemId: b.item_id } });
  const row = old ? await tx.constructionWasteLimit.update({ where: { id: old.id }, data: { allowanceBps: b.allowance_bps } }) : await tx.constructionWasteLimit.create({ data: { ...scope(a), itemId: b.item_id, allowanceBps: b.allowance_bps } });
  await audit(tx, a, 'wastage.allowance_updated', 'construction_waste_limit', row.id, row);
  return row;
 }));
}));
export { router as siteRouter };
