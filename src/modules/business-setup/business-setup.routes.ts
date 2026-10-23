import { financialTransaction } from '../accounting/transaction.js';
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, notFound, forbidden } from '../../core/http/api-error.js';
import { ok, created } from '../../core/http/response.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { BUILTINS, attributeValue, emptyTaxSetup } from './contract.js';
import { attributeSchema, entitySchema as entityParam, fieldSchema, mapField, taxSetupSchema } from './validation.js';
import { entitySchema, taxSetup, scope, json, lockSetup, bumpRevision } from './service.js';
import { saveRecord, table } from './records.js';
import { importSchema, planImport, commitImport } from './import.js';
import { previewFieldConversion, convertFieldValues } from './field-conversion.js';
import { valueTypeSchema } from './validation.js';
import { recordLogosRouter, withBusinessLogos } from './record-logos.js';
const router = Router();
router.use(requireProject, requireRoles('accountant', 'cashier', 'approver', 'auditor', 'staff'));
router.use('/entities/:entity/records/:id/logo', recordLogosRouter);
const admin = requireRoles('admin');
const writer = requireRoles('accountant', 'cashier');
const audit = async (db: Prisma.TransactionClient, auth: ReturnType<typeof requireProjectContext>, action: string, entityId: string, detail: unknown) => db.activity.create({ data: { ...scope(auth), actorUserId: auth.userId, action, entityType: 'business_setup', entityId, after: json(detail) } });
router.get('/entities/:entity/schema', asyncHandler(async (req, res) => ok(res, await entitySchema(prisma, requireProjectContext(req), entityParam.parse(req.params.entity)))));
router.post('/entities/:entity/fields', admin, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entityParam.parse(req.params.entity), body = z.object({ revision: z.number().int(), field: fieldSchema }).strict().parse(req.body);
  const field = await prisma.$transaction(async db => {
    await lockSetup(db, auth);
    const schema = await entitySchema(db, auth, entity);
    if (schema.revision !== body.revision) throw conflict('Settings changed. Reload before saving.');
    if (BUILTINS[entity].some(b => b.key === body.field.key || b.property === body.field.key) || schema.fields.some(f => f.key === body.field.key)) throw conflict('This field key is already reserved');
    if (schema.fields.filter(f => !f.archived).length >= 100) throw badRequest('At most 100 active fields per entity');
    const row = await db.businessField.create({ data: { ...scope(auth), entity, ...body.field, options: json(body.field.options) } });
    await bumpRevision(db, auth); await audit(db, auth, 'business.field.created', row.id, row); return mapField(row);
  }); return created(res, field);
}));
router.post('/entities/:entity/fields/:id/conversion-preview', admin, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entityParam.parse(req.params.entity);
  const body = z.object({ revision: z.number().int(), type: valueTypeSchema }).strict().parse(req.body);
  const preview = await prisma.$transaction(async db => {
    await lockSetup(db, auth);
    const schema = await entitySchema(db, auth, entity), field = schema.fields.find(f => f.id === req.params.id);
    if (!field) throw notFound('Field not found');
    if (schema.revision !== body.revision) throw conflict('Settings changed. Reload before changing the type.');
    return previewFieldConversion(db, auth, entity, field, body.type, schema.revision);
  }, { timeout: 60000 });
  return ok(res, preview);
}));
router.patch('/entities/:entity/fields/:id', admin, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entityParam.parse(req.params.entity), body = z.object({ revision: z.number().int(), field: fieldSchema }).strict().parse(req.body);
  const field = await prisma.$transaction(async db => {
    await lockSetup(db, auth);
    const schema = await entitySchema(db, auth, entity), before = schema.fields.find(f => f.id === req.params.id);
    if (!before) throw notFound('Field not found');
    if (schema.revision !== body.revision) throw conflict('Settings changed. Reload before saving.');
    if (before.archived && !body.field.archived && schema.fields.filter(f => !f.archived).length >= 100) throw badRequest('At most 100 active fields per entity');
    if (before.key !== body.field.key) throw badRequest('Saved field keys cannot change.');
    if (before.options.some(o => !body.field.options.includes(o))) throw badRequest('Keep existing choices to preserve saved values. You can add choices.');
    let convertedRecords = 0;
    if (before.type !== body.field.type) {
      const preview = await previewFieldConversion(db, auth, entity, before, body.field.type, schema.revision);
      if (preview.options.some(option => !body.field.options.includes(option))) throw conflict('Saved values changed or used choices were removed. Reload choices and try again.');
      convertedRecords = await convertFieldValues(db, auth, entity, before, body.field.type);
    }
    const row = await db.businessField.update({ where: { id: before.id }, data: { ...body.field, options: json(body.field.options) } });
    await bumpRevision(db, auth); await audit(db, auth, body.field.archived ? 'business.field.archived' : 'business.field.updated', row.id, { before, after: row, convertedRecords }); return mapField(row);
  }, { timeout: 60000 }); return ok(res, field);
}));
router.put('/entities/:entity/search', admin, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entityParam.parse(req.params.entity), body = z.object({ revision: z.number().int(), builtinSearch: z.array(z.string()).max(10), fields: z.array(z.object({ id: z.string(), searchable: z.boolean(), match: z.enum(['contains', 'exact', 'starts_with']), filterable: z.boolean(), showInList: z.boolean(), position: z.number().int().min(0).max(1000) }).strict()).max(100) }).strict().parse(req.body);
  await prisma.$transaction(async db => {
    await lockSetup(db, auth); const schema = await entitySchema(db, auth, entity);
    if (schema.revision !== body.revision) throw conflict('Settings changed. Reload before saving.');
    if (!body.builtinSearch.includes('name') || body.builtinSearch.some(k => !BUILTINS[entity].some(b => b.key === k))) throw badRequest('Name must stay searchable; use built-in keys only');
    if (new Set(body.fields.map(f => f.id)).size !== body.fields.length) throw badRequest('Duplicate field');
    for (const f of body.fields) { const before = schema.fields.find(x => x.id === f.id && !x.archived); if (!before) throw badRequest('Unknown field'); const { id: _id, ...settings } = before; const { id: _fieldId, ...searchSettings } = f; fieldSchema.parse({ ...settings, ...searchSettings }); await db.businessField.update({ where: { id: f.id }, data: { searchable: f.searchable, match: f.match, filterable: f.filterable, showInList: f.showInList, position: f.position } }); }
    const config = await bumpRevision(db, auth); await db.businessConfiguration.update({ where: { id: config.id }, data: { builtinSearch: { ...(config.builtinSearch as object), [entity]: body.builtinSearch } } });
    await audit(db, auth, 'business.search.updated', auth.projectId, body);
  }); return ok(res, await entitySchema(prisma, auth, entity));
}));
const searchSchema = z.object({ categoryId: z.string().nullable().optional(), lowStock: z.boolean().optional(), search: z.string().trim().max(200).default(''), offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(100).default(50), filters: z.array(z.object({ key: z.string().max(48), operator: z.enum(['eq', 'contains', 'gte', 'lte', 'in']), value: z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.array(z.string()).max(100), z.null()]) }).strict()).max(20).default([]) }).strict();
router.post('/entities/:entity/query', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entityParam.parse(req.params.entity), query = searchSchema.parse(req.body), schema = await entitySchema(prisma, auth, entity);
  const clauses: Prisma.Sql[] = [Prisma.sql`tenant_id = ${auth.tenantId}`, Prisma.sql`project_id = ${auth.projectId}`, Prisma.sql`is_active = true`];
  if (entity === 'item' && query.categoryId) clauses.push(Prisma.sql`category_id = ${query.categoryId}`);
  if (entity === 'item' && query.lowStock) clauses.push(Prisma.sql`quantity <= reorder_level`);
  const escaped = (v: string) => v.replace(/[\\%_]/g, '\\$&');
  if (query.search) {
    const term = query.search.toLowerCase();
    const parts = schema.builtinSearch.map(k => BUILTINS[entity].find(b => b.key === k)!).filter(Boolean).map(b => Prisma.sql`lower(${Prisma.raw(b.key)}::text) LIKE ${'%' + escaped(term) + '%'}`);
    for (const f of schema.fields.filter(f => !f.archived && f.searchable)) {
      const value = f.type === 'multi_select' ? Prisma.sql`lower(choice.value)` : Prisma.sql`lower(attributes ->> ${f.key})`;
      const match = f.match === 'exact' ? Prisma.sql`${value} = ${term}` : Prisma.sql`${value} LIKE ${f.match === 'starts_with' ? escaped(term) + '%' : '%' + escaped(term) + '%'}`;
      parts.push(f.type === 'multi_select' ? Prisma.sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(attributes -> ${f.key}) = 'array' THEN attributes -> ${f.key} ELSE '[]'::jsonb END) AS choice(value) WHERE ${match})` : match);
    }
    clauses.push(Prisma.sql`(${Prisma.join(parts, ' OR ')})`);
  }
  for (const filter of query.filters) {
    const f = schema.fields.find(f => f.key === filter.key && f.filterable && !f.archived);
    if (!f) throw badRequest('Unknown or disabled filter');
    const type = f.type, v = filter.value;
    if (['gte', 'lte'].includes(filter.operator) && !['number', 'money', 'date'].includes(type)) throw badRequest('Range is unavailable for this type');
    if (filter.operator === 'in' && (!Array.isArray(v) || !['select', 'multi_select'].includes(type))) throw badRequest('Use choices with this filter');
    if (filter.operator === 'contains' && !['text', 'long_text', 'phone', 'email'].includes(type)) throw badRequest('Contains is unavailable for this type');
    const text = Prisma.sql`attributes ->> ${f.key}`;
    if (filter.operator === 'in') {
      const values = v as string[];
      if (!values.length || values.some(x => !f.options.includes(x))) throw badRequest('Choose valid options');
      clauses.push(Prisma.sql`(${Prisma.join(values.map(value => Prisma.sql`attributes @> ${JSON.stringify({ [f.key]: type === 'multi_select' ? [value] : value })}::jsonb`), ' OR ')})`);
    } else if (filter.operator === 'contains') clauses.push(Prisma.sql`lower(${text}) LIKE ${'%' + escaped(String(v).toLowerCase()) + '%'}`);
    else {
      if (type === 'multi_select') throw badRequest('Use the in operator for multiple choices');
      try { attributeValue(type, v, f.options); } catch (e) { throw badRequest((e as Error).message); }
      if (type === 'number' || type === 'money') { if (typeof v !== 'number') throw badRequest('Use a numeric filter value'); }
      else if (type === 'boolean') { if (typeof v !== 'boolean') throw badRequest('Use a boolean filter value'); }
      else if (typeof v !== 'string') throw badRequest('Use a text filter value');
      const lhs = ['number', 'money'].includes(type) ? Prisma.sql`(${text})::numeric` : text;
      const rhs = ['number', 'money'].includes(type) ? v : String(v);
      clauses.push(filter.operator === 'gte' ? Prisma.sql`${lhs} >= ${rhs}` : filter.operator === 'lte' ? Prisma.sql`${lhs} <= ${rhs}` : Prisma.sql`attributes @> ${JSON.stringify({ [f.key]: v })}::jsonb`);
    }
  }
  // Identifiers come exclusively from the static allowlist, all user values are bound parameters.
  const ids = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM ${Prisma.raw(table[entity])} WHERE ${Prisma.join(clauses, ' AND ')} ORDER BY name, id LIMIT ${query.limit + 1} OFFSET ${query.offset}`);
  const where = { ...scope(auth), id: { in: ids.slice(0, query.limit).map(r => r.id) } };
  const rows = entity === 'customer' ? await prisma.customer.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }] }) : entity === 'dealer' ? await prisma.vendor.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }] }) : await prisma.inventoryItem.findMany({ where, include: { category: { select: { name: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  return ok(res, { entries: entity === 'item' ? rows : await withBusinessLogos<(typeof rows)[number]>(rows, auth, entity), nextOffset: ids.length > query.limit ? query.offset + query.limit : null });
}));
const recordBody = z.record(z.unknown()).refine(v => !('attributes' in v) || attributeSchema.safeParse(v.attributes).success, 'Invalid attributes');
for (const method of ['post', 'patch'] as const) router[method](`/entities/:entity/records${method === 'patch' ? '/:id' : ''}`, writer, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entityParam.parse(req.params.entity);
  if (entity !== 'customer' && !auth.roles.some(r => ['owner', 'admin', 'accountant'].includes(r))) throw forbidden('Only administrators and accountants can edit dealers and items');
  if (entity === 'customer' && !auth.roles.some(r => ['owner', 'admin', 'accountant'].includes(r)) && (await prisma.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId } }))?.projectType === 'billing') throw forbidden('Only administrators and accountants can edit billing customers');
  const row = await prisma.$transaction(async db => { await lockSetup(db, auth); const record = await saveRecord(db, auth, entity, recordBody.parse(req.body), req.params.id); await audit(db, auth, 'business.record.saved', record.id, { entity }); return record; }); return ok(res, row);
}));
router.post('/imports/preview', admin, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), body = importSchema.parse(req.body);
  const preview = await prisma.$transaction(async db => {
    await lockSetup(db, auth); const plan = await planImport(db, auth, body); const expiresAt = new Date(Date.now() + 30 * 60000);
    // Expired previews contain contact data and are cleared on the next import operation.
    await db.businessImport.updateMany({ where: { ...scope(auth), expiresAt: { lt: new Date() }, status: 'preview' }, data: { status: 'expired', payload: {}, preview: {} } });
    const job = await db.businessImport.create({ data: { ...scope(auth), entity: body.entity, createdById: auth.userId, payload: json(body), revision: body.revision, preview: json({ ...plan.summary, identities: plan.rows.map(r => r.existingId ?? null) }), expiresAt } });
    return { id: job.id, expiresAt: expiresAt.toISOString(), ...plan.summary };
  }, { timeout: 60000 }); return created(res, preview);
}));
router.post('/imports/:id/commit', admin, asyncHandler(async (req, res) => ok(res, await financialTransaction(db => commitImport(db, requireProjectContext(req), req.params.id), 60000))));
router.get('/tax', asyncHandler(async (req, res) => ok(res, await taxSetup(prisma, requireProjectContext(req)))));
router.put('/tax', admin, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), body = taxSetupSchema.parse(req.body);
  const saved = await prisma.$transaction(async db => {
    await lockSetup(db, auth); const before = await taxSetup(db, auth);
    if (body.revision !== before.revision) throw conflict('Tax setup changed. Reload before saving.');
    const value = { ...body, revision: before.revision + 1 };
    await db.businessConfiguration.upsert({ where: { projectId: auth.projectId }, create: { ...scope(auth), taxSetup: json(value), builtinSearch: {} }, update: { taxSetup: json(value) } });
    await audit(db, auth, 'business.tax.updated', auth.projectId, { before, after: value }); return value;
  }); return ok(res, saved);
}));
export { router as businessSetupRouter };
