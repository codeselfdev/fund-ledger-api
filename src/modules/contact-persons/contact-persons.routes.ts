import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { notFound } from '../../core/http/api-error.js';
import { created, ok } from '../../core/http/response.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { financialTransaction } from '../accounting/transaction.js';
import { assertCustomerWriter, assertDealerWriter, contactEntity, contactLinkSchema, contactParent, contactSchema, linkContact, scope } from './contact-persons.service.js';

const router = Router();
router.use(requireProject, requireRoles('accountant', 'cashier', 'approver', 'auditor', 'staff'));
const writer = requireRoles('accountant', 'cashier');
const audit = (db: Prisma.TransactionClient, auth: ReturnType<typeof requireProjectContext>, id: string, action: string, value: unknown) => db.activity.create({ data: { ...scope(auth), actorUserId: auth.userId, action, entityType: 'contact_person', entityId: id, after: JSON.parse(JSON.stringify(value)) } });
const querySchema = z.object({ search: z.string().trim().max(120).default(''), entity: contactEntity.optional(), record_id: z.string().min(1).optional(), offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(50).default(50) }).strict().refine(value => !!value.entity === !!value.record_id, 'Supply both entity and record_id');
router.get('/', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), q = querySchema.parse(req.query);
  if (q.entity && q.record_id) await contactParent(prisma, auth, q.entity, q.record_id, false);
  const where: Prisma.ContactPersonWhereInput = { ...scope(auth), isActive: true,
    ...(q.entity === 'customer' ? { customerLinks: { some: { customerId: q.record_id, ...scope(auth) } } } : q.entity === 'dealer' ? { dealerLinks: { some: { dealerId: q.record_id, ...scope(auth) } } } : {}),
    ...(q.search ? { OR: ['name', 'mobile', 'email', 'designation'].map(key => ({ [key]: { contains: q.search, mode: 'insensitive' } })) } : {}),
  };
  const entries = await prisma.contactPerson.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: q.offset, take: q.limit + 1 });
  return ok(res, { entries: entries.slice(0, q.limit), nextOffset: entries.length > q.limit ? q.offset + q.limit : null });
}));
router.post('/', writer, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), b = contactSchema.extend({ link: contactLinkSchema.optional() }).strict().parse(req.body);
  const person = await financialTransaction(async db => {
    const { link, ...fields } = b;
    const person = await db.contactPerson.create({ data: { ...scope(auth), ...fields } });
    if (link) await linkContact(db, auth, person.id, link);
    await audit(db, auth, person.id, 'contact_person.created', b); return person;
  });
  return created(res, person);
}));
router.patch('/:id', writer, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), b = contactSchema.extend({ is_active: z.boolean().optional() }).strict().parse(req.body);
  const person = await financialTransaction(async db => {
    const old = await db.contactPerson.findFirst({ where: { id: req.params.id, ...scope(auth) } });
    if (!old) throw notFound('Contact person not found');
    if (await db.customerContactPerson.findFirst({ where: { contactPersonId: old.id, ...scope(auth) } })) await assertCustomerWriter(db, auth);
    if (await db.dealerContactPerson.findFirst({ where: { contactPersonId: old.id, ...scope(auth) } })) assertDealerWriter(auth);
    const { is_active, ...fields } = b;
    const saved = await db.contactPerson.update({ where: { id: old.id }, data: { ...fields, isActive: is_active } });
    await audit(db, auth, old.id, 'contact_person.updated', b); return saved;
  }); return ok(res, person);
}));
router.post('/:id/links', writer, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), b = contactLinkSchema.parse(req.body);
  const person = await financialTransaction(async db => { const person = await linkContact(db, auth, String(req.params.id), b); await audit(db, auth, person.id, 'contact_person.linked', b); return person; });
  return ok(res, person);
}));
router.delete('/:id/links/:entity/:recordId', writer, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = contactEntity.parse(req.params.entity), recordId = String(req.params.recordId), id = String(req.params.id);
  await financialTransaction(async db => {
    if (entity === 'dealer') assertDealerWriter(auth);
    else await assertCustomerWriter(db, auth);
    await contactParent(db, auth, entity, recordId, false);
    if (!await db.contactPerson.findFirst({ where: { id, ...scope(auth) } })) throw notFound('Contact person not found');
    if (entity === 'customer') await db.customerContactPerson.deleteMany({ where: { ...scope(auth), contactPersonId: id, customerId: recordId } });
    else await db.dealerContactPerson.deleteMany({ where: { ...scope(auth), contactPersonId: id, dealerId: recordId } });
    await audit(db, auth, id, 'contact_person.unlinked', { entity, record_id: recordId });
  }); return ok(res, { unlinked: true });
}));
export { router as contactPersonsRouter };
