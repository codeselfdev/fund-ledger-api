import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { itemDetailsSchema, type ItemDetails } from './item-detail-fields.js';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { conflict, notFound, badRequest } from '../../core/http/api-error.js';
import type { Kind } from './workflow.js';
export const sectionSchema = z.object({ enabled: z.boolean(), text: z.string().max(16000) }).strict().refine(value => !value.enabled || !!value.text.trim(), 'Add paragraph text before enabling this section');
export const profileSchema = z.object({ name: z.string().trim().min(2).max(160), address: z.string().max(500), phone: z.string().max(80), email: z.string().max(200), website: z.string().max(250).refine(v => !v || /^https?:\/\/[^\s]+$/i.test(v), 'Use a complete https:// website URL'), footer: z.string().max(300) }).strip();
export const templateIds = ['classic', 'executive', 'minimal', 'corporate', 'elegant'] as const;
export const settingsSchema = z.object({ revision: z.number().int().nonnegative(), prefixRevision: z.number().int().nonnegative(), templateId: z.enum(templateIds).default('classic'), accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null), itemDetails: itemDetailsSchema.nullable().optional(), prefix: z.string().trim().regex(/^[A-Za-z0-9]{1,3}$/).transform(v => v.toUpperCase()), profile: profileSchema, terms: sectionSchema, disclaimer: sectionSchema }).strict();
export const selectionSchema = z.object({ item_description: z.boolean().optional(), revision: z.number().int().nonnegative(), terms: z.boolean(), disclaimer: z.boolean(), terms_text: z.string().max(16000).optional(), disclaimer_text: z.string().max(16000).optional() }).strict();
export type DocumentSettings = z.infer<typeof settingsSchema>;
export type DocumentPresentation = { includeItemDescription?: boolean; version: 1; itemDetails?: ItemDetails | null; profile: DocumentSettings['profile']; terms: z.infer<typeof sectionSchema>; disclaimer: z.infer<typeof sectionSchema>; settingsRevision: number; preparedByName: string; preparedBy?: { id: string; name: string; designation: string; mobile: string; email: string }; templateId?: typeof templateIds[number]; accentColor?: string | null; logoFileId?: string | null };
export type Scope = { tenantId: string; projectId: string; userId?: string };
export async function getDocumentSettings(db: Prisma.TransactionClient, auth: Scope): Promise<DocumentSettings> {
  const [project, tenant] = await Promise.all([db.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId } }), db.tenant.findFirst({  where: { id: auth.tenantId } })]);
  if (!project || !tenant) throw notFound('Organization or project not found');
  const raw = project.documentSettings as Partial<DocumentSettings> | null;
  return { itemDetails: raw?.itemDetails ?? null, revision: raw?.revision ?? 0, prefixRevision: tenant.documentPrefixRevision, templateId: raw?.templateId ?? 'classic', accentColor: raw?.accentColor ?? null, prefix: tenant.documentPrefix || tenant.name.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'ORG', profile: profileSchema.parse(raw?.profile ?? { name: tenant.name, address: '', phone: '', email: '', website: '', footer: '' }), terms: raw?.terms ?? { enabled: false, text: '' }, disclaimer: raw?.disclaimer ?? { enabled: false, text: '' } };
}
export async function nextDocumentNumber(db: Prisma.TransactionClient, auth: Scope, kind: Kind, date: string) {
  const tenant = await db.tenant.findFirst({  where: { id: auth.tenantId } });
  if (!tenant) throw notFound('Organization not found');
  const prefix = tenant.documentPrefix || tenant.name.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'ORG';
  const period = date.slice(0, 7).replace('-', '');
  const sequence = await db.documentNumberSequence.upsert({ where: { tenantId_kind_period: { tenantId: auth.tenantId, kind, period } }, create: { tenantId: auth.tenantId, kind, period, lastValue: 1 }, update: { lastValue: { increment: 1 } } });
  if (sequence.lastValue > 999) throw conflict('This organization has used all 999 document numbers for this type and month');
  return `${prefix}${{ quotation: 'Q', order: 'SO', sale: 'SI' }[kind]}${period.slice(2)}1${String(sequence.lastValue).padStart(3, '0')}`;
}
export async function documentPresentation(db: Prisma.TransactionClient, auth: Scope, selection?: z.infer<typeof selectionSchema>, previous?: unknown): Promise<DocumentPresentation> {
  const old = previous as DocumentPresentation | null;
  let result: DocumentPresentation;
  if (old?.version === 1 && (!selection || selection.revision === old.settingsRevision)) result = structuredClone(old);
  else {
    const settings = await getDocumentSettings(db, auth);
    if (selection && settings.revision !== selection.revision) throw conflict('Document templates changed. Reload them before saving.');
    const project = await db.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId } });
    result = { version: 1, itemDetails: settings.itemDetails ?? null, profile: settings.profile, terms: settings.terms, disclaimer: settings.disclaimer, settingsRevision: settings.revision, preparedByName: '', templateId: settings.templateId, accentColor: settings.accentColor, logoFileId: project?.logoFileId ?? null, ...(old?.preparedBy ? { preparedBy: old.preparedBy, preparedByName: old.preparedBy.name } : {}) };
  }
  if (!result.preparedBy) {
    const user = auth.userId ? await tenantAccounts(db).findFirst({ where: { id: auth.userId, tenantId: auth.tenantId }, select: { id: true, name: true, mobile: true, email: true, professionalProfile: true } }) : null;
    const profile = user?.professionalProfile as { designation?: string; mobile?: string; email?: string } | null;
    result.preparedBy = { id: user?.id ?? '', name: user?.name ?? '', designation: profile?.designation ?? '', mobile: profile?.mobile ?? user?.mobile ?? '', email: profile?.email ?? user?.email ?? '' };
    result.preparedByName = result.preparedBy.name;
  }
  // New documents exclude the optional Description property. Preserve legacy snapshots.
  if (selection?.item_description !== undefined) result.includeItemDescription = selection.item_description;
  else if (old?.includeItemDescription !== undefined) result.includeItemDescription = old.includeItemDescription;
  else if (old?.version !== 1) result.includeItemDescription = false;
  result.terms = { enabled: selection?.terms ?? result.terms.enabled, text: selection?.terms_text ?? result.terms.text };
  result.disclaimer = { enabled: selection?.disclaimer ?? result.disclaimer.enabled, text: selection?.disclaimer_text ?? result.disclaimer.text };
  if (result.terms.enabled && !result.terms.text.trim() || result.disclaimer.enabled && !result.disclaimer.text.trim()) throw badRequest('Add paragraph text before enabling this section');
  return result;
}
export async function referrerSnapshot(db: Prisma.TransactionClient, auth: Scope, id: string | null | undefined, previous?: { referrerId: string | null; referrerSnapshot: Prisma.JsonValue | null }) {
  if (previous && (id === undefined || id === previous.referrerId)) return { referrerId: previous.referrerId, referrerSnapshot: previous.referrerSnapshot ? previous.referrerSnapshot as Prisma.InputJsonValue : Prisma.DbNull };
  if (!id) return { referrerId: null, referrerSnapshot: Prisma.DbNull };
  const person = await db.contactPerson.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId, isActive: true } });
  if (!person) throw badRequest('Choose an active referrer from this project');
  return { referrerId: person.id, referrerSnapshot: { id: person.id, name: person.name, designation: person.designation, mobile: person.mobile, email: person.email } };
}
export function referralSummary(documents: { referrerId: string | null; referrerSnapshot: unknown; kind: string; status: string; total: number; paidAmount: number }[]) {
  const groups = new Map<string, { id: string; name: string; workOrders: number; invoices: number; invoiced: number; collected: number }>();
  for (const d of documents) {
    if (!d.referrerId || !(['confirmed', 'fulfilling', 'completed'].includes(d.status) && d.kind === 'order' || d.kind === 'sale' && d.status === 'issued')) continue;
    const row = groups.get(d.referrerId) ?? { id: d.referrerId, name: (d.referrerSnapshot as { name?: string })?.name || 'Referred contact', workOrders: 0, invoices: 0, invoiced: 0, collected: 0 };
    if (d.kind === 'order') row.workOrders++;
    else { row.invoices++; row.invoiced += d.total; row.collected += d.paidAmount; }
    groups.set(row.id, row);
  }
  return [...groups.values()].sort((a, b) => b.workOrders - a.workOrders || a.name.localeCompare(b.name));
}
