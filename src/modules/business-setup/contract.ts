/** Shared wire contract and deterministic validation. Mirrored in the API module. */
export type BusinessEntity = 'customer' | 'dealer' | 'item';
export type ValueType = 'text' | 'long_text' | 'number' | 'money' | 'date' | 'boolean' | 'select' | 'multi_select' | 'phone' | 'email';
export type AttributeValue = string | number | boolean | string[] | null;
export type Attributes = Record<string, AttributeValue>;
export interface FieldDefinition {
  id: string; key: string; label: string; type: ValueType; options: string[];
  required: boolean; searchable: boolean; match: 'contains' | 'exact' | 'starts_with';
  filterable: boolean; showInList: boolean; position: number; archived: boolean;
}
export interface EntitySchema { entity: BusinessEntity; revision: number; fields: FieldDefinition[]; builtinSearch: string[] }
export interface BusinessRecord { id: string; name: string; attributes?: Attributes; [key: string]: unknown }
export const ENTITIES: Record<BusinessEntity, string> = { customer: 'Customers', dealer: 'Dealers', item: 'Items' };
export const VALUE_TYPES: { key: ValueType; label: string; glyph: string; hint: string }[] = [
  { key: 'text', label: 'Text', glyph: 'Aa', hint: 'Names, codes & IDs' }, { key: 'long_text', label: 'Long text', glyph: '¶', hint: 'Notes & descriptions' },
  { key: 'number', label: 'Number', glyph: '#', hint: 'Quantities & measures' }, { key: 'money', label: 'Money', glyph: '৳', hint: 'Amounts' },
  { key: 'date', label: 'Date', glyph: '▦', hint: 'YYYY-MM-DD' }, { key: 'boolean', label: 'Yes / No', glyph: '✓', hint: 'A simple switch' },
  { key: 'select', label: 'Single choice', glyph: '◉', hint: 'Choose one option' }, { key: 'multi_select', label: 'Multiple choices', glyph: '☷', hint: 'Choose several' },
  { key: 'phone', label: 'Phone', glyph: '☎', hint: 'Keep country code' }, { key: 'email', label: 'Email', glyph: '@', hint: 'Email address' },
];
export interface BuiltinField { key: string; property: string; label: string; type: ValueType; required?: boolean; max?: number; aliases?: string[] }
export const BUILTINS: Record<BusinessEntity, BuiltinField[]> = {
  customer: [ { key: 'name', property: 'name', label: 'Name', type: 'text', required: true, max: 120, aliases: ['customer', 'customer name'] }, { key: 'mobile', property: 'mobile', label: 'Mobile', type: 'phone', aliases: ['phone', 'phone number'] }, { key: 'email', property: 'email', label: 'Email', type: 'email', max: 200 }, { key: 'address', property: 'address', label: 'Address', type: 'long_text', max: 500 } ],
  dealer: [ { key: 'name', property: 'name', label: 'Name', type: 'text', required: true, max: 120, aliases: ['dealer', 'dealer name', 'vendor', 'supplier'] }, { key: 'phone', property: 'phone', label: 'Phone', type: 'phone', aliases: ['mobile', 'phone number'] }, { key: 'email', property: 'email', label: 'Email', type: 'email', max: 200 }, { key: 'address', property: 'address', label: 'Address', type: 'long_text', max: 255 }, { key: 'notes', property: 'notes', label: 'Notes', type: 'long_text', max: 2000 } ],
  item: [ { key: 'name', property: 'name', label: 'Name', type: 'text', required: true, max: 120, aliases: ['item', 'item name', 'product', 'description'] }, { key: 'sku', property: 'sku', label: 'SKU', type: 'text', max: 64, aliases: ['item code', 'product code'] }, { key: 'unit', property: 'unit', label: 'Unit', type: 'text', max: 16 }, { key: 'cost_price', property: 'costPrice', label: 'Cost price', type: 'money', aliases: ['cost', 'unit cost'] }, { key: 'sell_price', property: 'sellPrice', label: 'Selling price', type: 'money', aliases: ['price', 'sale price'] }, { key: 'quantity', property: 'quantity', label: 'Opening quantity', type: 'number', aliases: ['stock', 'qty'] }, { key: 'reorder_level', property: 'reorderLevel', label: 'Reorder level', type: 'number' } ],
};
export const keywordType = (type: ValueType) => ['text', 'long_text', 'phone', 'email', 'select', 'multi_select'].includes(type);
export const choiceType = (type: ValueType) => type === 'select' || type === 'multi_select';
export function fieldKey(label: string) { return label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48); }
export function validDate(value: string) { const date = new Date(value + 'T00:00:00Z'); return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }
export function attributeValue(type: ValueType, raw: unknown, options: string[] = []): AttributeValue {
  if (raw == null || raw === '' || Array.isArray(raw) && !raw.length) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (value.length > 2000) throw new Error('Use at most 2,000 characters');
  if (type === 'number' || type === 'money') {
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 2147483647) throw new Error('Enter a valid number (no currency signs or separators)');
    if (type === 'money' && (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(value) || Number(value) < 0)) throw new Error('Enter a non-negative amount with up to two decimals');
    return Number(value);
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (/^(yes|true|1)$/i.test(value)) return true;
    if (/^(no|false|0)$/i.test(value)) return false;
    throw new Error('Use Yes / No, True / False, or 1 / 0');
  }
  if (type === 'date' && !validDate(value)) throw new Error('Use a valid date in YYYY-MM-DD format');
  if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('Enter a valid email address');
  if (type === 'phone' && !/^\+?[\d\s()\-]{5,32}$/.test(value)) throw new Error('Enter a valid phone number');
  if (type === 'multi_select') {
    const values = [...new Set((Array.isArray(raw) ? raw : value.split(',')).map(v => String(v).trim()).filter(Boolean))];
    if (values.some(v => !options.includes(v))) throw new Error('Choose from the configured options');
    return values;
  }
  if (type === 'select' && !options.includes(value)) throw new Error('Choose from the configured options');
  if (type === 'text' && value.length > 500) throw new Error('Use at most 500 characters');
  return value;
}
export function validateAttributes(fields: FieldDefinition[], raw: Attributes, existing: Attributes = {}): Attributes {
  const result: Attributes = { ...existing };
  for (const [key, value] of Object.entries(raw)) {
    const field = fields.find(f => f.key === key && !f.archived);
    if (!field) throw new Error(`Unknown or archived field: ${key}`);
    result[key] = attributeValue(field.type, value, field.options);
  }
  for (const field of fields.filter(f => !f.archived && f.required)) if (result[field.key] == null || result[field.key] === '') throw new Error(`${field.label} is required`);
  return result;
}
export function inferType(values: string[]): ValueType {
  const populated = values.filter(v => v.trim());
  if (!populated.length) return 'text';
  // IDs with leading zeroes stay text. Phone numbers are never guessed as numbers.
  for (const type of ['boolean', 'date', 'email', 'number'] as ValueType[]) {
    if (type === 'number' && populated.some(v => /^0\d|^\+/.test(v))) continue;
    if (populated.every(v => { try { attributeValue(type, v); return true; } catch { return false; } })) return type;
  }
  return 'text';
}
export type FilterOperator = 'eq' | 'contains' | 'gte' | 'lte' | 'in';
export interface AttributeFilter { key: string; operator: FilterOperator; value: AttributeValue }
export interface ImportColumn { header: string; target: string; label: string; type: ValueType; options: string[]; searchable: boolean }
export interface ImportDraft { fileName: string; headers: string[]; rows: string[][]; rowNumbers?: number[]; columns: ImportColumn[]; sourceSheet?: string }
export interface ImportPreview { id: string; expiresAt: string; total: number; added: number; updated: number; skipped: number; newFields: { label: string; type: ValueType }[]; issues: { row: number; column: string; message: string }[]; sample: Record<string, unknown>[]; sampleRowNumbers?: number[] }
export interface ImportResult { added: number; updated: number; skipped: number; fieldsCreated: number }
export type TaxDocument = 'quotation' | 'sale' | 'purchase';
export interface TaxRate { id: string; name: string; rateBps: number; kind: 'add' | 'withhold'; documents: TaxDocument[]; active: boolean }
export interface TaxDefault { rateId: string | null; withholdingId: string | null; inclusive: boolean; level: 'document' | 'line' }
export interface TaxSetup { revision: number; rates: TaxRate[]; defaults: Record<TaxDocument, TaxDefault>; registrationNumber: string; showBreakdown: boolean; allowOverride: boolean }
export interface TaxSelection { rateId?: string | null; withholdingId?: string | null; inclusive?: boolean; lineRateIds?: (string | null)[]; revision?: number }
export interface TaxBreakdown { rateId: string; name: string; rateBps: number; kind: 'add' | 'withhold'; base: number; amount: number }
export interface TaxSnapshot { version: 1; rates?: TaxRate[]; revision: number; inclusive: boolean; level: 'document' | 'line'; registrationNumber: string; showBreakdown: boolean; selection: TaxSelection; subtotal: number; discount: number; tax: number; withholding: number; grossTotal: number; payable: number; breakdown: TaxBreakdown[] }
export const emptyTaxSetup = (): TaxSetup => ({ revision: 0, rates: [], defaults: Object.fromEntries(['quotation', 'sale', 'purchase'].map(k => [k, { rateId: null, withholdingId: null, inclusive: false, level: 'document' }])) as TaxSetup['defaults'], registrationNumber: '', showBreakdown: true, allowOverride: false });
/** All posted amounts use the ledger's existing integer taka unit. Round at each line. */
export function calculateTax(setup: TaxSetup, document: TaxDocument, amounts: number[], discount = 0, selection: TaxSelection = {}): TaxSnapshot {
  const defaults = setup.defaults[document];
  const inclusive = selection.inclusive ?? defaults.inclusive;
  const rateId = selection.rateId === undefined ? defaults.rateId : selection.rateId;
  const withholdingId = selection.withholdingId === undefined ? defaults.withholdingId : selection.withholdingId;
  const findRate = (id: string | null | undefined, kind: TaxRate['kind']) => {
    if (id == null) return undefined;
    const rate = setup.rates.find(r => r.id === id && r.active && r.kind === kind && r.documents.includes(document));
    if (!rate) throw new Error('A selected tax rate is unavailable. Reload tax setup.');
    return rate;
  };
  if (!Number.isSafeInteger(discount) || discount < 0 || amounts.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Use non-negative whole taka amounts');
  const amountSum = amounts.reduce((a, b) => a + b, 0);
  if (discount > amountSum) throw new Error('Discount cannot exceed the subtotal');
  const groups = new Map<string, TaxBreakdown>();
  let subtotal = 0, tax = 0, distributed = 0;
  amounts.forEach((gross, i) => {
    // Allocate discount using cumulative rounding so the allocations sum exactly.
    const allocation = amountSum ? Math.round(discount * amounts.slice(0, i + 1).reduce((a, b) => a + b, 0) / amountSum) : 0;
    const taxable = gross - (allocation - distributed); distributed = allocation;
    const rate = findRate(defaults.level === 'line' ? selection.lineRateIds?.[i] === undefined ? rateId : selection.lineRateIds[i] : rateId, 'add');
    const base = inclusive && rate ? Math.round(taxable * 10000 / (10000 + rate.rateBps)) : taxable;
    const added = inclusive ? taxable - base : Math.round(base * (rate?.rateBps ?? 0) / 10000);
    subtotal += base; tax += added;
    if (rate) { const group = groups.get(rate.id) ?? { rateId: rate.id, name: rate.name, rateBps: rate.rateBps, kind: 'add' as const, base: 0, amount: 0 }; group.base += base; group.amount += added; groups.set(rate.id, group); }
  });
  const wh = findRate(withholdingId, 'withhold');
  const withholding = wh ? Math.round(subtotal * wh.rateBps / 10000) : 0;
  if (wh) groups.set(wh.id, { rateId: wh.id, name: wh.name, rateBps: wh.rateBps, kind: 'withhold', base: subtotal, amount: withholding });
  const grossTotal = subtotal + tax, payable = grossTotal - withholding;
  if (![subtotal, tax, grossTotal, payable].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647)) throw new Error('Total exceeds the supported amount');
  const selectedIds = new Set([rateId, withholdingId, ...(selection.lineRateIds ?? [])].filter(Boolean));
  return { version: 1, rates: setup.rates.filter(r => selectedIds.has(r.id) && r.active && r.documents.includes(document)), revision: setup.revision, inclusive, level: defaults.level, registrationNumber: setup.registrationNumber, showBreakdown: setup.showBreakdown, selection: { rateId, withholdingId, inclusive, ...(defaults.level === 'line' ? { lineRateIds: amounts.map((_, i) => selection.lineRateIds?.[i] === undefined ? rateId : selection.lineRateIds[i]) } : {}) }, subtotal, discount, tax, withholding, grossTotal, payable, breakdown: [...groups.values()] };
}
/** Same Bangladesh mobile prefixes accepted by the app's contact entry; other codes stay explicit. */
export function businessPhoneIdentity(raw: string) {
  let value = raw.trim().replace(/[\s().-]/g, '');
  if (value.startsWith('00')) value = '+' + value.slice(2);
  if (/^01\d{9}$/.test(value)) return '+88' + value;
  if (/^1\d{9}$/.test(value)) return '+880' + value;
  if (/^8801\d{9}$/.test(value)) return '+' + value;
  return value;
}
