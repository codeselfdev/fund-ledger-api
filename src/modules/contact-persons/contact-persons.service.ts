import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../core/http/api-error.js';
import { businessPhoneIdentity } from '../business-setup/contract.js';
import { findRecord } from '../business-setup/records.js';

export const contactEntity = z.enum(['customer', 'dealer']);
export const contactLinkSchema = z.object({ entity: contactEntity, record_id: z.string().min(1) }).strict();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional().transform(value => value || null);
export const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  designation: optionalText(120),
  mobile: optionalText(32).refine(value => !value || /^\+?[\d\s().-]{6,32}$/.test(value), 'Enter a valid phone number').transform(value => value ? businessPhoneIdentity(value) : null).refine(value => value === null || /^\+?\d{6,15}$/.test(value), 'Enter a valid phone number'),
  email: optionalText(200).refine(value => !value || z.string().email().safeParse(value).success, 'Enter a valid email address'),
}).strict();
export type ContactScope = { tenantId: string; projectId: string; userId: string; roles: string[] };
export const scope = (auth: Pick<ContactScope, 'tenantId' | 'projectId'>) => ({ tenantId: auth.tenantId, projectId: auth.projectId });

export function assertDealerWriter(auth: ContactScope) {
  if (!auth.roles.some(role => ['owner', 'admin', 'accountant'].includes(role))) throw forbidden('Only administrators and accountants can change dealer contacts');
}
export async function contactParent(db: Prisma.TransactionClient, auth: ContactScope, entity: 'customer' | 'dealer', id: string, active = true) {
  const record = await findRecord(db, auth, entity, id);
  if (!record || active && !record.isActive) throw notFound('Customer or dealer not found');
  return record;
}
export async function assertCustomerWriter(db: Prisma.TransactionClient, auth: ContactScope) {
  if (!auth.roles.some(role => ['owner', 'admin', 'accountant'].includes(role)) && (await db.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId } }))?.projectType === 'billing') throw forbidden('Only administrators and accountants can change billing customer contacts');
}
export async function linkContact(db: Prisma.TransactionClient, auth: ContactScope, id: string, link: z.infer<typeof contactLinkSchema>) {
  if (link.entity === 'dealer') assertDealerWriter(auth);
  else await assertCustomerWriter(db, auth);
  await contactParent(db, auth, link.entity, link.record_id);
  const person = await db.contactPerson.findFirst({ where: { id, ...scope(auth), isActive: true } });
  if (!person) throw notFound('Active contact person not found');
  const data = { ...scope(auth), contactPersonId: id };
  if (link.entity === 'customer') await db.customerContactPerson.upsert({ where: { customerId_contactPersonId: { customerId: link.record_id, contactPersonId: id } }, create: { ...data, customerId: link.record_id }, update: {} });
  else await db.dealerContactPerson.upsert({ where: { dealerId_contactPersonId: { dealerId: link.record_id, contactPersonId: id } }, create: { ...data, dealerId: link.record_id }, update: {} });
  return person;
}

/** Only server-resolved contacts can be selected; historical documents keep their snapshot. */
export async function quotationPerson(db: Prisma.TransactionClient, auth: Pick<ContactScope, 'tenantId' | 'projectId'>, customerId: string, id: string | null | undefined, previous?: { customerId: string; quotationPersonId: string | null; quotationPersonSnapshot: Prisma.JsonValue | null }) {
  if (previous?.customerId === customerId && (id === undefined || id === previous.quotationPersonId)) return { quotationPersonId: previous.quotationPersonId, quotationPersonSnapshot: previous.quotationPersonSnapshot ? previous.quotationPersonSnapshot as Prisma.InputJsonValue : Prisma.DbNull };
  if (!id) return { quotationPersonId: null, quotationPersonSnapshot: Prisma.DbNull };
  const person = await db.contactPerson.findFirst({ where: { id, ...scope(auth), isActive: true, customerLinks: { some: { customerId, ...scope(auth) } } } });
  if (!person) throw badRequest('Choose an active contact person linked to this customer');
  return { quotationPersonId: person.id, quotationPersonSnapshot: { id: person.id, name: person.name, designation: person.designation, mobile: person.mobile, email: person.email } };
}

export function quotationPersonPdfLines(snapshot: Prisma.JsonValue | null): string[] {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return [];
  const contact = snapshot as Record<string, unknown>;
  return contact.name ? [`Quotation person: ${contact.name}${contact.designation ? ` (${contact.designation})` : ''}`, [contact.mobile, contact.email].filter(Boolean).join(' | ')].filter(Boolean) : [];
}
