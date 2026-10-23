import type { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../../core/http/api-error.js';
import { BUILTINS } from '../business-setup/contract.js';
import { entitySchema } from '../business-setup/service.js';
import type { Scope } from './document-settings.js';

export { formatItemDetail, selectedItemDetails, itemDetailsSchema } from './item-detail-fields.js';
import { formatItemDetail, type ItemDetails, type ItemDetailField, type ItemDetailValue } from './item-detail-fields.js';
type Line = { item_id?: string; source?: string; unit?: string; item_code?: string; model?: string; brand?: string; country?: string; item_details?: ItemDetailValue[] };
export async function documentItemFields(db: Prisma.TransactionClient, auth: Scope): Promise<ItemDetailField[]> {
  const schema = await entitySchema(db, auth, 'item');
  return [...BUILTINS.item.filter(f => f.key !== 'name').map(f => ({ key: f.key, label: f.key === 'quantity' ? 'Stock quantity' : f.label, type: f.type, ...(['cost_price', 'quantity', 'reorder_level'].includes(f.key) ? { internal: true } : {}) })), { key: 'category', label: 'Category', type: 'text' as const }, ...schema.fields.filter(f => !f.archived).map(f => ({ key: `attributes.${f.key}`, label: f.label, type: f.type }))];
}
export async function validateItemDetails(db: Prisma.TransactionClient, auth: Scope, config?: ItemDetails | null) {
  if (!config) return;
  const fields = await documentItemFields(db, auth), available = new Set(fields.map(f => f.key));
  if (Object.values(config).flat().some(key => !available.has(key))) throw badRequest('An item field is unavailable or archived. Reload item fields and update your selection.');
}
/** Only the server captures catalog properties. Existing document values survive later catalog edits. */
export async function snapshotItemDetails<T extends Line>(db: Prisma.TransactionClient, auth: Scope, lines: T[], config?: ItemDetails | null, previous?: { lines: unknown; presentationSnapshot: unknown }): Promise<(T & { item_details?: ItemDetailValue[] })[]> {
  if (!config) return lines.map(({ item_details: _ignored, ...line }) => line as T);
  const oldConfig = (previous?.presentationSnapshot as { itemDetails?: ItemDetails } | null)?.itemDetails;
  const sameConfig = JSON.stringify(config) === JSON.stringify(oldConfig);
  const oldLines = (Array.isArray(previous?.lines) ? previous.lines : []) as Line[];
  const matches = lines.map((line, index) => {
    if (!sameConfig || !line.item_id || line.source === 'external') return undefined;
    const old = oldLines[index]?.item_id === line.item_id ? oldLines[index] : oldLines.find(v => v.item_id === line.item_id);
    return old && Array.isArray(old.item_details) ? old.item_details : undefined;
  });
  if (matches.every(Boolean)) return lines.map((line, i) => ({ ...line, item_details: structuredClone(matches[i]!) }));
  const fields = await documentItemFields(db, auth), selected = new Set(Object.values(config).flat());
  const neededIds = [...new Set(lines.filter((l, i) => l.item_id && !matches[i] && l.source !== 'external').map(l => l.item_id!))];
  const items = neededIds.length ? await db.inventoryItem.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId, id: { in: neededIds }, isActive: true }, include: { category: true } }) : [];
  return lines.map((line, index) => {
    if (matches[index]) return { ...line, item_details: structuredClone(matches[index]!) };
    const item = items.find(i => i.id === line.item_id);
    if (line.item_id && line.source !== 'external' && !item) throw notFound('Catalog item not found');
    const details = fields.filter(f => selected.has(f.key)).flatMap(field => {
      let raw: unknown;
      if (item) {
        if (field.key.startsWith('attributes.')) raw = (item.attributes as Record<string, unknown> | null)?.[field.key.slice(11)];
        else if (field.key === 'category') raw = item.category?.name;
        else { const builtin = BUILTINS.item.find(b => b.key === field.key); raw = builtin ? (item as unknown as Record<string, unknown>)[builtin.property] : undefined; }
      } else {
        const external: Record<string, keyof Line> = { sku: 'item_code', unit: 'unit', 'attributes.model': 'model', 'attributes.brand': 'brand', 'attributes.country': 'country' };
        const property = external[field.key];
        raw = property ? line[property] : undefined;
      }
      const value = formatItemDetail(raw, field.type);
      return value ? [{ key: field.key, label: field.label, value }] : [];
    });
    return { ...line, item_details: details };
  });
}
