import { scope, customer, type BillingScope } from './billing.service.js';
import { day, aging, mapInvoice, outstanding, today } from './billing.policy.js';
import { financialTransaction } from '../accounting/transaction.js';
export async function report(a: BillingScope, from: string, to: string) {
    return financialTransaction(async (tx) => {
        const [invoices, payments, adjustments, customers] = await Promise.all([
            tx.billingInvoice.findMany({ where: scope(a), orderBy: { createdAt: 'desc' } }),
            tx.billingPayment.findMany({ where: scope(a), orderBy: { paymentDate: 'desc' } }),
            tx.billingAdjustment.findMany({ where: { ...scope(a), status: 'approved' } }),
            tx.customer.count({ where: { ...scope(a), isActive: true } })
        ]);
        const asOf = today();
        const inPeriod = (d: Date) => day(d) >= from && day(d) <= to;
        const active = invoices.filter(i => i.status === 'issued');
        const periodInvoices = active.filter(i => inPeriod(i.invoiceDate));
        const collected = payments.filter(p => inPeriod(p.paymentDate)).reduce((n, p) => n + p.amount, 0);
        const refunds = adjustments.filter(r => r.kind === 'refund' && r.decidedAt && inPeriod(r.decidedAt)).reduce((n, r) => n + r.amount, 0);
        const overdue = active.filter(i => day(i.dueDate) < asOf && outstanding(i) > 0);
        const agingTotals = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, over_90: 0 };
        for (const i of active)
            agingTotals[aging(i, asOf)] += outstanding(i);
        const totalBilled = periodInvoices.reduce((n, i) => n + i.total, 0);
        const netBilled = periodInvoices.reduce((n, i) => n + i.total + i.lateFeeAmount + i.debitAmount - i.creditAmount, 0);
        const paidOnPeriodInvoices = periodInvoices.reduce((n, i) => n + i.paidAmount, 0);
        const advance = payments.reduce((n, p) => n + p.remainingAmount, 0);
        const due = active.reduce((n, i) => n + outstanding(i), 0);
        return { from, to, balances_as_of: asOf, customers, total_billed: totalBilled, net_billed: netBilled, collected, refunds, net_collected: collected - refunds,
            outstanding: due, advance, net_customer_balance: due - advance, overdue: overdue.reduce((n, i) => n + outstanding(i), 0), overdue_accounts: new Set(overdue.map(i => i.customerId)).size,
            carry_forward: active.filter(i => day(i.invoiceDate) < from).reduce((n, i) => n + outstanding(i), 0),
            collection_progress: netBilled === 0 ? 0 : Math.round(paidOnPeriodInvoices / netBilled * 1000) / 10,
            aging: agingTotals, recent: invoices.slice(0, 10).map(i => mapInvoice(i)), collection_activity: payments.slice(0, 10),
            by_method: Object.fromEntries(['cash', 'bank', 'bkash', 'nagad', 'card', 'cheque'].map(method => [method, payments.filter(p => p.method === method && inPeriod(p.paymentDate)).reduce((n, p) => n + p.amount, 0)])) };
    });
}
export async function ledger(a: BillingScope, customerId: string, from?: string, to?: string) {
    return financialTransaction(async (tx) => {
        const c = await customer(tx, a, customerId, false);
        const [invoices, payments, adjustments] = await Promise.all([
            tx.billingInvoice.findMany({ where: { ...scope(a), customerId } }),
            tx.billingPayment.findMany({ where: { ...scope(a), customerId }, include: { allocations: true } }),
            tx.billingAdjustment.findMany({ where: { ...scope(a), customerId, status: 'approved' } })
        ]);
        type Entry = {
            id: string;
            date: string;
            type: string;
            reference: string;
            amount: number;
            recorded_at: string;
        };
        const entries: Entry[] = [];
        for (const i of invoices) {
            entries.push({ id: i.id, date: day(i.invoiceDate), type: 'invoice', reference: i.number, amount: i.total, recorded_at: i.createdAt.toISOString() });
            if (i.lateFeeAppliedAt)
                entries.push({ id: `${i.id}:fee`, date: day(i.lateFeeAppliedAt), type: 'late_fee', reference: i.number, amount: i.lateFeeAmount, recorded_at: i.lateFeeAppliedAt.toISOString() });
        }
        for (const p of payments)
            entries.push({ id: p.id, date: day(p.paymentDate), type: 'payment', reference: p.reference ?? p.id, amount: -p.amount, recorded_at: p.createdAt.toISOString() });
        for (const r of adjustments)
            entries.push({ id: r.id, date: day(r.decidedAt!), type: r.kind, reference: r.reason, amount: ['refund', 'debit_note'].includes(r.kind) ? r.amount : -r.amount, recorded_at: r.decidedAt!.toISOString() });
        entries.sort((x, y) => x.date.localeCompare(y.date) || x.recorded_at.localeCompare(y.recorded_at) || x.id.localeCompare(y.id));
        let balance = 0, opening = 0;
        const rows: (Entry & {
            balance: number;
        })[] = [];
        for (const e of entries) {
            if (to && e.date > to)
                continue;
            balance += e.amount;
            if (from && e.date < from)
                opening += e.amount;
            else
                rows.push({ ...e, balance });
        }
        return { customer: c, from: from ?? null, to: to ?? null, opening_balance: opening, closing_balance: balance, outstanding: invoices.reduce((n, i) => n + outstanding(i), 0), advance: payments.reduce((n, p) => n + p.remainingAmount, 0), balances_as_of: today(), entries: rows, invoices: invoices.map(i => mapInvoice(i)), payments };
    });
}
