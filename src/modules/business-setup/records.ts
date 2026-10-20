import { openingStock } from '../inventory/stock.service.js';
import { Prisma } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { BUILTINS, attributeValue, type BusinessEntity, businessPhoneIdentity, type Attributes, type FieldDefinition, validateAttributes } from './contract.js';
import { attributesFor, scope, json, type Scope } from './service.js';
export const table = { customer: 'customers', dealer: 'vendors', item: 'inventory_items' } as const;
export async function findRecord(db: Prisma.TransactionClient, auth: Scope, entity: BusinessEntity, id: string) {
  const where = { ...scope(auth), id };
  if (entity === 'customer') return db.customer.findFirst({ where });
  if (entity === 'dealer') return db.vendor.findFirst({ where });
  return db.inventoryItem.findFirst({ where });
}
export function builtinValues(entity: BusinessEntity, raw: Record<string, unknown>, editing = false) {
  const result: Record<string, string | number | null> = {};
  const allowed = new Set([...BUILTINS[entity].map(b => b.key), 'attributes']);
  if (Object.keys(raw).some(k => !allowed.has(k))) throw badRequest('Unknown built-in field');
  for (const b of BUILTINS[entity]) {
    if (editing && !(b.key in raw)) continue;
    if (editing && entity === 'item' && b.key === 'quantity') throw badRequest('Use stock adjustments to change existing stock');
    let value;
    try { value = attributeValue(b.type, raw[b.key]); } catch (e) { throw badRequest(`${b.label}: ${(e as Error).message}`); }
    if (b.type === 'phone' && typeof value === 'string') value = businessPhoneIdentity(value);
    if (b.required && (value == null || String(value).length < 2)) throw badRequest(`${b.label} needs at least 2 characters`);
    if (b.max && value != null && String(value).length > b.max) throw badRequest(`${b.label} is too long`);
    if (entity === 'item' && ['cost_price', 'sell_price', 'quantity', 'reorder_level'].includes(b.key)) {
      value = value ?? 0;
      if (!Number.isInteger(value) || Number(value) < 0) throw badRequest(`${b.label} must be a non-negative whole number`);
    }
    if (entity === 'item' && b.key === 'unit') value = value ?? 'pcs';
    result[b.property] = value as string | number | null;
  }
  return result;
}
export async function saveRecord(db: Prisma.TransactionClient, auth: Scope & { userId: string }, entity: BusinessEntity, raw: Record<string, unknown>, id?: string, fields?: FieldDefinition[]) {
  const before = id ? await findRecord(db, auth, entity, id) : null;
  if (id && !before) throw notFound('Record not found');
  const builtins = builtinValues(entity, raw, !!id);
  let attributes: Prisma.InputJsonValue;
  try { attributes = fields ? json(validateAttributes(fields, (raw.attributes ?? {}) as Attributes, (before?.attributes ?? {}) as Attributes)) : await attributesFor(db, auth, entity, raw.attributes as Attributes | undefined, before?.attributes); } catch (e) { throw badRequest((e as Error).message); }
  let row;
  if (entity === 'customer') {
    const data = { ...builtins, attributes } as Prisma.CustomerUncheckedCreateInput;
    row = id ? await db.customer.update({ where: { id }, data }) : await db.customer.create({ data: { ...data, ...scope(auth) } });
  } else if (entity === 'dealer') {
    const data = { ...builtins, attributes } as Prisma.VendorUncheckedCreateInput;
    if (data.name && await db.vendor.findFirst({ where: { ...scope(auth), name: data.name, ...(id ? { NOT: { id } } : {}) } })) throw conflict('A dealer with this name already exists');
    row = id ? await db.vendor.update({ where: { id }, data }) : await db.vendor.create({ data: { ...data, ...scope(auth) } });
  } else {
    const data = { ...builtins, attributes } as Prisma.InventoryItemUncheckedCreateInput;
    if (data.sku && await db.inventoryItem.findFirst({ where: { ...scope(auth), sku: data.sku, ...(id ? { NOT: { id } } : {}) } })) throw conflict('An item with this SKU already exists');
    row = id ? await db.inventoryItem.update({ where: { id }, data }) : await db.inventoryItem.create({ data: { ...data, ...scope(auth) } });
    if (!id) await openingStock(db, auth, row);
  }
  return row;
}
