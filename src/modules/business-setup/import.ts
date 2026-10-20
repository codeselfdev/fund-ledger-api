import { phoneIdentitySql } from './phone.js';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { badRequest, conflict } from '../../core/http/api-error.js';
import { attributeValue, validateAttributes, businessPhoneIdentity, BUILTINS, fieldKey, choiceType, type BusinessEntity, type FieldDefinition, type ImportPreview, type ImportResult, type Attributes } from './contract.js';
import { fieldSchema, valueTypeSchema } from './validation.js';
import { builtinValues, saveRecord, table } from './records.js';
import { entitySchema, json, lockSetup, scope, bumpRevision, type Scope } from './service.js';
export const importSchema = z.object({
  entity: z.enum(['customer', 'dealer', 'item']), fileName: z.string().min(1).max(200), revision: z.number().int().min(0), policy: z.enum(['skip', 'update']),
  columns: z.array(z.object({ header: z.string().min(1).max(100), target: z.string().max(48), label: z.string().trim().min(1).max(80), type: valueTypeSchema, options: z.array(z.string().max(100)).max(100), searchable: z.boolean() }).strict()).min(1).max(100),
  rowNumbers: z.array(z.number().int().min(2).max(1048576)).max(2000).optional(),
  rows: z.array(z.array(z.string().max(2000)).max(100)).min(1).max(2000),
}).strict().refine(b => !b.rowNumbers || b.rowNumbers.length === b.rows.length && b.rowNumbers.every((n, i) => !i || n > b.rowNumbers![i - 1]), 'Invalid source row numbers');
type Payload = z.infer<typeof importSchema>;
export async function planImport(db: Prisma.TransactionClient, auth: Scope, body: Payload) {
  const schema = await entitySchema(db, auth, body.entity);
  if (schema.revision !== body.revision) throw conflict('Fields changed. Match columns again.');
  const targets = body.columns.filter(c => c.target !== 'skip').map(c => c.target);
  if (new Set(targets).size !== targets.length) throw badRequest('Map each destination only once');
  if (!targets.includes('name')) throw badRequest('Map a Name column before importing');
  if (body.rows.some(r => r.length > body.columns.length)) throw badRequest('A row has more cells than headers');
  const newFields: FieldDefinition[] = [];
  for (const [i, c] of body.columns.entries()) {
    if (c.target === 'skip' || BUILTINS[body.entity].some(b => b.key === c.target)) continue;
    const existing = schema.fields.find(f => f.key === c.target);
    if (existing?.archived) throw badRequest(`${c.header}: this field is archived; choose another destination`);
    if (existing) continue;
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(c.target) || fieldKey(c.target) !== c.target || BUILTINS[body.entity].some(b => b.property === c.target)) throw badRequest('Use a stable field key with letters, digits and underscores');
    const options = choiceType(c.type) ? [...new Set(body.rows.flatMap(row => c.type === 'multi_select' ? (row[i] ?? '').split(',') : [row[i] ?? '']).map(v => v.trim()).filter(Boolean))] : [];
    const value = fieldSchema.parse({ key: c.target, label: c.label, type: c.type, searchable: c.searchable, options, filterable: c.type !== 'long_text', showInList: false, position: schema.fields.length + newFields.length });
    newFields.push({ ...value, id: '' });
  }
  if (schema.fields.filter(f => !f.archived).length + newFields.length > 100) throw badRequest('At most 100 active fields per entity');
  const fields = [...schema.fields, ...newFields];
  const issues: ImportPreview['issues'] = [], seen = new Set<string>(), seenNames = new Set<string>();
  const naturalKey = body.entity === 'item' ? 'sku' : body.entity === 'customer' ? 'mobile' : 'phone';
  const keyColumn = body.columns.findIndex(c => c.target === naturalKey);
  const normalize = (v: string) => body.entity === 'item' ? v.trim() : businessPhoneIdentity(v);
  const keys = [...new Set(body.rows.map(row => normalize(row[keyColumn] ?? '')).filter(Boolean))];
  const names = body.entity === 'dealer' ? [...new Set(body.rows.map(row => (row[body.columns.findIndex(c => c.target === 'name')] ?? '').trim()))] : [];
  const matches = keys.length || names.length ? await db.$queryRaw<{ id: string; identity: string; name: string; attributes: Attributes }[]>(Prisma.sql`SELECT id, name, attributes, ${body.entity === 'item' ? Prisma.sql`sku` : phoneIdentitySql(body.entity === 'customer' ? 'mobile' : 'phone')} AS identity FROM ${Prisma.raw(table[body.entity])} WHERE tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} AND (${keys.length ? Prisma.sql`${body.entity === 'item' ? Prisma.sql`sku` : phoneIdentitySql(body.entity === 'customer' ? 'mobile' : 'phone')} IN (${Prisma.join(keys)})` : Prisma.sql`false`}${names.length ? Prisma.sql` OR name IN (${Prisma.join(names)})` : Prisma.sql``})`) : [];
  const byKey = new Map<string, typeof matches>();
  for (const record of matches) { const list = byKey.get(record.identity) ?? []; list.push(record); byKey.set(record.identity, list); }
  const rows: { builtins: Record<string, unknown>; attributes: Record<string, unknown>; existingId?: string; skip: boolean }[] = [];
  let added = 0, updated = 0, skipped = 0;
  for (const [index, cells] of body.rows.entries()) {
    const builtins: Record<string, unknown> = {}, attributes: Record<string, unknown> = {};
    for (const [i, column] of body.columns.entries()) {
      if (column.target === 'skip') continue;
      const builtin = BUILTINS[body.entity].find(b => b.key === column.target), field = fields.find(f => f.key === column.target)!;
      try { const value = attributeValue(builtin?.type ?? field.type, cells[i], builtin ? [] : field.options); if (builtin) builtins[builtin.key] = value; else attributes[field.key] = value; }
      catch (e) { issues.push({ row: body.rowNumbers?.[index] ?? index + 2, column: column.header, message: (e as Error).message }); }
    }
    let existingId: string | undefined;
    const keyValue = normalize(String(builtins[naturalKey] ?? ''));
    if (keyValue) {
      if (seen.has(keyValue)) issues.push({ row: body.rowNumbers?.[index] ?? index + 2, column: naturalKey, message: 'Duplicate identity in this file' });
      seen.add(keyValue);
      const identities = byKey.get(keyValue) ?? [];
      if (identities.length > 1) issues.push({ row: body.rowNumbers?.[index] ?? index + 2, column: naturalKey, message: 'Several saved records have this identity; resolve them first' });
      existingId = identities[0]?.id;
      builtins[naturalKey] = keyValue;
    }
    const skip = !!existingId && body.policy === 'skip';
    if (existingId && body.entity === 'item') delete builtins.quantity; // Imports never overwrite existing stock.
    try { builtinValues(body.entity, builtins, !!existingId); } catch (e) { issues.push({ row: body.rowNumbers?.[index] ?? index + 2, column: 'Built-in fields', message: (e as Error).message }); }
    if (body.entity === 'dealer' && !skip) {
      const name = String(builtins.name ?? '');
      if (seenNames.has(name) || matches.some(r => r.name === name && r.id !== existingId)) issues.push({ row: body.rowNumbers?.[index] ?? index + 2, column: 'Name', message: 'A dealer with this name already exists or appears twice in the file' });
      seenNames.add(name);
    }
    if (!skip) try { validateAttributes(fields, attributes as Attributes, matches.find(r => r.id === existingId)?.attributes ?? {}); } catch (e) { issues.push({ row: body.rowNumbers?.[index] ?? index + 2, column: 'Additional fields', message: (e as Error).message }); }

    if (skip) skipped++; else if (existingId) updated++; else added++;
    rows.push({ builtins, attributes, existingId, skip });
  }
  return { rows, newFields, fields, summary: { total: body.rows.length, added, updated, skipped, newFields: newFields.map(f => ({ label: f.label, type: f.type })), issues: issues.slice(0, 200), sample: rows.slice(0, 5).map(r => ({ ...r.builtins, ...r.attributes })), sampleRowNumbers: rows.slice(0, 5).map((_, i) => body.rowNumbers?.[i] ?? i + 2) } };
}
export async function commitImport(db: Prisma.TransactionClient, auth: Scope & { userId: string }, id: string): Promise<ImportResult> {
  await lockSetup(db, auth);
  const job = await db.businessImport.findFirst({ where: { id, ...scope(auth), createdById: auth.userId } });
  if (!job) throw badRequest('Import review not found');
  if (job.status === 'committed') return job.result as unknown as ImportResult;
  if (job.expiresAt < new Date()) throw conflict('This review expired. Preview the file again.');
  const body = importSchema.parse(job.payload);
  const plan = await planImport(db, auth, body);
  if (plan.summary.issues.length) throw badRequest('Fix the highlighted cells before importing', { issues: plan.summary.issues });
  // Duplicate state can change while the user reviews. A changed plan requires a fresh review.
  const previous = job.preview as { added: number; updated: number; skipped: number; identities: (string | null)[] };
  if (JSON.stringify(previous.identities) !== JSON.stringify(plan.rows.map(r => r.existingId ?? null))) throw conflict('Saved records changed. Review the import again.');
  for (const { id: _id, ...f } of plan.newFields) await db.businessField.create({ data: { ...scope(auth), entity: body.entity, ...f, options: json(f.options) } });
  for (const row of plan.rows) if (!row.skip) await saveRecord(db, auth, body.entity, { ...row.builtins, attributes: row.attributes }, row.existingId, plan.fields);
  if (plan.newFields.length) await bumpRevision(db, auth);
  const result = { added: plan.summary.added, updated: plan.summary.updated, skipped: plan.summary.skipped, fieldsCreated: plan.newFields.length };
  await db.businessImport.update({ where: { id }, data: { status: 'committed', result, payload: {}, preview: {} } });
  await db.activity.create({ data: { ...scope(auth), actorUserId: auth.userId, action: 'business.import.committed', entityType: body.entity, entityId: id, after: result } });
  return result;
}
