import { documentTax, postTax, lockSetup } from '../business-setup/service.js';
import { randomUUID } from 'node:crypto';
import { Prisma, type BillingInvoice, type BillingPayment } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, notFound, ApiError } from '../../core/http/api-error.js';
import { financialTransaction } from '../accounting/transaction.js';
import { atDate, checkedMoney, day, hash, json, netTotal, outstanding, settings, cycleIndex, cycleAmount, addDays, lateFee, type invoiceSchema, type paymentSchema, type adjustmentSchema } from './billing.policy.js';
import type { z } from 'zod';
export type BillingScope = {
    roles?: string[];
    tenantId: string;
    projectId: string;
    userId: string;
};
export const scope = (a: {
    tenantId: string;
    projectId: string;
}) => ({ tenantId: a.tenantId, projectId: a.projectId });
type Tx = Prisma.TransactionClient;
export async function audit(tx: Tx, a: BillingScope, action: string, entityType: string, entityId: string, detail: unknown) {
    await tx.activity.create({ data: { ...scope(a), actorUserId: a.userId, action: `billing.${action}`, entityType, entityId, after: json(detail) } });
}
export function sameRequest(row: {
    requestHash: string;
}, payload: unknown) {
    if (row.requestHash !== hash(payload))
        throw conflict('Request key already used for a different payload');
}
export async function customer(tx: Tx, a: BillingScope, customerId: string, active = true) {
    const c = await tx.customer.findFirst({ where: { id: customerId, ...scope(a), ...(active ? { isActive: true } : {}) } });
    if (!c)
        throw notFound('Customer not found');
    return c;
}
export async function invoice(tx: Tx, a: BillingScope, invoiceId: string, customerId?: string) {
    const i = await tx.billingInvoice.findFirst({ where: { id: invoiceId, ...scope(a), customerId } });
    if (!i)
        throw notFound('Invoice not found');
    return i;
}
async function queueMessage(tx: Tx, a: BillingScope, recipient: string | null, dedupeKey: string, subject: string, body: string) {
    if (!recipient)
        return;
    await tx.billingMessage.upsert({ where: { projectId_dedupeKey: { projectId: a.projectId, dedupeKey } }, create: { ...scope(a), recipient, dedupeKey, subject, body }, update: {} });
}
export async function allocate(tx: Tx, a: BillingScope, payment: BillingPayment, i: BillingInvoice, amount: number) {
    if (i.status !== 'issued' || i.customerId !== payment.customerId || amount > outstanding(i) || amount > payment.remainingAmount)
        throw conflict('Allocation exceeds available payment or invoice balance');
    const allocation = await tx.billingAllocation.create({ data: { ...scope(a), invoiceId: i.id, paymentId: payment.id, amount } });
    await tx.billingPayment.update({ where: { id: payment.id }, data: { remainingAmount: { decrement: amount } } });
    await tx.billingInvoice.update({ where: { id: i.id }, data: { paidAmount: { increment: amount } } });
    await audit(tx, a, 'payment.allocated', 'billing_invoice', i.id, { payment_id: payment.id, allocation_id: allocation.id, amount });
    payment.remainingAmount -= amount;
    i.paidAmount += amount;
}
export async function applyAdvance(tx: Tx, a: BillingScope, customerId: string) {
    const payments = await tx.billingPayment.findMany({ where: { ...scope(a), customerId, remainingAmount: { gt: 0 } }, orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }] });
    if (payments.length === 0)
        return { applied: 0, advance: 0 };
    const invoices = await tx.billingInvoice.findMany({ where: { ...scope(a), customerId, status: 'issued' }, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }] });
    let applied = 0;
    for (const p of payments)
        for (const i of invoices) {
            const amount = Math.min(p.remainingAmount, outstanding(i));
            if (amount > 0) {
                await allocate(tx, a, p, i, amount);
                applied += amount;
            }
        }
    return { applied, advance: payments.reduce((n, p) => n + p.remainingAmount, 0) };
}
async function insertInvoice(tx: Tx, a: BillingScope, b: z.infer<typeof invoiceSchema>, totals: {
    lines: unknown;
    subtotal: number;
    total: number;
}, extra?: {
    assignmentId: string;
    periodStart: Date;
    policy: unknown;
}) {
    await lockSetup(tx, a);
    const taxSnapshot = await documentTax(tx, { ...a, roles: a.roles ?? [] }, 'sale', b.lines.map(l => Math.round(l.quantity * l.unit_price)), b.discount, b.tax_selection, b.tax);
    if (taxSnapshot) totals = { ...totals, subtotal: taxSnapshot.subtotal + b.discount, total: taxSnapshot.payable };
    const c = await customer(tx, a, b.customer_id);
    const project = await tx.project.findFirstOrThrow({ where: { id: a.projectId, tenantId: a.tenantId } });
    const i = await tx.billingInvoice.create({ data: { ...scope(a), customerId: c.id, assignmentId: extra?.assignmentId, periodStart: extra?.periodStart, number: `BILL-${randomUUID().toUpperCase()}`, customerSnapshot: json({ name: c.name, mobile: c.mobile, email: c.email, address: c.address, attributes: c.attributes }), lines: json(totals.lines), subtotal: totals.subtotal, discount: b.discount, tax: taxSnapshot?.tax ?? b.tax, taxSnapshot: taxSnapshot ? json(taxSnapshot) : undefined, total: totals.total, invoiceDate: atDate(b.invoice_date), dueDate: atDate(b.due_date), note: b.note, policy: json(extra?.policy ?? { late_fee_type: 'none', late_fee_value: 0, grace_days: 0 }), requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } });
    await postTax(tx, a, 'billing_invoice', i.id, taxSnapshot, 'output');
    await audit(tx, a, 'invoice.issued', 'billing_invoice', i.id, { number: i.number, total: i.total, customer_id: c.id });
    if (settings(project.billingSettings).automatic_advance)
        await applyAdvance(tx, a, c.id);
    await queueMessage(tx, a, c.email, `invoice:${i.id}`, `Invoice ${i.number}`, `${project.name}\nHello ${c.name},\nYour invoice is ${i.total}. Due date: ${b.due_date}. Please contact the billing office for a statement.`);
    return invoice(tx, a, i.id);
}
export async function issueInvoice(a: BillingScope, b: z.infer<typeof invoiceSchema>, totals: {
    lines: unknown;
    subtotal: number;
    total: number;
}) {
    return financialTransaction(async (tx) => {
        const existing = await tx.billingInvoice.findFirst({ where: { ...scope(a), requestKey: b.request_key } });
        if (existing) {
            sameRequest(existing, b);
            return existing;
        }
        return insertInvoice(tx, a, b, totals);
    });
}
export async function generateAssignment(tx: Tx, a: BillingScope, assignmentId: string, period: string) {
    const existing = await tx.billingInvoice.findFirst({ where: { ...scope(a), assignmentId, periodStart: atDate(period) } });
    if (existing)
        return { invoice_id: existing.id, existing: true };
    const row = await tx.billingAssignment.findFirst({ where: { id: assignmentId, ...scope(a) }, include: { plan: true, unit: true } });
    if (!row)
        throw notFound('Assignment not found');
    if (row.status !== 'active' || !row.plan.isActive || row.unit && !row.unit.isActive)
        throw conflict('Assignment, plan or unit is inactive');
    const index = cycleIndex(row.startDate, period, row.plan.intervalMonths);
    const nextMonth = atDate(period);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    if (index === null || row.startDate >= nextMonth || row.endDate && day(row.endDate) < period || row.plan.mode === 'one_time' && index > 0 || row.plan.mode === 'installment' && index >= row.plan.installmentCount!)
        throw conflict('Assignment is outside its billing cycle');
    let quantity = 1;
    let rate = cycleAmount(row.plan, index);
    let description = `${row.plan.name} - ${row.label}`;
    if (row.plan.mode === 'usage') {
        const reading = await tx.billingMeterReading.findFirst({ where: { ...scope(a), assignmentId, periodStart: atDate(period) } });
        if (!reading)
            throw conflict('Record meter reading before generating a usage invoice');
        quantity = reading.current - reading.previous;
        description += ` (${reading.previous} to ${reading.current})`;
        rate = row.plan.amount;
    }
    const amount = checkedMoney(rate * quantity);
    const invoiceDate = day(row.startDate) > period ? day(row.startDate) : period;
    const b = { customer_id: row.customerId, invoice_date: invoiceDate, due_date: addDays(invoiceDate, row.plan.dueDays), lines: [{ description, quantity, unit_price: rate }], discount: 0, tax: 0, request_key: randomUUID() };
    const i = await insertInvoice(tx, a, b, { lines: [{ ...b.lines[0], line_total: amount }], subtotal: amount, total: amount }, { assignmentId, periodStart: atDate(period), policy: { grace_days: row.plan.graceDays, late_fee_type: row.plan.lateFeeType, late_fee_value: row.plan.lateFeeValue, plan_id: row.plan.id, category: row.plan.category, installment_number: row.plan.mode === 'installment' ? index + 1 : null } });
    return { invoice_id: i.id, existing: false };
}
export async function collect(a: BillingScope, b: z.infer<typeof paymentSchema>) {
    return financialTransaction(async (tx) => {
        const existing = await tx.billingPayment.findFirst({ where: { ...scope(a), requestKey: b.request_key }, include: { allocations: true } });
        if (existing) {
            sameRequest(existing, b);
            return existing;
        }
        const c = await customer(tx, a, b.customer_id);
        const account = await tx.account.findFirst({ where: { id: b.account_id, ...scope(a) } });
        if (!account)
            throw notFound('Account not found');
        checkedMoney(account.balance + b.amount);
        if (b.allocations) {
            if (new Set(b.allocations.map(i => i.invoice_id)).size !== b.allocations.length)
                throw badRequest('Duplicate invoice allocations');
            if (b.allocations.reduce((n, r) => n + r.amount, 0) > b.amount)
                throw badRequest('Allocations exceed payment amount');
        }
        const p = await tx.billingPayment.create({ data: { ...scope(a), customerId: c.id, accountId: account.id, amount: b.amount, remainingAmount: b.amount, method: b.method, paymentDate: atDate(b.payment_date), reference: b.reference, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } });
        const updated = await tx.account.update({ where: { id: account.id }, data: { balance: { increment: b.amount } } });
        await tx.accountTransaction.create({ data: { ...scope(a), accountId: account.id, direction: 'money_in', amount: b.amount, balanceAfter: updated.balance, referenceType: 'billing_payment', referenceId: p.id, description: `Billing collection: ${c.name}`, occurredOn: p.paymentDate, createdById: a.userId } });
        if (b.allocations) {
            for (const item of b.allocations)
                await allocate(tx, a, p, await invoice(tx, a, item.invoice_id, c.id), item.amount);
        }
        else
            await applyAdvance(tx, a, c.id);
        await audit(tx, a, 'payment.collected', 'billing_payment', p.id, { amount: p.amount, method: p.method, account_id: p.accountId });
        await queueMessage(tx, a, c.email, `receipt:${p.id}`, `Payment received: ${p.id}`, `Hello ${c.name},\nWe received ${p.amount} by ${p.method} on ${b.payment_date}. Receipt: ${p.id}. Reference: ${p.reference ?? '-'}.`);
        return tx.billingPayment.findFirstOrThrow({ where: { id: p.id, ...scope(a) }, include: { allocations: true } });
    });
}
export async function requestAdjustment(a: BillingScope, b: z.infer<typeof adjustmentSchema>) {
    return financialTransaction(async (tx) => {
        const existing = await tx.billingAdjustment.findFirst({ where: { ...scope(a), requestKey: b.request_key } });
        if (existing) {
            sameRequest(existing, b);
            return existing;
        }
        await customer(tx, a, b.customer_id, false);
        const i = b.invoice_id ? await invoice(tx, a, b.invoice_id, b.customer_id) : null;
        if (i && i.status !== 'issued')
            throw conflict('Invoice is cancelled');
        const p = b.payment_id ? await tx.billingPayment.findFirst({ where: { id: b.payment_id, ...scope(a), customerId: b.customer_id } }) : null;
        if (b.payment_id && !p)
            throw notFound('Payment not found');
        const row = await tx.billingAdjustment.create({ data: { ...scope(a), customerId: b.customer_id, invoiceId: b.invoice_id, paymentId: b.payment_id, kind: b.kind, amount: b.kind === 'cancel' ? netTotal(i!) : b.amount!, reason: b.reason, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } });
        await audit(tx, a, 'adjustment.requested', 'billing_adjustment', row.id, row);
        return row;
    });
}
export async function decideAdjustment(a: BillingScope, adjustmentId: string, decision: 'approve' | 'reject') {
    return financialTransaction(async (tx) => {
        const row = await tx.billingAdjustment.findFirst({ where: { id: adjustmentId, ...scope(a) } });
        if (!row)
            throw notFound('Adjustment not found');
        const status = decision === 'approve' ? 'approved' : 'rejected';
        if (row.status !== 'pending') {
            if (row.status !== status)
                throw conflict('Adjustment has already been decided');
            return row;
        }
        // A second person must review requests, including management-created requests.
        if (row.createdById === a.userId)
            throw conflict('A different administrator or approver must review this request');
        if (decision === 'approve') {
            if (row.kind === 'refund') {
                const p = await tx.billingPayment.findFirst({ where: { id: row.paymentId!, ...scope(a), customerId: row.customerId } });
                if (!p || p.remainingAmount < row.amount)
                    throw conflict('Refund exceeds unallocated customer credit; cancel the invoice first if needed');
                const account = await tx.account.findFirst({ where: { id: p.accountId, ...scope(a) } });
                if (!account || account.balance < row.amount)
                    throw conflict('Insufficient account balance for refund');
                const updated = await tx.account.update({ where: { id: account.id }, data: { balance: { decrement: row.amount } } });
                await tx.billingPayment.update({ where: { id: p.id }, data: { remainingAmount: { decrement: row.amount }, refundedAmount: { increment: row.amount } } });
                await tx.accountTransaction.create({ data: { ...scope(a), accountId: account.id, direction: 'money_out', amount: row.amount, balanceAfter: updated.balance, referenceType: 'billing_refund', referenceId: row.id, description: row.reason, occurredOn: new Date(), createdById: a.userId } });
            }
            else {
                const i = await invoice(tx, a, row.invoiceId!, row.customerId);
                if (i.status !== 'issued')
                    throw conflict('Invoice is cancelled');
                if (row.kind === 'cancel') {
                    if (row.amount !== netTotal(i))
                        throw conflict('Invoice changed since cancellation was requested; submit a new request');
                    const allocations = await tx.billingAllocation.findMany({ where: { ...scope(a), invoiceId: i.id, releasedAt: null } });
                    for (const item of allocations) {
                        await tx.billingPayment.update({ where: { id: item.paymentId }, data: { remainingAmount: { increment: item.amount } } });
                        await tx.billingAllocation.update({ where: { id: item.id }, data: { releasedAt: new Date() } });
                    }
                    await postTax(tx, a, 'billing_invoice', i.id, i.taxSnapshot, 'output', true);
                    await tx.billingInvoice.update({ where: { id: i.id }, data: { status: 'cancelled', paidAmount: 0 } });
                }
                else if (row.kind === 'debit_note') {
                    checkedMoney(netTotal(i) + row.amount);
                    checkedMoney(i.debitAmount + row.amount);
                    await tx.billingInvoice.update({ where: { id: i.id }, data: { debitAmount: { increment: row.amount } } });
                }
                else {
                    if (row.amount > outstanding(i))
                        throw conflict('Credit, waiver or write-off exceeds the outstanding balance');
                    checkedMoney(i.creditAmount + row.amount);
                    await tx.billingInvoice.update({ where: { id: i.id }, data: { creditAmount: { increment: row.amount } } });
                }
            }
        }
        const updated = await tx.billingAdjustment.update({ where: { id: row.id }, data: { status, decidedById: a.userId, decidedAt: new Date() } });
        await audit(tx, a, `adjustment.${status}`, 'billing_adjustment', row.id, updated);
        return updated;
    });
}
export async function applyLateFees(a: BillingScope, asOf: string) {
    const rows = await prisma.billingInvoice.findMany({ where: { ...scope(a), status: 'issued', lateFeeAppliedAt: null, dueDate: { lt: atDate(asOf) } }, select: { id: true } });
    let applied = 0, amount = 0;
    for (const row of rows) {
        const fee = await financialTransaction(async (tx) => {
            const i = await invoice(tx, a, row.id);
            const fee = lateFee(i, asOf);
            if (!fee)
                return 0;
            checkedMoney(netTotal(i) + fee);
            await tx.billingInvoice.update({ where: { id: i.id }, data: { lateFeeAmount: fee, lateFeeAppliedAt: new Date() } });
            await audit(tx, a, 'late_fee.applied', 'billing_invoice', i.id, { amount: fee, as_of: asOf });
            return fee;
        });
        if (fee) {
            applied++;
            amount += fee;
        }
    }
    return { applied, amount };
}
export async function queueReminders(a: BillingScope, asOf: string) {
    const ids = await prisma.billingInvoice.findMany({ where: { ...scope(a), status: 'issued', dueDate: { lte: atDate(asOf) } }, select: { id: true } });
    let eligible = 0;
    for (let offset = 0; offset < ids.length; offset += 100) {
        eligible += await financialTransaction(async (tx) => {
            const rows = await tx.billingInvoice.findMany({ where: { ...scope(a), id: { in: ids.slice(offset, offset + 100).map(i => i.id) }, status: 'issued' }, include: { customer: true } });
            let count = 0;
            for (const i of rows) {
                if (outstanding(i) <= 0 || !i.customer.email)
                    continue;
                const overdue = day(i.dueDate) < asOf;
                await queueMessage(tx, a, i.customer.email, `reminder:${i.id}:${asOf}`, `${overdue ? 'Overdue' : 'Due'} invoice ${i.number}`, `Hello ${i.customer.name},\nInvoice ${i.number} has ${outstanding(i)} outstanding. Due date: ${day(i.dueDate)}. Please contact your billing office if you have already paid.`);
                count++;
            }
            return count;
        });
    }
    await financialTransaction(tx => audit(tx, a, 'reminders.queued', 'project', a.projectId, { as_of: asOf, eligible }));
    return { eligible };
}
export async function processRun(runId: string, limit = 100) {
    for (let step = 0; step < limit; step++) {
        const old = await prisma.billingRun.findFirst({ where: { id: runId, status: { in: ['queued', 'running'] } } });
        if (!old)
            return;
        const project = await prisma.project.findFirst({ where: { id: old.projectId, tenantId: old.tenantId, isActive: true, projectType: 'billing' } });
        if (!project)
            return;
        const a = { ...scope(old), userId: old.createdById };
        try {
            const finished = await financialTransaction(async (tx) => {
                const run = await tx.billingRun.findFirstOrThrow({ where: { id: old.id, ...scope(a) } });
                if (run.status === 'completed')
                    return true;
                const ids = run.assignmentIds as string[];
                if (run.cursor >= ids.length) {
                    await tx.billingRun.update({ where: { id: run.id }, data: { status: 'completed' } });
                    return true;
                }
                const result = await generateAssignment(tx, a, ids[run.cursor], day(run.periodStart));
                await tx.billingRun.update({ where: { id: run.id }, data: { status: run.cursor + 1 === ids.length ? 'completed' : 'running', cursor: { increment: 1 }, results: json([...(run.results as unknown[]), { assignment_id: ids[run.cursor], ...result }]) } });
                return run.cursor + 1 === ids.length;
            });
            if (finished)
                return;
        }
        catch (error) {
            // Validation failures are visible per assignment. Infrastructure failures retry the same item.
            if (!(error instanceof ApiError) || ![400, 404, 409].includes(error.statusCode) || error.message === 'Another update is in progress. Please retry.')
                throw error;
            await financialTransaction(async (tx) => {
                const run = await tx.billingRun.findFirstOrThrow({ where: { id: old.id, ...scope(a) } });
                if (run.cursor !== old.cursor)
                    return;
                const ids = run.assignmentIds as string[];
                await tx.billingRun.update({ where: { id: run.id }, data: { cursor: { increment: 1 }, status: run.cursor + 1 === ids.length ? 'completed' : 'running', results: json([...(run.results as unknown[]), { assignment_id: ids[run.cursor], error: error.message }]) } });
            });
        }
    }
}
