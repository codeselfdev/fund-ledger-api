import { taxSelectionSchema } from '../business-setup/validation.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BillingInvoice } from '@prisma/client';
import { badRequest } from '../../core/http/api-error.js';
import { dateSchema, pastDateSchema, lineSchema, calculate } from '../accounting/workflow.js';
export { dateSchema, pastDateSchema, calculate };
export const MAX_MONEY = 2147483647;
export const money = z.number().int().nonnegative().max(MAX_MONEY);
export const id = z.string().min(1).max(100);
export const requestKey = z.string().uuid();
export const categorySchema = z.enum(['apartment_community', 'isp_subscription', 'rental_property', 'general_business']);
export const periodSchema = dateSchema.refine(v => v.endsWith('-01'), 'Billing period must be the first day of a month');
export const settingsSchema = z.object({ category: categorySchema.default('general_business'), automatic_advance: z.boolean().default(true) }).strict();
export const settings = (raw: unknown) => { const p = settingsSchema.safeParse(raw); return p.success ? p.data : settingsSchema.parse({}); };
export const planSchema = z.object({
    name: z.string().trim().min(2).max(120), category: categorySchema,
    mode: z.enum(['fixed', 'usage', 'one_time', 'installment']), amount: money.refine(v => v > 0),
    interval_months: z.number().int().min(1).max(12).default(1), installment_count: z.number().int().min(1).max(600).optional(),
    due_days: z.number().int().min(0).max(365).default(10), grace_days: z.number().int().min(0).max(365).default(0),
    late_fee_type: z.enum(['none', 'fixed', 'percentage']).default('none'), late_fee_value: money.default(0),
    escalation_bps: z.number().int().min(0).max(10000).default(0), escalation_months: z.number().int().min(1).max(120).default(12),
    is_active: z.boolean().default(true)
}).strict().superRefine((p, ctx) => {
    if ((p.mode === 'installment') !== (p.installment_count !== undefined))
        ctx.addIssue({ code: 'custom', message: 'Only installment plans require installment_count' });
    if (p.late_fee_type === 'percentage' && p.late_fee_value > 10000)
        ctx.addIssue({ code: 'custom', message: 'Percentage fee uses basis points, up to 10000 (100%)' });
    if (p.late_fee_type === 'none' && p.late_fee_value !== 0)
        ctx.addIssue({ code: 'custom', message: 'Disabled late fees must have value 0' });
    if (['usage', 'one_time', 'installment'].includes(p.mode) && p.escalation_bps > 0)
        ctx.addIssue({ code: 'custom', message: 'Escalation applies only to fixed recurring plans' });
});
export const unitSchema = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['flat', 'shop', 'connection', 'property', 'service']), note: z.string().max(1000).optional(), is_active: z.boolean().default(true) }).strict();
export const assignmentSchema = z.object({ customer_id: id, plan_id: id, unit_id: id.optional(), label: z.string().trim().min(1).max(150), start_date: dateSchema, end_date: dateSchema.optional() }).strict().refine(p => !p.end_date || p.end_date >= p.start_date, 'End date must follow start date');
export const invoiceSchema = z.object({ tax_selection: taxSelectionSchema.optional(), customer_id: id, invoice_date: dateSchema, due_date: dateSchema, lines: z.array(lineSchema.omit({ item_id: true })).min(1).max(100), discount: money.default(0), tax: money.default(0), note: z.string().max(1000).optional(), request_key: requestKey }).strict().refine(p => p.due_date >= p.invoice_date, 'Due date must follow invoice date');
export const allocationSchema = z.object({ invoice_id: id, amount: money.refine(v => v > 0) }).strict();
export const paymentSchema = z.object({ customer_id: id, account_id: id, amount: money.refine(v => v > 0), method: z.enum(['cash', 'bank', 'bkash', 'nagad', 'card', 'cheque']), payment_date: pastDateSchema, reference: z.string().max(200).optional(), allocations: z.array(allocationSchema).max(5000).optional(), request_key: requestKey }).strict();
export const adjustmentSchema = z.object({ customer_id: id, invoice_id: id.optional(), payment_id: id.optional(), kind: z.enum(['credit_note', 'debit_note', 'waiver', 'write_off', 'cancel', 'refund']), amount: money.refine(v => v > 0).optional(), reason: z.string().trim().min(3).max(1000), request_key: requestKey }).strict().superRefine((v, ctx) => {
    if (v.kind === 'refund' ? !v.payment_id || !!v.invoice_id : !v.invoice_id || !!v.payment_id)
        ctx.addIssue({ code: 'custom', message: 'Refund requires payment_id; other adjustments require invoice_id' });
    if (v.kind !== 'cancel' && !v.amount || v.kind === 'cancel' && v.amount !== undefined)
        ctx.addIssue({ code: 'custom', message: 'Cancellation amount is server calculated; other adjustments require amount' });
});
export const atDate = (v: string) => new Date(`${v}T00:00:00Z`);
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
export const day = (v: Date) => v.toISOString().slice(0, 10);
export const addDays = (v: string, n: number) => day(new Date(atDate(v).getTime() + n * 86400000));
export function checkedMoney(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_MONEY)
        throw badRequest('Amount exceeds the supported range');
    return n;
}
export const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const json = (v: unknown) => JSON.parse(JSON.stringify(v));
export const netTotal = (i: BillingInvoice) => i.total + i.debitAmount + i.lateFeeAmount - i.creditAmount;
export const outstanding = (i: BillingInvoice) => i.status === 'cancelled' ? 0 : netTotal(i) - i.paidAmount;
export function mapInvoice(i: BillingInvoice, asOf = today()) {
    const remaining = outstanding(i);
    return { ...i, net_total: netTotal(i), outstanding: remaining, payment_status: i.status === 'cancelled' ? 'cancelled' : remaining === 0 ? 'paid' : day(i.dueDate) < asOf ? 'overdue' : i.paidAmount > 0 ? 'partial' : 'unpaid' };
}
export function cycleIndex(start: Date, period: string, intervalMonths: number) {
    const date = atDate(period);
    const months = (date.getUTCFullYear() - start.getUTCFullYear()) * 12 + date.getUTCMonth() - start.getUTCMonth();
    return months < 0 || months % intervalMonths !== 0 ? null : months / intervalMonths;
}
export function cycleAmount(plan: {
    amount: number;
    mode: string;
    installmentCount: number | null;
    escalationBps: number;
    escalationMonths: number;
    intervalMonths: number;
}, index: number) {
    if (plan.mode === 'installment') {
        const count = plan.installmentCount!;
        // amount is the complete contract value; remainder goes to the last installment.
        return checkedMoney(index === count - 1 ? plan.amount - Math.floor(plan.amount / count) * (count - 1) : Math.floor(plan.amount / count));
    }
    const increases = Math.floor(index * plan.intervalMonths / plan.escalationMonths);
    return checkedMoney(Math.round(plan.amount * (1 + plan.escalationBps / 10000) ** increases));
}
export function lateFee(i: BillingInvoice, asOf: string) {
    const policy = i.policy as {
        grace_days?: number;
        late_fee_type?: string;
        late_fee_value?: number;
    };
    if (i.status !== 'issued' || i.lateFeeAppliedAt || outstanding(i) <= 0 || asOf <= addDays(day(i.dueDate), policy.grace_days ?? 0))
        return 0;
    const value = policy.late_fee_value ?? 0;
    return checkedMoney(policy.late_fee_type === 'fixed' ? value : policy.late_fee_type === 'percentage' ? Math.round(outstanding(i) * value / 10000) : 0);
}
export function aging(i: BillingInvoice, asOf: string) {
    const days = Math.floor((atDate(asOf).getTime() - i.dueDate.getTime()) / 86400000);
    return days <= 0 ? 'current' : days <= 30 ? '1_30' : days <= 60 ? '31_60' : days <= 90 ? '61_90' : 'over_90';
}
