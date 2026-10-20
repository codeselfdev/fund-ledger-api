import { buildBillingPdf } from '../billing/billing.pdf.js';
import { taxPdfLines } from '../business-setup/pdf.js';
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
import { allowDirect, calculate, conversion, dateSchema, documentSchema, kindSchema, nextStatus, pastDateSchema, paymentStatus, workflow, workflowSchema, type Kind } from './workflow.js';
import { financialTransaction } from './transaction.js';
const router = Router();
const read = requireRoles('accountant', 'cashier', 'approver', 'auditor');
const write = requireRoles('accountant', 'cashier');
const scoped = (auth: {
    tenantId: string;
    projectId: string;
}) => ({ tenantId: auth.tenantId, projectId: auth.projectId });
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const atDate = (value: string) => new Date(`${value}T00:00:00Z`);
const docInclude = { payments: { orderBy: { createdAt: 'desc' as const } }, source: { select: { id: true, kind: true, number: true } }, next: { select: { id: true, kind: true, number: true } } };
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
    return ok(res, { workflow: workflow(p.commerceSettings), customers, invoiced: sales.reduce((n, d) => n + d.total, 0), collected: sales.reduce((n, d) => n + d.paidAmount, 0), receivable: sales.reduce((n, d) => n + d.total - d.paidAmount, 0), overdue: sales.filter(d => paymentStatus(d) === 'overdue').reduce((n, d) => n + d.total - d.paidAmount, 0), counts: { quotation: docs.filter(d => d.kind === 'quotation').length, order: docs.filter(d => d.kind === 'order').length, sale: sales.length }, recent: docs.slice(0, 5).map(mapDoc) });
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
async function audit(tx: Prisma.TransactionClient, auth: ReturnType<typeof requireProjectContext>, id: string, action: string, detail: unknown) {
    await tx.activity.create({ data: { ...scoped(auth), actorUserId: auth.userId, action, entityType: 'business_document', entityId: id, after: json(detail) } });
}
router.post('/documents', write, validateBody(documentSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const b = documentSchema.parse(req.body);
    const d = await financialTransaction(async (tx) => {
        const existing = await tx.businessDocument.findFirst({ where: { ...scoped(auth), requestKey: b.request_key } });
        if (existing) {
            if (existing.kind !== b.kind || existing.customerId !== b.customer_id)
                throw conflict('Request key already used');
            return existing;
        }
        const p = await tx.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId } });
        const settings = workflow(p.commerceSettings);
        allowDirect(b.kind, settings);
        const customer = await tx.customer.findFirst({ where: { id: b.customer_id, ...scoped(auth), isActive: true } });
        if (!customer)
            throw notFound('Active customer not found');
        await lockSetup(tx, auth);
        const taxSnapshot = await documentTax(tx, auth, b.kind === 'order' ? 'sale' : b.kind, b.lines.map(l => Math.round(l.quantity * l.unit_price)), b.discount, b.tax_selection, b.tax, undefined);
        const legacy = calculate(b.lines, b.discount, b.tax);
        const totals = taxSnapshot ? { ...legacy, subtotal: taxSnapshot.subtotal + b.discount, total: taxSnapshot.payable } : legacy;
        if (b.due_date && b.due_date < b.document_date)
            throw badRequest('Due date must be on or after document date');
        await validateItems(tx, auth, b.lines);
        const d = await tx.businessDocument.create({ data: { ...scoped(auth), customerId: customer.id, customerSnapshot: json({ name: customer.name, mobile: customer.mobile, email: customer.email, address: customer.address, attributes: customer.attributes }), kind: b.kind, number: `${b.kind === 'quotation' ? 'QUO' : b.kind === 'order' ? 'ORD' : 'INV'}-${randomUUID().slice(0, 8).toUpperCase()}`, status: 'draft', lines: totals.lines, subtotal: totals.subtotal, discount: b.discount, tax: taxSnapshot?.tax ?? b.tax, taxSnapshot: taxSnapshot ? json(taxSnapshot) : Prisma.DbNull, total: totals.total, documentDate: atDate(b.document_date), dueDate: b.due_date ? atDate(b.due_date) : null, note: b.note, workflow: settings, events: [event('draft', auth.userId)], requestKey: b.request_key, createdById: auth.userId } });
        await audit(tx, auth, d.id, 'accounting.document.created', { number: d.number, total: d.total, kind: d.kind });
        return d;
    });
    return created(res, mapDoc(d));
}));
const editSchema = documentSchema.omit({ kind: true, request_key: true });
router.patch('/documents/:id', write, validateBody(editSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const b = editSchema.parse(req.body);
    const d = await financialTransaction(async (tx) => {
        const old = await tx.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) } });
        if (!old)
            throw notFound('Document not found');
        if (old.status !== 'draft')
            throw conflict('Only draft documents can be edited');
        const customer = await tx.customer.findFirst({ where: { id: b.customer_id, ...scoped(auth), isActive: true } });
        if (!customer)
            throw notFound('Active customer not found');
        if (b.due_date && b.due_date < b.document_date)
            throw badRequest('Due date must be on or after document date');
        await validateItems(tx, auth, b.lines);
        await lockSetup(tx, auth);
        const taxSnapshot = await documentTax(tx, auth, old.kind === 'quotation' ? 'quotation' : 'sale', b.lines.map(l => Math.round(l.quantity * l.unit_price)), b.discount, b.tax_selection, b.tax, old.taxSnapshot ?? { legacy: true, tax: old.tax });
        const legacy = calculate(b.lines, b.discount, b.tax);
        const totals = taxSnapshot ? { ...legacy, subtotal: taxSnapshot.subtotal + b.discount, total: taxSnapshot.payable } : legacy;
        const row = await tx.businessDocument.update({ where: { id: old.id }, data: { customerId: customer.id, customerSnapshot: json({ name: customer.name, mobile: customer.mobile, email: customer.email, address: customer.address, attributes: customer.attributes }), lines: totals.lines, subtotal: totals.subtotal, total: totals.total, discount: b.discount, tax: taxSnapshot?.tax ?? b.tax, taxSnapshot: taxSnapshot ? json(taxSnapshot) : Prisma.DbNull, documentDate: atDate(b.document_date), dueDate: b.due_date ? atDate(b.due_date) : null, note: b.note ?? null, events: json([...(old.events as unknown[]), event('draft_updated', auth.userId)]) } });
        await audit(tx, auth, row.id, 'accounting.document.updated', { total: row.total });
        return row;
    });
    return ok(res, mapDoc(d));
}));
const actionSchema = z.object({ action: z.enum(['send', 'accept', 'reject', 'expire', 'confirm', 'fulfill', 'issue', 'cancel']) }).strict();
router.post('/documents/:id/status', write, validateBody(actionSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const b = actionSchema.parse(req.body);
    const updated = await financialTransaction(async (tx) => {
        const d = await tx.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) } });
        if (!d)
            throw notFound('Document not found');
        const status = nextStatus(kindSchema.parse(d.kind), d.status, b.action, d.paidAmount);
        if (d.kind === 'sale' && (b.action === 'issue' || b.action === 'cancel' && d.status === 'issued'))
            await changeStock(tx, auth, d, b.action === 'issue' ? -1 : 1);
        if (d.kind === 'sale' && (b.action === 'issue' || b.action === 'cancel' && d.status === 'issued')) await postTax(tx, auth, 'business_sale', d.id, d.taxSnapshot, 'output', b.action === 'cancel');
        const row = await tx.businessDocument.update({ where: { id: d.id }, data: { status, events: json([...(d.events as unknown[]), event(status, auth.userId)]) } });
        await audit(tx, auth, d.id, `accounting.document.${b.action}`, { before: d.status, status });
        return row;
    });
    return ok(res, mapDoc(updated));
}));
const convertSchema = z.object({ kind: kindSchema, document_date: dateSchema, due_date: dateSchema.optional(), request_key: z.string().uuid() }).strict();
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
        if (source.next)
            throw conflict('This document has already been converted');
        conversion(kindSchema.parse(source.kind), source.status, b.kind, workflow(source.workflow));
        if (b.due_date && b.due_date < b.document_date)
            throw badRequest('Due date must be on or after document date');
        const d = await tx.businessDocument.create({ data: { ...scoped(auth), customerId: source.customerId, customerSnapshot: json(source.customerSnapshot), kind: b.kind, number: `${b.kind === 'order' ? 'ORD' : 'INV'}-${randomUUID().slice(0, 8).toUpperCase()}`, status: 'draft', lines: json(source.lines), subtotal: source.subtotal, discount: source.discount, tax: source.tax, taxSnapshot: source.taxSnapshot ? json(source.taxSnapshot) : Prisma.DbNull, total: source.total, documentDate: atDate(b.document_date), dueDate: b.due_date ? atDate(b.due_date) : null, note: source.note, workflow: json(source.workflow), events: [event('draft', auth.userId)], sourceId: source.id, requestKey: b.request_key, createdById: auth.userId } });
        await tx.businessDocument.update({ where: { id: source.id }, data: { status: source.kind === 'quotation' ? 'converted' : 'completed', events: json([...(source.events as unknown[]), event(source.kind === 'quotation' ? 'converted' : 'completed', auth.userId)]) } });
        await audit(tx, auth, d.id, 'accounting.document.converted', { source_id: source.id, kind: b.kind });
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
        await tx.businessDocument.update({ where: { id: d.id }, data: { paidAmount: { increment: b.amount }, events: json([...(d.events as unknown[]), { ...event(d.paidAmount + b.amount === d.total ? 'paid' : 'partial', auth.userId), amount: b.amount, payment_id: p.id }]) } });
        await tx.accountTransaction.create({ data: { ...scoped(auth), accountId: account.id, direction: 'money_in', amount: b.amount, balanceAfter: updated.balance, referenceType: 'receivable_payment', referenceId: p.id, description: `Payment for ${d.number}`, occurredOn: p.paymentDate, createdById: auth.userId } });
        await audit(tx, auth, d.id, 'accounting.payment.recorded', { payment_id: p.id, amount: b.amount, account_id: account.id });
        return p;
    });
    return created(res, result);
}));
async function validateItems(tx: Prisma.TransactionClient, auth: ReturnType<typeof requireProjectContext>, lines: {
    item_id?: string;
    quantity: number;
}[]) {
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
        const item = await tx.inventoryItem.findFirst({ where: { id, ...scoped(auth) } });
        if (!item)
            throw notFound('Inventory item not found');
        const result = await tx.inventoryItem.updateMany({ where: { id, ...scoped(auth), ...(direction < 0 ? { quantity: { gte: qty } } : {}) }, data: { quantity: { increment: qty * direction } } });
        if (!result.count)
            throw conflict(`Insufficient stock for ${item.name}`);
        await tx.stockMovement.create({ data: { ...scoped(auth), itemId: id, type: direction < 0 ? 'sale' : 'adjustment_increase', quantity: qty * direction, quantityAfter: item.quantity + qty * direction, referenceType: 'business_sale', referenceId: d.id, reason: direction < 0 ? 'Invoice issued' : 'Unpaid invoice cancelled', createdById: auth.userId } });
    }
}
router.get('/documents/:id/document.pdf', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const d = await prisma.businessDocument.findFirst({ where: { id: req.params.id, ...scoped(auth) } });
  if (!d) throw notFound('Document not found');
  const p = await prisma.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId }, include: { tenant: true } });
  const lines = d.lines as { description: string; quantity: number; unit_price: number; line_total: number }[];
  const buffer = await buildBillingPdf(`${d.kind === 'quotation' ? 'Quotation' : d.kind === 'order' ? 'Order' : 'Invoice'} ${d.number}`, p.name, p.tenant.currency, (d.customerSnapshot as { name: string }).name, [
    `Date: ${d.documentDate.toISOString().slice(0, 10)} | Status: ${d.status}`, ...(d.dueDate ? [`Due / expiry: ${d.dueDate.toISOString().slice(0, 10)}`] : []),
    ...lines.map(l => `${l.description}: ${l.quantity} x ${l.unit_price} = ${l.line_total}`), ...taxPdfLines(d.taxSnapshot, d), d.note ?? '',
  ].filter(Boolean));
  res.type('pdf').setHeader('Content-Disposition', 'inline; filename="business-document.pdf"'); return res.send(buffer);
}));
export { router as accountingRouter };
