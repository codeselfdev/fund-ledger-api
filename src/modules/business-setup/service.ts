import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict } from '../../core/http/api-error.js';
import { BUILTINS, calculateTax, emptyTaxSetup, validateAttributes, type AdditionalCharge, type Attributes, type BusinessEntity, type TaxDocument, type TaxSelection, type TaxSetup, type TaxSnapshot, type EntitySchema } from './contract.js';
import { mapField, taxSetupSchema } from './validation.js';
export type Scope = { tenantId: string; projectId: string };
export const scope = (auth: Scope): Scope => ({ tenantId: auth.tenantId, projectId: auth.projectId });
export const json = (value: unknown) => value as Prisma.InputJsonValue;
export async function entitySchema(db: Prisma.TransactionClient, auth: Scope, entity: BusinessEntity): Promise<EntitySchema> {
  const [fields, config] = await Promise.all([db.businessField.findMany({ where: { ...scope(auth), entity }, orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] }), db.businessConfiguration.findFirst({ where: scope(auth) })]);
  const searches = config?.builtinSearch as Record<string, string[]> | undefined;
  return { entity, revision: config?.revision ?? 0, fields: fields.map(mapField), builtinSearch: searches?.[entity] ?? BUILTINS[entity].filter(b => ['name', 'mobile', 'phone', 'sku', 'email'].includes(b.key)).map(b => b.key) };
}
export async function attributesFor(db: Prisma.TransactionClient, auth: Scope, entity: BusinessEntity, values: Attributes = {}, existing: unknown = {}) {
  const schema = await entitySchema(db, auth, entity);
  try { return json(validateAttributes(schema.fields, values, (existing ?? {}) as Attributes)); } catch (e) { throw badRequest((e as Error).message); }
}
export async function taxSetup(db: Prisma.TransactionClient, auth: Scope): Promise<TaxSetup> {
  const config = await db.businessConfiguration.findFirst({ where: scope(auth) });
  return config?.taxSetup ? taxSetupSchema.parse(config.taxSetup) : emptyTaxSetup();
}
export async function documentTax(db: Prisma.TransactionClient, auth: Scope & { roles: string[] }, document: TaxDocument, amounts: number[], discount = 0, selection?: TaxSelection, manualTax = 0, previous?: unknown, charges: AdditionalCharge[] = []): Promise<TaxSnapshot | null> {
  const setup = await taxSetup(db, auth);
  const legacy = previous as { legacy?: boolean; tax?: number } | undefined;
  if (!selection && legacy?.legacy && manualTax === legacy.tax) {
    if (charges.some(charge => charge.vat_treatment === 'included' && charge.amount > 0)) throw badRequest('Apply configured tax rates before adding charges to the VAT base of a fixed-tax document.');
    return null;
  }
  // An unchanged draft selection retains its historical calculation, including archived rates.
  const old = previous as TaxSnapshot | undefined;
  if (old?.version === 1 && selection && selection.revision === old.revision && selection.rateId === old.selection.rateId && selection.withholdingId === old.selection.withholdingId && selection.inclusive === old.selection.inclusive && (selection.lineRateIds ?? []).every(id => [old.selection.rateId ?? null, ...(old.selection.lineRateIds ?? [])].includes(id))) {
    const historic: TaxSetup = { ...setup, revision: old.revision, registrationNumber: old.registrationNumber, showBreakdown: old.showBreakdown, rates: (old.rates ?? old.breakdown.map(r => ({ id: r.rateId, name: r.name, rateBps: r.rateBps, kind: r.kind, active: true, documents: [document] }))).map(r => ({ ...r, active: true, documents: [document] })), defaults: { ...setup.defaults, [document]: { rateId: old.selection.rateId ?? null, withholdingId: old.selection.withholdingId ?? null, inclusive: old.inclusive, level: old.level } } };
    try { return calculateTax(historic, document, amounts, discount, selection, charges); } catch (e) { throw badRequest((e as Error).message); }
  }
  if (!setup.rates.length && !selection) return null;
  if (manualTax) throw badRequest('Choose configured tax rates instead of entering a manual tax amount');
  if (selection && selection.revision !== setup.revision) throw conflict('Tax setup changed. Reload and review the document.');
  const admin = auth.roles.some(r => ['owner', 'admin'].includes(r));
  if (!setup.allowOverride && !admin && selection) {
    const defaults = calculateTax(setup, document, amounts, discount, {}, charges).selection;
    const chosen = calculateTax(setup, document, amounts, discount, selection, charges).selection;
    if (JSON.stringify(defaults) !== JSON.stringify(chosen)) throw badRequest('Your administrator has locked tax defaults');
  }
  try { return calculateTax(setup, document, amounts, discount, selection, charges); } catch (e) { throw badRequest((e as Error).message); }
}
export async function postTax(db: Prisma.TransactionClient, auth: Scope, sourceType: string, sourceId: string, snapshot: unknown, side: 'input' | 'output', reverse = false) {
  const tax = snapshot as TaxSnapshot | null;
  if (tax?.version !== 1) return;
  for (const row of tax.breakdown.filter(r => r.amount)) await db.businessTaxEntry.upsert({ where: { projectId_sourceType_sourceId_rateId_reversal: { projectId: auth.projectId, sourceType, sourceId, rateId: row.rateId, reversal: reverse } }, create: { ...scope(auth), sourceType, sourceId, rateId: row.rateId, name: row.name, kind: row.kind === 'withhold' ? side === 'input' ? 'withholding_payable' : 'withholding_receivable' : side, amount: row.amount * (reverse ? -1 : 1), base: row.base, rateBps: row.rateBps, reversal: reverse }, update: {} });
}
export async function lockSetup(db: Prisma.TransactionClient, auth: Scope) {
  // Row lock serializes schema writes, record validation, and import commits per project.
  await db.$queryRaw`SELECT id FROM projects WHERE id = ${auth.projectId} AND tenant_id = ${auth.tenantId} FOR UPDATE`;
}
export async function bumpRevision(db: Prisma.TransactionClient, auth: Scope) {
  return db.businessConfiguration.upsert({ where: { projectId: auth.projectId }, create: { ...scope(auth), revision: 1, builtinSearch: {} }, update: { revision: { increment: 1 } } });
}
