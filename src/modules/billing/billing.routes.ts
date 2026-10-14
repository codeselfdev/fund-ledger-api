import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { created, ok } from '../../core/http/response.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody, validateQuery } from '../../core/validation/validate.js';
import { financialTransaction } from '../accounting/transaction.js';
import { customersRouter } from '../customers/customers.routes.js';
import { billingMenus } from './billing.menu.js';
import { settingsSchema, settings, planSchema, unitSchema, assignmentSchema, invoiceSchema, paymentSchema, adjustmentSchema, periodSchema, dateSchema, pastDateSchema, id, requestKey, money, hash, json, calculate, atDate, day, today, mapInvoice, outstanding } from './billing.policy.js';
import { scope, audit, sameRequest, customer, invoice, issueInvoice, generateAssignment, collect, applyAdvance, requestAdjustment, decideAdjustment, applyLateFees, queueReminders } from './billing.service.js';
import { report, ledger } from './billing.reports.js';
import { buildBillingPdf } from './billing.pdf.js';
const router = Router();
const read = requireRoles('accountant', 'cashier', 'approver', 'auditor');
const write = requireRoles('accountant');
router.use(requireProject, read, asyncHandler(async (req, _res, next) => {
    const a = requireProjectContext(req);
    const p = await prisma.project.findFirst({ where: { id: a.projectId, tenantId: a.tenantId, isActive: true } });
    if (!p || p.projectType !== 'billing')
        throw forbidden('This feature belongs to Billing Management projects');
    next();
}));
router.get('/configuration', asyncHandler(async (req, res) => {
    const a = requireProjectContext(req);
    const p = await prisma.project.findFirstOrThrow({ where: { id: a.projectId, tenantId: a.tenantId } });
    return ok(res, { settings: settings(p.billingSettings), menus: billingMenus(a.roles), categories: [
            { key: 'apartment_community', label: 'Apartment & Community Billing', charges: ['Service charge', 'Maintenance', 'Security', 'Parking', 'Water', 'Generator', 'Lift', 'Shared electricity'] },
            { key: 'isp_subscription', label: 'ISP & Subscription Billing', charges: ['Internet package', 'Installation', 'Renewal', 'Reseller billing'] },
            { key: 'rental_property', label: 'Rental & Property Billing', charges: ['House rent', 'Commercial rent', 'Security deposit', 'Utilities'] },
            { key: 'general_business', label: 'General Business Billing', charges: ['Service invoice', 'Membership', 'Education', 'Maintenance contract', 'Installments'] }
        ] });
}));
router.put('/configuration', requireRoles('admin'), validateBody(settingsSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = settingsSchema.parse(req.body);
    await financialTransaction(async (tx) => { await tx.project.update({ where: { id: a.projectId }, data: { billingSettings: b } }); await audit(tx, a, 'settings.updated', 'project', a.projectId, b); });
    return ok(res, b);
}));
router.use('/customers', (req, res, next) => req.method === 'GET' ? next() : write(req, res, next), customersRouter);
// The shared router handles customer profiles; the following routes add billing history.
const rangeSchema = z.object({ from: dateSchema.optional(), to: dateSchema.optional() }).strict().refine(v => !v.from || !v.to || v.from <= v.to, 'Date range is reversed');
router.get('/customers/:id/ledger', validateQuery(rangeSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), q = rangeSchema.parse(req.query);
    return ok(res, await ledger(a, req.params.id, q.from, q.to));
}));
router.get('/customers/:id/statement.pdf', validateQuery(rangeSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), q = rangeSchema.parse(req.query);
    const result = await ledger(a, req.params.id, q.from, q.to);
    const p = await prisma.project.findFirstOrThrow({ where: { id: a.projectId, tenantId: a.tenantId }, include: { tenant: true } });
    const buffer = await buildBillingPdf('Customer Statement', p.name, p.tenant.currency, result.customer.name, [
        `Opening balance: ${result.opening_balance}`, ...result.entries.map(e => `${e.date} | ${e.type} | ${e.reference} | ${e.amount} | Balance ${e.balance}`),
        `Closing balance: ${result.closing_balance}`, `Current outstanding: ${result.outstanding}; current advance: ${result.advance}`
    ]);
    res.type('pdf').setHeader('Content-Disposition', 'inline; filename="customer-statement.pdf"');
    return res.send(buffer);
}));
router.post('/customers/:id/apply-advance', write, asyncHandler(async (req, res) => {
    const a = requireProjectContext(req);
    return ok(res, await financialTransaction(async (tx) => { await customer(tx, a, req.params.id, false); return applyAdvance(tx, a, req.params.id); }));
}));
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0), customer_id: id.optional() }).strict();
router.get('/plans', asyncHandler(async (req, res) => { const a = requireProjectContext(req); return ok(res, await prisma.billingPlan.findMany({ where: scope(a), orderBy: { name: 'asc' } })); }));
router.post('/plans', write, validateBody(planSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = planSchema.parse(req.body);
    if (b.mode === 'installment' && b.amount < b.installment_count!)
        throw badRequest('Contract value must cover every installment');
    const row = await financialTransaction(async (tx) => {
        const row = await tx.billingPlan.create({ data: { ...scope(a), ...planData(b) } });
        await audit(tx, a, 'plan.created', 'billing_plan', row.id, row);
        return row;
    });
    return created(res, row);
}));
router.patch('/plans/:id', write, validateBody(planSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = planSchema.parse(req.body);
    if (b.mode === 'installment' && b.amount < b.installment_count!)
        throw badRequest('Contract value must cover every installment');
    const row = await financialTransaction(async (tx) => {
        const old = await tx.billingPlan.findFirst({ where: { id: req.params.id, ...scope(a) } });
        if (!old)
            throw notFound('Plan not found');
        if (await tx.billingAssignment.count({ where: { ...scope(a), planId: old.id } }) && (old.mode !== b.mode || old.intervalMonths !== b.interval_months || old.installmentCount !== (b.installment_count ?? null) || old.mode === 'installment' && old.amount !== b.amount))
            throw conflict('Create a new plan to change an assigned billing cycle or installment contract');
        const row = await tx.billingPlan.update({ where: { id: old.id }, data: planData(b) });
        await audit(tx, a, 'plan.updated', 'billing_plan', row.id, { before: old, after: row });
        return row;
    });
    return ok(res, row);
}));
function planData(b: z.infer<typeof planSchema>) { return { name: b.name, category: b.category, mode: b.mode, amount: b.amount, intervalMonths: b.interval_months, installmentCount: b.installment_count ?? null, dueDays: b.due_days, graceDays: b.grace_days, lateFeeType: b.late_fee_type, lateFeeValue: b.late_fee_value, escalationBps: b.escalation_bps, escalationMonths: b.escalation_months, isActive: b.is_active }; }
router.get('/units', asyncHandler(async (req, res) => { const a = requireProjectContext(req); return ok(res, await prisma.billingUnit.findMany({ where: scope(a), orderBy: { name: 'asc' } })); }));
router.post('/units', write, validateBody(unitSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = unitSchema.parse(req.body);
    const row = await financialTransaction(async (tx) => { const row = await tx.billingUnit.create({ data: { ...scope(a), name: b.name, kind: b.kind, note: b.note, isActive: b.is_active } }); await audit(tx, a, 'unit.created', 'billing_unit', row.id, row); return row; });
    return created(res, row);
}));
router.patch('/units/:id', write, validateBody(unitSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = unitSchema.parse(req.body);
    const row = await financialTransaction(async (tx) => { const old = await tx.billingUnit.findFirst({ where: { id: req.params.id, ...scope(a) } }); if (!old)
        throw notFound('Unit not found'); const row = await tx.billingUnit.update({ where: { id: old.id }, data: { name: b.name, kind: b.kind, note: b.note ?? null, isActive: b.is_active } }); await audit(tx, a, 'unit.updated', 'billing_unit', row.id, row); return row; });
    return ok(res, row);
}));
router.get('/assignments', validateQuery(listSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), q = listSchema.parse(req.query);
    return ok(res, await prisma.billingAssignment.findMany({ where: { ...scope(a), customerId: q.customer_id }, include: { plan: true, unit: true }, orderBy: { createdAt: 'desc' }, take: q.limit, skip: q.offset }));
}));
router.post('/assignments', write, validateBody(assignmentSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = assignmentSchema.parse(req.body);
    const row = await financialTransaction(async (tx) => {
        await customer(tx, a, b.customer_id);
        if (!await tx.billingPlan.findFirst({ where: { id: b.plan_id, ...scope(a), isActive: true } }))
            throw notFound('Active plan not found');
        if (b.unit_id && !await tx.billingUnit.findFirst({ where: { id: b.unit_id, ...scope(a), isActive: true } }))
            throw notFound('Active unit not found');
        const row = await tx.billingAssignment.create({ data: { ...scope(a), customerId: b.customer_id, planId: b.plan_id, unitId: b.unit_id, label: b.label, startDate: atDate(b.start_date), endDate: b.end_date ? atDate(b.end_date) : null } });
        await audit(tx, a, 'assignment.created', 'billing_assignment', row.id, row);
        return row;
    });
    return created(res, row);
}));
const assignmentUpdate = z.object({ status: z.enum(['active', 'suspended', 'disconnected', 'ended']), end_date: dateSchema.nullable().optional() }).strict();
router.patch('/assignments/:id', write, validateBody(assignmentUpdate), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = assignmentUpdate.parse(req.body);
    const row = await financialTransaction(async (tx) => { const old = await tx.billingAssignment.findFirst({ where: { id: req.params.id, ...scope(a) } }); if (!old)
        throw notFound('Assignment not found'); if (b.end_date && b.end_date < day(old.startDate))
        throw badRequest('End date must follow start date'); const row = await tx.billingAssignment.update({ where: { id: old.id }, data: { status: b.status, endDate: b.end_date === undefined ? undefined : b.end_date === null ? null : atDate(b.end_date) } }); await audit(tx, a, 'assignment.updated', 'billing_assignment', row.id, row); return row; });
    return ok(res, row);
}));
const readingSchema = z.object({ assignment_id: id, period_start: periodSchema, previous: money, current: money }).strict().refine(r => r.current >= r.previous, 'Current reading cannot decrease');
router.get('/meter-readings', validateQuery(z.object({ assignment_id: id.optional() }).strict()), asyncHandler(async (req, res) => { const a = requireProjectContext(req), q = z.object({ assignment_id: id.optional() }).parse(req.query); return ok(res, await prisma.billingMeterReading.findMany({ where: { ...scope(a), assignmentId: q.assignment_id }, orderBy: { periodStart: 'desc' } })); }));
router.post('/meter-readings', write, validateBody(readingSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = readingSchema.parse(req.body);
    const row = await financialTransaction(async (tx) => {
        const assignment = await tx.billingAssignment.findFirst({ where: { id: b.assignment_id, ...scope(a) }, include: { plan: true } });
        if (!assignment || assignment.plan.mode !== 'usage')
            throw notFound('Usage assignment not found');
        if (await tx.billingInvoice.findFirst({ where: { ...scope(a), assignmentId: assignment.id, periodStart: atDate(b.period_start) } }))
            throw conflict('Reading is locked after invoicing');
        const old = await tx.billingMeterReading.findFirst({ where: { ...scope(a), assignmentId: assignment.id, periodStart: atDate(b.period_start) } });
        if (old) {
            if (old.previous === b.previous && old.current === b.current)
                return old;
            throw conflict('Reading already exists');
        }
        const latest = await tx.billingMeterReading.findFirst({ where: { ...scope(a), assignmentId: assignment.id }, orderBy: { periodStart: 'desc' } });
        if (latest && (day(latest.periodStart) >= b.period_start || latest.current !== b.previous))
            throw conflict('Record readings chronologically, starting from the last current reading');
        const row = await tx.billingMeterReading.create({ data: { ...scope(a), assignmentId: assignment.id, periodStart: atDate(b.period_start), previous: b.previous, current: b.current, createdById: a.userId } });
        await audit(tx, a, 'meter.recorded', 'billing_meter_reading', row.id, row);
        return row;
    });
    return created(res, row);
}));
const invoiceListSchema = listSchema.extend({ outstanding: z.enum(['true', 'false']).optional() });
router.get('/invoices', validateQuery(invoiceListSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), q = invoiceListSchema.parse(req.query);
    const where = { ...scope(a), customerId: q.customer_id };
    // Derived balances include credits/debits, so filter before paginating.
    const rows = await prisma.billingInvoice.findMany({ where, orderBy: [{ invoiceDate: 'desc' }, { id: 'asc' }] });
    const filtered = q.outstanding === 'true' ? rows.filter(i => outstanding(i) > 0) : rows;
    return ok(res, { entries: filtered.slice(q.offset, q.offset + q.limit).map(i => mapInvoice(i)), total: filtered.length, next_offset: filtered.length > q.offset + q.limit ? q.offset + q.limit : null });
}));
router.post('/invoices', write, validateBody(invoiceSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = invoiceSchema.parse(req.body); return created(res, mapInvoice(await issueInvoice(a, b, calculate(b.lines, b.discount, b.tax)))); }));
const generateSchema = z.object({ period_start: periodSchema }).strict();
router.post('/assignments/:id/invoice', write, validateBody(generateSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = generateSchema.parse(req.body); const result = await financialTransaction(tx => generateAssignment(tx, a, req.params.id, b.period_start)); return created(res, mapInvoice(await invoice(prisma, a, result.invoice_id))); }));
const bulkSchema = generateSchema.extend({ assignment_ids: z.array(id).min(1).max(5000).refine(v => new Set(v).size === v.length, 'Duplicate assignments').optional(), request_key: requestKey });
router.post('/invoice-runs', write, validateBody(bulkSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = bulkSchema.parse(req.body);
    const run = await financialTransaction(async (tx) => {
        const existing = await tx.billingRun.findFirst({ where: { ...scope(a), requestKey: b.request_key } });
        if (existing) {
            sameRequest(existing, b);
            return existing;
        }
        const rows = await tx.billingAssignment.findMany({ where: { ...scope(a), ...(b.assignment_ids ? { id: { in: b.assignment_ids } } : { status: 'active' }) }, orderBy: { id: 'asc' }, take: 5001 });
        if (b.assignment_ids && rows.length !== b.assignment_ids.length)
            throw notFound('One or more assignments were not found');
        if (rows.length > 5000)
            throw badRequest('Select at most 5000 assignments per run');
        const run = await tx.billingRun.create({ data: { ...scope(a), periodStart: atDate(b.period_start), assignmentIds: rows.map(r => r.id), results: [], status: rows.length ? 'queued' : 'completed', requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } });
        await audit(tx, a, 'invoice_run.queued', 'billing_run', run.id, { count: rows.length, period_start: b.period_start });
        return run;
    });
    return res.status(202).json({ ok: true, data: run });
}));
router.get('/invoice-runs/:id', asyncHandler(async (req, res) => { const a = requireProjectContext(req); const run = await prisma.billingRun.findFirst({ where: { id: req.params.id, ...scope(a) } }); if (!run)
    throw notFound('Invoice run not found'); return ok(res, run); }));
router.get('/invoices/:id', asyncHandler(async (req, res) => { const a = requireProjectContext(req); const row = await prisma.billingInvoice.findFirst({ where: { id: req.params.id, ...scope(a) }, include: { allocations: true, adjustments: true } }); if (!row)
    throw notFound('Invoice not found'); return ok(res, mapInvoice(row)); }));
router.get('/payments', validateQuery(listSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), q = listSchema.parse(req.query); return ok(res, await prisma.billingPayment.findMany({ where: { ...scope(a), customerId: q.customer_id }, include: { allocations: true }, orderBy: { paymentDate: 'desc' }, take: q.limit, skip: q.offset })); }));
router.post('/payments', requireRoles('accountant', 'cashier'), validateBody(paymentSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req); return created(res, await collect(a, paymentSchema.parse(req.body))); }));
router.get('/payments/:id/receipt.pdf', asyncHandler(async (req, res) => {
    const a = requireProjectContext(req);
    const p = await prisma.billingPayment.findFirst({ where: { id: req.params.id, ...scope(a) }, include: { customer: true, allocations: { include: { invoice: true } } } });
    if (!p)
        throw notFound('Payment not found');
    const project = await prisma.project.findFirstOrThrow({ where: { id: a.projectId, tenantId: a.tenantId }, include: { tenant: true } });
    const buffer = await buildBillingPdf('Payment Receipt', project.name, project.tenant.currency, p.customer.name, [`Receipt: ${p.id}`, `Date: ${day(p.paymentDate)}`, `Method: ${p.method}`, `Reference: ${p.reference ?? '-'}`, `Amount received: ${p.amount}`, ...p.allocations.map(v => `${v.invoice.number}: ${v.amount}${v.releasedAt ? ' (released after cancellation)' : ''}`), `Unallocated credit: ${p.remainingAmount}`, `Refunded: ${p.refundedAmount}`]);
    res.type('pdf').setHeader('Content-Disposition', 'inline; filename="billing-receipt.pdf"');
    return res.send(buffer);
}));
router.get('/adjustments', validateQuery(z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }).strict()), asyncHandler(async (req, res) => { const a = requireProjectContext(req); return ok(res, await prisma.billingAdjustment.findMany({ where: { ...scope(a), status: req.query.status as string | undefined }, orderBy: { createdAt: 'desc' } })); }));
router.post('/adjustments', write, validateBody(adjustmentSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req); return created(res, await requestAdjustment(a, adjustmentSchema.parse(req.body))); }));
const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']) }).strict();
router.post('/adjustments/:id/decision', requireRoles('approver'), validateBody(decisionSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req); return ok(res, await decideAdjustment(a, req.params.id, decisionSchema.parse(req.body).decision)); }));
const asOfSchema = z.object({ as_of: pastDateSchema.default(today) }).strict();
router.post('/late-fees/apply', write, validateBody(asOfSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req); return ok(res, await applyLateFees(a, asOfSchema.parse(req.body).as_of)); }));
router.post('/reminders', write, validateBody(asOfSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req); return ok(res, await queueReminders(a, asOfSchema.parse(req.body).as_of)); }));
router.get('/messages', validateQuery(listSchema.omit({ customer_id: true })), asyncHandler(async (req, res) => { const a = requireProjectContext(req), q = listSchema.omit({ customer_id: true }).parse(req.query); return ok(res, await prisma.billingMessage.findMany({ where: scope(a), orderBy: { createdAt: 'desc' }, take: q.limit, skip: q.offset })); }));
const overviewSchema = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).refine(v => dateSchema.safeParse(`${v}-01`).success).default(() => today().slice(0, 7)) }).strict();
router.get('/overview', validateQuery(overviewSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), q = overviewSchema.parse(req.query); const end = atDate(`${q.month}-01`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); return ok(res, await report(a, `${q.month}-01`, day(end))); }));
router.get('/reports', validateQuery(rangeSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), q = rangeSchema.parse(req.query); const from = q.from ?? `${(q.to ?? today()).slice(0, 7)}-01`, to = q.to ?? today(); if (from > to)
    throw badRequest('Date range is reversed'); return ok(res, await report(a, from, to)); }));
export { router as billingRouter };
