import { taxSelectionSchema } from '../business-setup/validation.js';
import { z } from 'zod';
import { badRequest, conflict } from '../../core/http/api-error.js';
export const workflowSchema = z.object({ quotations: z.boolean(), orders: z.boolean(), allow_skip: z.boolean() }).strict();
export type Workflow = z.infer<typeof workflowSchema>;
export const defaultWorkflow: Workflow = { quotations: true, orders: true, allow_skip: true };
export const workflow = (raw: unknown): Workflow => { const p = workflowSchema.safeParse(raw); return p.success ? p.data : defaultWorkflow; };
export const kindSchema = z.enum(['quotation', 'order', 'sale']);
export type Kind = z.infer<typeof kindSchema>;
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const d = new Date(`${value}T00:00:00Z`); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value; }, 'Choose a valid date');
export const pastDateSchema = dateSchema.refine(value => value <= new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }), 'Date cannot be in the future');
const money = z.number().int().min(0).max(2147483647);
export const lineSchema = z.object({ description: z.string().trim().min(1).max(200), quantity: z.number().positive().max(1000000).refine(n => Math.abs(n * 1000 - Math.round(n * 1000)) < 0.00001, 'Use up to 3 decimal places'), unit_price: money, item_id: z.string().min(1).optional() }).strict();
export const documentSchema = z.object({ location_id: z.string().min(1).nullable().optional(), tax_selection: taxSelectionSchema.optional(), kind: kindSchema, customer_id: z.string().min(1), document_date: dateSchema, due_date: dateSchema.optional(), lines: z.array(lineSchema).min(1).max(100), discount: money.default(0), tax: money.default(0), note: z.string().max(1000).optional(), request_key: z.string().uuid() }).strict();
export function calculate(lines: z.infer<typeof lineSchema>[], discount: number, tax: number) {
    const normalized = lines.map(line => ({ ...line, line_total: Math.round(line.quantity * line.unit_price) }));
    const subtotal = normalized.reduce((n, line) => n + line.line_total, 0);
    if (discount > subtotal)
        throw badRequest('Discount cannot exceed the subtotal');
    const total = subtotal - discount + tax;
    if (!Number.isSafeInteger(total) || total <= 0 || subtotal > 2147483647 || total > 2147483647)
        throw badRequest('Total must be positive and within the supported amount');
    return { lines: normalized, subtotal, total };
}
export function allowDirect(kind: Kind, settings: Workflow) {
    if (kind === 'quotation' && !settings.quotations || kind === 'order' && !settings.orders)
        throw badRequest('This step is disabled in the project workflow');
    if (!settings.allow_skip && (kind === 'order' && settings.quotations || kind === 'sale' && (settings.quotations || settings.orders)))
        throw conflict('Follow the configured workflow: convert the preceding document instead');
}
export function conversion(kind: Kind, status: string, target: Kind, settings: Workflow) {
    if (kind === 'quotation' && status === 'accepted' && (target === 'order' && settings.orders || target === 'sale' && (!settings.orders || settings.allow_skip)))
        return;
    if (kind === 'order' && ['confirmed', 'fulfilling'].includes(status) && target === 'sale')
        return;
    throw conflict('Accept the quotation or confirm the order before converting; follow the enabled workflow steps');
}
export function nextStatus(kind: Kind, current: string, action: string, paid = 0): string {
    const transitions: Record<Kind, Record<string, Record<string, string>>> = {
        quotation: { draft: { send: 'sent', cancel: 'cancelled' }, sent: { accept: 'accepted', reject: 'rejected', expire: 'expired', cancel: 'cancelled' }, accepted: { cancel: 'cancelled' } },
        order: { draft: { confirm: 'confirmed', cancel: 'cancelled' }, confirmed: { fulfill: 'fulfilling', cancel: 'cancelled' }, fulfilling: { cancel: 'cancelled' } },
        sale: { draft: { issue: 'issued', cancel: 'cancelled' }, issued: { cancel: 'cancelled' } }
    };
    const next = transitions[kind][current]?.[action];
    if (!next)
        throw conflict('This action is not available in the current status');
    if (kind === 'sale' && action === 'cancel' && paid > 0)
        throw conflict('A paid or partially paid invoice cannot be cancelled');
    return next;
}
export function paymentStatus(doc: {
    kind: string;
    status: string;
    total: number;
    paidAmount: number;
    dueDate: Date | null;
}, today = new Date()) {
    if (doc.kind !== 'sale' || doc.status !== 'issued')
        return null;
    if (doc.paidAmount >= doc.total)
        return 'paid';
    if (doc.dueDate && doc.dueDate.toISOString().slice(0, 10) < today.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }))
        return 'overdue';
    return doc.paidAmount > 0 ? 'partial' : 'unpaid';
}
