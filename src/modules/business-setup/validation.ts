import { z } from 'zod';
import { BUILTINS, keywordType, type BusinessEntity, type FieldDefinition } from './contract.js';
export const entitySchema = z.enum(['customer', 'dealer', 'item']);
export const valueTypeSchema = z.enum(['text', 'long_text', 'number', 'money', 'date', 'boolean', 'select', 'multi_select', 'phone', 'email']);
export const attributeSchema = z.record(z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.array(z.string().max(200)).max(100), z.null()])).refine(v => Object.keys(v).length <= 100, 'At most 100 attributes').optional();
export const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), label: z.string().trim().min(1).max(80), type: valueTypeSchema,
  options: z.array(z.string().trim().min(1).max(100)).max(100).default([]), required: z.boolean().default(false), searchable: z.boolean().default(false), match: z.enum(['contains', 'exact', 'starts_with']).default('contains'), filterable: z.boolean().default(false), showInList: z.boolean().default(false), position: z.number().int().min(0).max(1000).default(0), archived: z.boolean().default(false),
}).strict().superRefine((f, ctx) => {
  if (['select', 'multi_select'].includes(f.type) && (!f.options.length || new Set(f.options).size !== f.options.length)) ctx.addIssue({ code: 'custom', message: 'Choice fields need unique options' });
  if (f.searchable && !keywordType(f.type)) ctx.addIssue({ code: 'custom', message: 'Use a filter for this value type' });
});
export const taxSelectionSchema = z.object({ revision: z.number().int().min(0), rateId: z.string().nullable().optional(), withholdingId: z.string().nullable().optional(), inclusive: z.boolean().optional(), lineRateIds: z.array(z.string().nullable()).max(100).optional() }).strict();
const taxDefault = z.object({ rateId: z.string().nullable(), withholdingId: z.string().nullable(), inclusive: z.boolean(), level: z.enum(['document', 'line']) }).strict();
export const taxSetupSchema = z.object({ revision: z.number().int().min(0), registrationNumber: z.string().trim().max(80), showBreakdown: z.boolean(), allowOverride: z.boolean(), rates: z.array(z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), rateBps: z.number().int().min(0).max(10000), kind: z.enum(['add', 'withhold']), documents: z.array(z.enum(['quotation', 'sale', 'purchase'])).max(3), active: z.boolean() }).strict()).max(50), defaults: z.object({ quotation: taxDefault, sale: taxDefault, purchase: taxDefault }).strict() }).strict().superRefine((s, ctx) => {
  if (new Set(s.rates.map(r => r.id)).size !== s.rates.length) ctx.addIssue({ code: 'custom', message: 'Tax IDs must be unique' });
  for (const document of ['quotation', 'sale', 'purchase'] as const) for (const [key, kind] of [['rateId', 'add'], ['withholdingId', 'withhold']] as const) {
    const id = s.defaults[document][key];
    if (id && !s.rates.some(r => r.id === id && r.kind === kind && r.active && r.documents.includes(document))) ctx.addIssue({ code: 'custom', message: `Choose an active applicable default for ${document}` });
  }
});
export function builtinField(entity: BusinessEntity, target: string) { return BUILTINS[entity].find(b => b.key === target); }
export function mapField(f: Record<string, unknown>): FieldDefinition {
  const { key, label, type, options, required, searchable, match, filterable, showInList, position, archived } = f;
  return { id: String(f.id), ...fieldSchema.parse({ key, label, type, options, required, searchable, match, filterable, showInList, position, archived }) };
}
