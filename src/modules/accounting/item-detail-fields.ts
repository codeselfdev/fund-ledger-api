import { z } from 'zod';
import type { ValueType } from '../business-setup/contract.js';

const keys = z.array(z.string().min(1).max(100)).max(20).refine(v => new Set(v).size === v.length, 'Choose each item field once');
export const itemDetailsSchema = z.object({ quotation: keys, order: keys, sale: keys }).strict();
export type ItemDetails = z.infer<typeof itemDetailsSchema>;
export interface ItemDetailField { key: string; label: string; type: ValueType; internal?: boolean }
export interface ItemDetailValue { key: string; label: string; value: string }
export function formatItemDetail(value: unknown, type: ValueType): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean).join(', ');
  if (type === 'boolean' && typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).trim();
}
/** The document choice changes Description only; other configured properties keep their order. */
export function descriptionItemDetails(config: ItemDetails | null | undefined, includeDescription?: boolean): ItemDetails | null | undefined {
  if (includeDescription !== true) return config;
  const withDescription = (keys: string[] = []) => keys.includes('description') ? keys : [...keys, 'description'];
  return { quotation: withDescription(config?.quotation), order: withDescription(config?.order), sale: withDescription(config?.sale) };
}
export function selectedItemDetails(line: { item_details?: ItemDetailValue[] }, config: ItemDetails | null | undefined, kind: string, includeDescription?: boolean): ItemDetailValue[] {
  const configured = config?.[kind as keyof ItemDetails] ?? [];
  const showDescription = includeDescription ?? configured.includes('description');
  const keys = [...(showDescription ? ['description'] : []), ...configured.filter(key => key !== 'description')];
  return keys.flatMap(key => { const value = line.item_details?.find(v => v.key === key); return value && value.value.trim() ? [value] : []; });
}
