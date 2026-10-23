import { documentItemFields, snapshotItemDetails, validateItemDetails } from './item-details.js';
import { professionalProfile } from '../profile/user-profile.routes.js';
import { documentLogo } from './document-logo.js';
import { buildProfessionalDocument } from './document-pdf.js';
import { documentPresentation, getDocumentSettings, nextDocumentNumber, referrerSnapshot, referralSummary, settingsSchema } from './document-settings.js';
import { quotationPerson } from '../contact-persons/contact-persons.service.js';
import { changeStock as changeItemStock, stockEnabled, stockLocation } from '../inventory/stock.service.js';
import { documentTax, postTax, lockSetup } from '../business-setup/service.js';
import { customersRouter } from '../customers/customers.routes.js';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { Prisma, type BusinessDocument } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { created, ok } from '../../core/http/response.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody, validateQuery } from '../../core/validation/validate.js';
import { allowDirect, calculate, chargesSchema, conversion, dateSchema, documentSchema, kindSchema, nextStatus, pastDateSchema, paymentStatus, workflow, workflowSchema, type Kind } from './workflow.js';
import { financialTransaction } from './transaction.js';
import { buildAccountingDashboard } from './dashboard.js';
const router = Router();
const read = requireRoles('accountant', 'cashier', 'approver', 'auditor');
const write = requireRoles('accountant', 'cashier');
const scoped = (auth: {
    tenantId: string;
    projectId: string;
}) => ({ tenantId: auth.tenantId, projectId: auth.projectId });
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const atDate = (value: string) => new Date(`${value}T00:00:00Z`);
const docInclude = { stockLocation: true, payments: { orderBy: { createdAt: 'desc' as const } }, source: { select: { id: true, kind: true, number: true } }, next: { select: { id: true, kind: true, number: true } } };
const mapDoc = (d: BusinessDocument) => ({ ...d, remaining: d.total - d.paidAmount, payment_status: paymentStatus(d) });
router.use(requireProject, read, asyncHandler(async (req, _res, next) => {
    const auth = requireProjectContext(req);
    const project = await prisma.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId, isActive: true } });
    if (!project || project.projectType !== 'accounting')
        throw forbidden('This feature belongs to Accounting projects');
    next();
}));
router.use('/customers', (req, res, next) => req.method === 'GET' ? next() : write(req, res, next), customersRouter);
router.get('/overview', asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const [p, docs, customers] = await Promise.all([prisma.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId } }), prisma.businessDocument.findMany({ where: scoped(auth), orderBy: { createdAt: 'desc' } }), prisma.customer.count({ where: { ...scoped(auth), isActive: true } })]);
    const sales = docs.filter(d => d.kind === 'sale' && d.status === 'issued');
    return ok(res, { stock_management_enabled: p.stockManagementEnabled !== false, workflow: workflow(p.commerceSettings), customers, invoiced: sales.reduce((n, d) => n + d.total, 0), collected: sales.reduce((n, d) => n + d.paidAmount, 0), receivable: sales.reduce((n, d) => n + d.total - d.paidAmount, 0), overdue: sales.filter(d => paymentStatus(d) === 'overdue').reduce((n, d) => n + d.total - d.paidAmount, 0), counts: { quotation: docs.filter(d => d.kind === 'quotation').length, order: docs.filter(d => d.kind === 'order').length, sale: sales.length }, recent: docs.slice(0, 5).map(mapDoc) });
}));
const dashboardQuery = z.object({ period: z.enum(['this_month', 'last_month', 'this_year']).default('this_month') });
router.get('/dashboard', validateQuery(dashboardQuery), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), { period } = dashboardQuery.parse(req.query);
    const result = await financialTransaction(async tx => {
    const [project, documents, payments, customers, expenses] = await Promise.all([
        tx.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId } }),
        tx.businessDocument.findMany({ where: scoped(auth), orderBy: { updatedAt: 'desc' } }),
        tx.businessPayment.findMany({ where: scoped(auth), orderBy: { createdAt: 'desc' } }),
        tx.customer.count({ where: { ...scoped(auth), isActive: true } }),
        tx.expense.findMany({where:scoped(auth),orderBy:{updatedAt:'desc'}}),
    ]);
    const items = project.stockManagementEnabled === false ? [] : await tx.inventoryItem.findMany({ where: { ...scoped(auth), isActive: true } });
    return buildAccountingDashboard({ documents, payments, expenses, customers, items, stockEnabled: project.stockManagementEnabled !== false, period });
    });
    return ok(res, result);
}));
router.put('/workflow', requireRoles('admin'), validateBody(workflowSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const value = workflowSchema.parse(req.body);
    await financialTransaction(async (tx) => {
        await tx.project.update({ where: { id: auth.projectId }, data: { commerceSettings: value } });
        await tx.activity.create({ data: { ...scoped(auth), actorUserId: auth.userId, action: 'accounting.workflow.updated', entityType: 'project', entityId: auth.projectId, after: value } });
    });
    return ok(res, value);
}));
router.get('/documents', validateQuery(z.object({ kind: kindSchema.optional(), receivable: z.enum(['true', 'false']).optional() })), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const kind = req.query.kind === undefined ? undefined : kindSchema.parse(req.query.kind);
    const rows = await prisma.businessDocument.findMany({ where: { ...scoped(auth), kind }, orderBy: { createdAt: 'desc' } });
    return ok(res, (req.query.receivable === 'true' ? rows.filter(d => d.kind === 'sale' && d.status === 'issued' && d.paidAmount < d.total) : rows).map(mapDoc));
}));
router.get('/documents/:id', asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const d = await prisma.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) }, include: docInclude });
    if (!d)
        throw notFound('Document not found');
    return ok(res, mapDoc(d));
}));
function event(status: string, userId: string) { return { status, user_id: userId, at: new Date().toISOString() }; }
async function audit(tx: Prisma.TransactionClient, auth: ReturnType<typeof requireProjectContext>, id: string, action: string, detail: unknown, before?: unknown) {
    await tx.activity.create({ data: { ...scoped(auth), actorUserId: auth.userId, action, entityType: 'business_document', entityId: id, after: json(detail), ...(before === undefined ? {} : { before: json(before) }) } });
}
router.get('/document-item-fields', asyncHandler(async (req, res) => ok(res, await documentItemFields(prisma, requireProjectContext(req)))));
router.get('/document-settings', asyncHandler(async (req, res) => ok(res, await getDocumentSettings(prisma, requireProjectContext(req)))));
router.put('/document-settings', requireRoles('admin'), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), body = settingsSchema.parse(req.body);
  const saved = await financialTransaction(async tx => {
    await lockSetup(tx, auth);
    const old = await getDocumentSettings(tx, auth);
    if (old.revision !== body.revision || old.prefixRevision !== body.prefixRevision) throw conflict('Document settings changed. Reload before saving.');
    if (body.itemDetails === undefined) body.itemDetails = old.itemDetails ?? null;
    await validateItemDetails(tx, auth, body.itemDetails);
    const { prefix, prefixRevision, ...settings } = body;
    await tx.tenant.update({ where: { id: auth.tenantId }, data: { documentPrefix: prefix, documentPrefixRevision: { increment: 1 } } });
    await tx.project.update({ where: { id: auth.projectId }, data: { documentSettings: json({ ...settings, revision: old.revision + 1 }) } });
    await audit(tx, auth, auth.projectId, 'accounting.document_settings.updated', { revision: old.revision + 1, prefix });
    return { ...body, revision: old.revision + 1, prefixRevision: old.prefixRevision + 1 };
  }); return ok(res, saved);
}));
router.post('/document-settings/preview', requireRoles('admin'), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), settings = settingsSchema.parse(req.body), kind = kindSchema.parse(req.query.kind ?? 'quotation');
  const result = await financialTransaction(async tx => {
    if (settings.itemDetails === undefined) settings.itemDetails = (await getDocumentSettings(tx, auth)).itemDetails ?? null;
    const [project, tenant, user] = await Promise.all([tx.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId } }), tx.tenant.findFirstOrThrow({ where: { id: auth.tenantId } }), tx.user.findFirst({ where: { id: auth.userId, tenantId: auth.tenantId } })]);
    await validateItemDetails(tx, auth, settings.itemDetails);
    const fields = settings.itemDetails ? await documentItemFields(tx, auth) : [];
    const sampleDetails = fields.map(f => ({ key: f.key, label: f.label, value: f.type === 'boolean' ? 'Yes' : f.type === 'money' ? '12,500' : f.type === 'number' ? '10' : f.type === 'date' ? '2026-10-23' : ({ sku: 'DEMO-01', unit: 'pcs', category: 'Equipment', description: 'Sample product specifications' }[f.key] ?? `Sample ${f.label.toLowerCase()}`) }));
    const author = user ? { id: user.id, ...professionalProfile(user) } : { id: '', name: '', designation: '', mobile: '', email: '' };
    const presentation = { version: 1 as const, itemDetails: settings.itemDetails ?? null, profile: settings.profile, terms: settings.terms, disclaimer: settings.disclaimer, settingsRevision: settings.revision, templateId: settings.templateId, accentColor: settings.accentColor, logoFileId: project?.logoFileId ?? null, preparedBy: author, preparedByName: author.name };
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    return buildProfessionalDocument({ kind, number: 'SAMPLE - not saved', status: 'sample', documentDate: date, customerSnapshot: { name: 'Sample customer', address: 'Customer address', email: 'customer@example.com' }, presentationSnapshot: presentation, lines: [{ item_details: sampleDetails, description: 'Sample product with specifications', quantity: 2, unit_price: 12500, line_total: 25000, item_code: 'DEMO-01', model: 'Model A', unit: 'pcs' }], subtotal: 25000, discount: 0, tax: 0, total: 25000, note: 'Template preview using sample items. No document or stock movement is created.' }, tenant.currency, tenant.name, await documentLogo(tx, auth, presentation));
  }, 15000);
  res.setHeader('Cache-Control', 'no-store'); return ok(res, { html: result.html, base64: result.pdf.toString('base64'), pages: result.pages });
}));
router.get('/referrals', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  return ok(res, referralSummary(await prisma.businessDocument.findMany({ where: { ...scoped(auth), referrerId: { not: null } }, orderBy: { createdAt: 'desc' } })));
}));
router.post('/documents/preview', write, validateBody(documentSchema.omit({ request_key: true }).extend({ document_id: z.string().optional(), source_id: z.string().min(1).optional() })), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), b = documentSchema.omit({ request_key: true }).extend({ document_id: z.string().optional(), source_id: z.string().min(1).optional() }).parse(req.body);
  const result = await financialTransaction(async tx => {
    if (b.source_id) {
      if (b.document_id) throw badRequest('Choose either a source conversion or an existing document preview.');
      const source = await tx.businessDocument.findFirst({ where: { id: b.source_id, ...scoped(auth) }, include: { next: true } });
      if (!source) throw notFound('Source document not found');
      if (b.expected_revision === undefined || b.expected_revision !== source.revision || source.next) throw conflict('The source document changed. Review a fresh draft before previewing.');
      conversion(kindSchema.parse(source.kind), source.status, b.kind, workflow(source.workflow));
      if (b.due_date && b.due_date < b.document_date) throw badRequest('Due date must be on or after document date');
      const tenant = await tx.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
      return buildProfessionalDocument({ ...source, kind: b.kind, number: 'PREVIEW - number assigned on save', status: 'draft', revision: 0, documentDate: b.document_date, dueDate: b.due_date ?? null }, tenant.currency, tenant.name, await documentLogo(tx, auth, source.presentationSnapshot));
    }
    const old = b.document_id ? await tx.businessDocument.findFirst({ where: { id: b.document_id, ...scoped(auth) } }) : null;
    if (b.document_id && !old) throw notFound('Document not found');
    if (old && old.kind !== b.kind) throw badRequest('Document kind cannot be changed');
    const customer = await tx.customer.findFirst({ where: { id: b.customer_id, ...scoped(auth), isActive: true } });
    if (!customer) throw notFound('Active customer not found');
    if (b.due_date && b.due_date < b.document_date) throw badRequest('Due date must be on or after document date');
    await validateItems(tx, auth, b.lines);
    const person = await quotationPerson(tx, auth, customer.id, b.quotation_person_id, old ?? undefined);
    const presentation = await documentPresentation(tx, auth, b.presentation, old?.presentationSnapshot);
    const charges = b.additional_charges ?? (old ? chargesSchema.parse(old.additionalCharges ?? []) : []);
    const tax = await documentTax(tx, auth, b.kind === 'quotation' ? 'quotation' : 'sale', b.lines.map(l => Math.round(l.quantity * l.unit_price)), b.discount, b.tax_selection, b.tax, old?.taxSnapshot ?? (old ? { legacy: true, tax: old.tax } : undefined), charges);
    const totals = calculate(b.lines, b.discount, b.tax, charges), tenant = await tx.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
    if (b.expected_total !== undefined && b.expected_total !== (tax?.payable ?? totals.total)) throw conflict('The calculated total changed. Review the document again.');
    const detailedLines = await snapshotItemDetails(tx, auth, totals.lines, presentation.itemDetails, old ?? undefined);
    return buildProfessionalDocument({ ...totals, lines: detailedLines, additionalCharges: charges, kind: b.kind, number: old?.number ?? 'PREVIEW - number assigned on save', status: old?.status ?? 'draft', revision: old?.revision ?? 0, customerSnapshot: customer, quotationPersonSnapshot: person.quotationPersonSnapshot, presentationSnapshot: presentation, documentDate: b.document_date, dueDate: b.due_date, discount: b.discount, tax: tax?.tax ?? b.tax, taxSnapshot: tax, subtotal: tax ? tax.subtotal + b.discount : totals.subtotal, total: tax?.payable ?? totals.total, note: b.note }, tenant.currency, tenant.name, await documentLogo(tx, auth, presentation));
  }, 15000);
  res.setHeader('Cache-Control', 'no-store');
  return ok(res, { html: result.html, base64: result.pdf.toString('base64'), pages: result.pages });
}));
router.post('/documents/:id/source-items', write, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), body = z.object({ expected_revision: z.number().int().nonnegative(), mappings: z.array(z.object({ line: z.number().int().min(0).max(99), item_id: z.string().min(1) }).strict()).min(1).max(100) }).strict().parse(req.body);
  if (new Set(body.mappings.map(m => m.line)).size !== body.mappings.length) throw badRequest('Choose each line once');
  const result = await financialTransaction(async tx => {
    const d = await tx.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) } });
    if (!d) throw notFound('Document not found');
    if (d.revision !== body.expected_revision) throw conflict('Document changed. Reload before linking purchase items.');
    if (!(d.kind === 'order' && ['confirmed', 'fulfilling'].includes(d.status) || d.kind === 'sale' && d.status === 'draft')) throw conflict('Confirm the order or open an invoice draft before preparing purchase items');
    const lines = structuredClone(d.lines) as z.infer<typeof documentSchema>['lines'];
    for (const mapping of body.mappings) {
      const line = lines[mapping.line];
      if (!line || line.source !== 'external' || line.item_id) throw badRequest('Choose an unlinked external item line');
      if (!Number.isInteger(line.quantity)) throw badRequest('Inventory quantities must be whole numbers');
      if (!await tx.inventoryItem.findFirst({ where: { ...scoped(auth), id: mapping.item_id, isActive: true } })) throw notFound('Catalog item not found');
      line.item_id = mapping.item_id;
    }
    const saved = await tx.businessDocument.update({ where: { id: d.id }, data: { lines: json(lines), revision: { increment: 1 }, events: json([...(d.events as unknown[]), event('purchase_items_linked', auth.userId)]) } });
    await audit(tx, auth, d.id, 'accounting.purchase_items.linked', body.mappings); return saved;
  }); return ok(res, mapDoc(result));
}));
router.post('/documents', write, validateBody(documentSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const b = documentSchema.parse(req.body);
    const d = await financialTransaction(async (tx) => {
        const existing = await tx.businessDocument.findFirst({ where: { ...scoped(auth), requestKey: b.request_key } });
        if (existing) {
            if (existing.kind !== b.kind || existing.customerId !== b.customer_id || (existing.referrerId ?? null) !== (b.referrer_id ?? null) || (existing.quotationPersonId ?? null) !== (b.quotation_person_id ?? null))
                throw conflict('Request key already used');
            return existing;
        }
        const p = await tx.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId } });
        const settings = workflow(p.commerceSettings);
        allowDirect(b.kind, settings);
        const customer = await tx.customer.findFirst({ where: { id: b.customer_id, ...scoped(auth), isActive: true } });
        if (!customer)
            throw notFound('Active customer not found');
        const person = await quotationPerson(tx, auth, customer.id, b.quotation_person_id);
        const referral = await referrerSnapshot(tx, auth, b.referrer_id);
        const presentation = await documentPresentation(tx, auth, b.presentation);
        await lockSetup(tx, auth);
        const charges = b.additional_charges ?? [];
        const taxSnapshot = await documentTax(tx, auth, b.kind === 'order' ? 'sale' : b.kind, b.lines.map(l => Math.round(l.quantity * l.unit_price)), b.discount, b.tax_selection, b.tax, undefined, charges);
        const legacy = calculate(b.lines, b.discount, b.tax, charges);
        const totals = taxSnapshot ? { ...legacy, subtotal: taxSnapshot.subtotal + b.discount, total: taxSnapshot.payable } : legacy;
        if (b.expected_total !== undefined && b.expected_total !== totals.total) throw conflict('The calculated total changed. Review the document again.');
        if (b.due_date && b.due_date < b.document_date)
            throw badRequest('Due date must be on or after document date');
        await validateItems(tx, auth, b.lines);
        const detailedLines = await snapshotItemDetails(tx, auth, totals.lines, presentation.itemDetails);
        const location = b.location_id ? await stockLocation(tx, auth, b.location_id) : null;
        const d = await tx.businessDocument.create({ data: { ...scoped(auth), stockLocationId: location?.id, ...person, ...referral, presentationSnapshot: json(presentation), customerId: customer.id, customerSnapshot: json({ name: customer.name, mobile: customer.mobile, email: customer.email, address: customer.address, attributes: customer.attributes }), kind: b.kind, number: await nextDocumentNumber(tx, auth, b.kind, b.document_date), status: 'draft', lines: json(detailedLines), additionalCharges: json(charges), subtotal: totals.subtotal, discount: b.discount, tax: taxSnapshot?.tax ?? b.tax, taxSnapshot: taxSnapshot ? json(taxSnapshot) : Prisma.DbNull, total: totals.total, documentDate: atDate(b.document_date), dueDate: b.due_date ? atDate(b.due_date) : null, note: b.note, workflow: settings, events: [event('draft', auth.userId)], requestKey: b.request_key, createdById: auth.userId } });
        await audit(tx, auth, d.id, 'accounting.document.created', { number: d.number, total: d.total, kind: d.kind, referrer_id: d.referrerId });
        return d;
    });
    return created(res, mapDoc(d));
}));
const editSchema = documentSchema.omit({ kind: true, request_key: true });
router.patch('/documents/:id', write, validateBody(editSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const b = editSchema.parse(req.body);
    const d = await financialTransaction(async (tx) => {
        const old = await tx.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) }, include: { next: true } });
        if (!old)
            throw notFound('Document not found');
        const revisingQuotation = old.kind === 'quotation' && ['sent', 'accepted'].includes(old.status);
        if (old.next || old.status !== 'draft' && !revisingQuotation)
            throw conflict('Only drafts and unconverted sent or accepted quotations can be edited');
        if (b.expected_revision !== undefined && b.expected_revision !== old.revision || revisingQuotation && b.expected_revision === undefined) throw conflict('This document changed. Reload before editing.');
        const customer = await tx.customer.findFirst({ where: { id: b.customer_id, ...scoped(auth), isActive: true } });
        if (!customer)
            throw notFound('Active customer not found');
        const person = await quotationPerson(tx, auth, customer.id, b.quotation_person_id, old);
        const referral = await referrerSnapshot(tx, auth, b.referrer_id, old);
        const presentation = await documentPresentation(tx, auth, b.presentation, old.presentationSnapshot);
        if (b.due_date && b.due_date < b.document_date)
            throw badRequest('Due date must be on or after document date');
        await validateItems(tx, auth, b.lines);
        await lockSetup(tx, auth);
        const charges = b.additional_charges ?? chargesSchema.parse(old.additionalCharges ?? []);
        const taxSnapshot = await documentTax(tx, auth, old.kind === 'quotation' ? 'quotation' : 'sale', b.lines.map(l => Math.round(l.quantity * l.unit_price)), b.discount, b.tax_selection, b.tax, old.taxSnapshot ?? { legacy: true, tax: old.tax }, charges);
        const legacy = calculate(b.lines, b.discount, b.tax, charges);
        const totals = taxSnapshot ? { ...legacy, subtotal: taxSnapshot.subtotal + b.discount, total: taxSnapshot.payable } : legacy;
        if (b.expected_total !== undefined && b.expected_total !== totals.total) throw conflict('The calculated total changed. Review the document again.');
        const detailedLines = await snapshotItemDetails(tx, auth, totals.lines, presentation.itemDetails, old);
        const location = b.location_id ? await stockLocation(tx, auth, b.location_id) : null;
        const row = await tx.businessDocument.update({ where: { id: old.id }, data: { revision: { increment: 1 }, status: old.status === 'accepted' ? 'sent' : old.status, stockLocationId: b.location_id === undefined ? old.stockLocationId : location?.id ?? null, ...person, ...referral, presentationSnapshot: json(presentation), customerId: customer.id, customerSnapshot: json({ name: customer.name, mobile: customer.mobile, email: customer.email, address: customer.address, attributes: customer.attributes }), lines: json(detailedLines), additionalCharges: json(charges), subtotal: totals.subtotal, total: totals.total, discount: b.discount, tax: taxSnapshot?.tax ?? b.tax, taxSnapshot: taxSnapshot ? json(taxSnapshot) : Prisma.DbNull, documentDate: atDate(b.document_date), dueDate: b.due_date ? atDate(b.due_date) : null, note: b.note ?? null, events: json([...(old.events as unknown[]), { ...event(revisingQuotation ? 'quotation_revised' : 'draft_updated', auth.userId), revision: old.revision + 1, ...(old.status === 'accepted' ? { previousStatus: 'accepted', requiresAcceptance: true } : {}) }]) } });
        await audit(tx, auth, row.id, 'accounting.document.updated', { ...row, referrer_id: row.referrerId }, old);
        return row;
    });
    return ok(res, mapDoc(d));
}));
const actionSchema = z.object({ expected_revision: z.number().int().nonnegative().optional(), action: z.enum(['send', 'accept', 'reject', 'expire', 'confirm', 'fulfill', 'issue', 'cancel']) }).strict();
router.post('/documents/:id/status', write, validateBody(actionSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const b = actionSchema.parse(req.body);
    const updated = await financialTransaction(async (tx) => {
        const d = await tx.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) } });
        if (!d)
            throw notFound('Document not found');
        if (b.expected_revision !== undefined && b.expected_revision !== d.revision) throw conflict('This document changed. Review a fresh draft before changing its status.');
        const status = nextStatus(kindSchema.parse(d.kind), d.status, b.action, d.paidAmount);
        const tracked = d.kind === 'sale' && b.action === 'issue' ? await stockEnabled(tx, auth) : d.stockTracked;
        const location = d.kind === 'sale' && b.action === 'issue' && tracked ? await stockLocation(tx, auth, d.stockLocationId) : null;
        if (d.kind === 'sale' && b.action === 'issue' && tracked && (d.lines as { source?: string; item_id?: string }[]).some(line => line.source === 'external' && !line.item_id)) throw conflict('Link external items to the catalog and receive their purchase stock before issuing this invoice');
        if (d.kind === 'sale' && (b.action === 'issue' && tracked || b.action === 'cancel' && d.status === 'issued' && d.stockTracked !== false))
            await changeStock(tx, auth, d, b.action === 'issue' ? -1 : 1);
        if (d.kind === 'sale' && (b.action === 'issue' || b.action === 'cancel' && d.status === 'issued')) await postTax(tx, auth, 'business_sale', d.id, d.taxSnapshot, 'output', b.action === 'cancel');
        const row = await tx.businessDocument.update({ where: { id: d.id }, data: { revision: { increment: 1 }, status, ...(b.action === 'issue' ? { stockTracked: tracked, stockLocationId: location?.id ?? d.stockLocationId } : {}), events: json([...(d.events as unknown[]), event(status, auth.userId)]) } });
        await audit(tx, auth, d.id, `accounting.document.${b.action}`, { before: d.status, status });
        return row;
    });
    return ok(res, mapDoc(updated));
}));
const convertSchema = z.object({ expected_revision: z.number().int().nonnegative().optional(), kind: kindSchema, document_date: dateSchema, due_date: dateSchema.optional(), request_key: z.string().uuid() }).strict();
router.post('/documents/:id/convert', write, validateBody(convertSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const b = convertSchema.parse(req.body);
    const result = await financialTransaction(async (tx) => {
        const existing = await tx.businessDocument.findFirst({ where: { ...scoped(auth), requestKey: b.request_key } });
        if (existing) {
            if (existing.sourceId !== req.params.id || existing.kind !== b.kind)
                throw conflict('Request key already used');
            return existing;
        }
        const source = await tx.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) }, include: { next: true } });
        if (!source)
            throw notFound('Document not found');
        if (b.expected_revision !== undefined && b.expected_revision !== source.revision) throw conflict('This document changed. Review a fresh draft before converting.');
        if (source.next)
            throw conflict('This document has already been converted');
        conversion(kindSchema.parse(source.kind), source.status, b.kind, workflow(source.workflow));
        if (b.due_date && b.due_date < b.document_date)
            throw badRequest('Due date must be on or after document date');
        const d = await tx.businessDocument.create({ data: { ...scoped(auth), stockLocationId: source.stockLocationId, presentationSnapshot: source.presentationSnapshot ? json(source.presentationSnapshot) : Prisma.DbNull, referrerId: source.referrerId, referrerSnapshot: source.referrerSnapshot ? json(source.referrerSnapshot) : Prisma.DbNull, quotationPersonId: source.quotationPersonId, quotationPersonSnapshot: source.quotationPersonSnapshot ? json(source.quotationPersonSnapshot) : Prisma.DbNull, customerId: source.customerId, customerSnapshot: json(source.customerSnapshot), kind: b.kind, number: await nextDocumentNumber(tx, auth, b.kind, b.document_date), status: 'draft', lines: json(source.lines), additionalCharges: json(source.additionalCharges ?? []), subtotal: source.subtotal, discount: source.discount, tax: source.tax, taxSnapshot: source.taxSnapshot ? json(source.taxSnapshot) : Prisma.DbNull, total: source.total, documentDate: atDate(b.document_date), dueDate: b.due_date ? atDate(b.due_date) : null, note: source.note, workflow: json(source.workflow), events: [event('draft', auth.userId)], sourceId: source.id, requestKey: b.request_key, createdById: auth.userId } });
        await tx.businessDocument.update({ where: { id: source.id }, data: { revision: { increment: 1 }, status: source.kind === 'quotation' ? 'converted' : 'completed', events: json([...(source.events as unknown[]), event(source.kind === 'quotation' ? 'converted' : 'completed', auth.userId)]) } });
        await audit(tx, auth, d.id, 'accounting.document.converted', { source_id: source.id, kind: b.kind, referrer_id: d.referrerId });
        return d;
    });
    return created(res, mapDoc(result));
}));
const paymentSchema = z.object({ account_id: z.string().min(1), amount: z.number().int().positive().max(2147483647), payment_date: pastDateSchema, reference: z.string().max(120).optional(), request_key: z.string().uuid() }).strict();
router.post('/documents/:id/payments', requireRoles('accountant', 'cashier'), validateBody(paymentSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const b = paymentSchema.parse(req.body);
    const result = await financialTransaction(async (tx) => {
        const previous = await tx.businessPayment.findFirst({ where: { ...scoped(auth), requestKey: b.request_key } });
        if (previous) {
            if (previous.documentId !== req.params.id || previous.amount !== b.amount || previous.accountId !== b.account_id || previous.reference !== (b.reference ?? null) || previous.paymentDate.toISOString().slice(0, 10) !== b.payment_date)
                throw conflict('Request key already used for a different payment');
            return previous;
        }
        const d = await tx.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) } });
        if (!d)
            throw notFound('Invoice not found');
        if (d.kind !== 'sale' || d.status !== 'issued')
            throw conflict('Issue the sale invoice before recording a payment');
        if (b.amount > d.total - d.paidAmount)
            throw conflict('Payment exceeds the remaining receivable');
        const account = await tx.account.findFirst({ where: { id: b.account_id, ...scoped(auth) } });
        if (!account)
            throw notFound('Account not found');
        if (account.balance > 2147483647 - b.amount)
            throw badRequest('Account balance would exceed the supported amount');
        const p = await tx.businessPayment.create({ data: { ...scoped(auth), documentId: d.id, accountId: account.id, accountName: account.name, amount: b.amount, paymentDate: atDate(b.payment_date), reference: b.reference, requestKey: b.request_key, createdById: auth.userId } });
        const updated = await tx.account.update({ where: { id: account.id }, data: { balance: { increment: b.amount } } });
        await tx.businessDocument.update({ where: { id: d.id }, data: { revision: { increment: 1 }, paidAmount: { increment: b.amount }, events: json([...(d.events as unknown[]), { ...event(d.paidAmount + b.amount === d.total ? 'paid' : 'partial', auth.userId), amount: b.amount, payment_id: p.id }]) } });
        await tx.accountTransaction.create({ data: { ...scoped(auth), accountId: account.id, direction: 'money_in', amount: b.amount, balanceAfter: updated.balance, referenceType: 'receivable_payment', referenceId: p.id, description: `Payment for ${d.number}`, occurredOn: p.paymentDate, createdById: auth.userId } });
        await audit(tx, auth, d.id, 'accounting.payment.recorded', { payment_id: p.id, amount: b.amount, account_id: account.id });
        return p;
    });
    return created(res, result);
}));
async function validateItems(tx: Prisma.TransactionClient, auth: ReturnType<typeof requireProjectContext>, lines: {
    item_id?: string;
    source?: string;
    quantity: number;
}[]) {
    if (lines.some(line => line.source === 'external' && !Number.isInteger(line.quantity))) throw badRequest('External inventory quantities must be whole numbers');
    for (const line of lines.filter(l => l.item_id)) {
        if (!Number.isInteger(line.quantity))
            throw badRequest('Inventory item quantities must be whole numbers');
        if (!await tx.inventoryItem.findFirst({ where: { id: line.item_id, ...scoped(auth), isActive: true } }))
            throw notFound('Inventory item not found');
    }
}
async function changeStock(tx: Prisma.TransactionClient, auth: ReturnType<typeof requireProjectContext>, d: BusinessDocument, direction: number) {
    const lines = d.lines as unknown as {
        item_id?: string;
        quantity: number;
    }[];
    const quantities = new Map<string, number>();
    for (const l of lines)
        if (l.item_id)
            quantities.set(l.item_id, (quantities.get(l.item_id) ?? 0) + l.quantity);
    for (const [id, qty] of [...quantities.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        await changeItemStock(tx, auth, { itemId: id, delta: qty * direction, locationId: d.stockLocationId, type: direction < 0 ? 'sale' : 'adjustment_increase', referenceType: 'business_sale', referenceId: d.id, reason: direction < 0 ? 'Invoice issued' : 'Unpaid invoice cancelled', restoring: direction > 0 });
    }
}
router.get('/documents/:id/document.pdf', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const d = await prisma.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) } });
  if (!d) throw notFound('Document not found');
  const p = await prisma.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId }, include: { tenant: true } });
  const result = await buildProfessionalDocument(d, p.tenant.currency, p.tenant.name, await documentLogo(prisma, auth, d.presentationSnapshot));
  res.setHeader('Cache-Control', 'private, no-store');
  res.type('pdf').setHeader('Content-Disposition', `inline; filename="${d.number.replace(/[^a-z0-9-]/gi, '_')}.pdf"`); return res.send(result.pdf);
}));
export { router as accountingRouter };
