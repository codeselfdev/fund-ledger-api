import { z } from 'zod';
import { money, id, requestKey, dateSchema, pastDateSchema } from '../billing/billing.policy.js';
export const CATEGORIES = {
    computers: { name: 'Computers', code: 'CMP', life: 60, residual: .08, color: '#2F6FB0' },
    vehicles: { name: 'Vehicles', code: 'VEH', life: 96, residual: .2, color: '#C27A12' },
    furniture: { name: 'Furniture', code: 'FUR', life: 84, residual: .08, color: '#7A5BB5' },
    equipment: { name: 'Equipment', code: 'EQP', life: 120, residual: .1, color: '#0F7A6C' },
} as const;
const text = z.string().trim().max(200);
export const purchaseSchema = z.object({
    name: text.min(2), category: z.enum(['computers', 'vehicles', 'furniture', 'equipment']), cost: money.refine(n => n > 0),
    residual: money, life_months: z.number().int().min(1).max(600), purchase_date: pastDateSchema, in_use_date: dateSchema,
    supplier: text.default(''), invoice: text.default(''), invoice_upload_id: id.optional(), account_id: id,
    warranty_until: dateSchema.optional(), quantity: z.number().int().min(1).max(100).default(1),
    units: z.array(z.object({ location: text.min(1), assigned_to: text.default(''), serial: text.default('') }).strict()).min(1).max(100),
    request_key: requestKey,
}).strict().superRefine((v, ctx) => {
    if (v.residual >= v.cost)
        ctx.addIssue({ code: 'custom', message: 'Residual must be below purchase price' });
    if (v.in_use_date < v.purchase_date)
        ctx.addIssue({ code: 'custom', message: 'In-use date must follow purchase date' });
    if (v.warranty_until && v.warranty_until < v.purchase_date)
        ctx.addIssue({ code: 'custom', message: 'Warranty must follow purchase date' });
    if (v.units.length !== v.quantity)
        ctx.addIssue({ code: 'custom', message: 'Allocate a location and serial field for every unit' });
    if (v.cost * v.quantity > 2147483647)
        ctx.addIssue({ code: 'custom', message: 'Invoice total is too large' });
    const serials = v.units.map(u => u.serial).filter(Boolean);
    if (new Set(serials).size !== serials.length)
        ctx.addIssue({ code: 'custom', message: 'Serial numbers must be unique' });
});
export const maintenanceSchema = z.object({ service_date: pastDateSchema, description: z.string().trim().min(3).max(1000), provider: text.default(''), cost: money, account_id: id.optional(), next_service_date: dateSchema.optional(), request_key: requestKey }).strict().superRefine((v, c) => {
    if (v.cost > 0 && !v.account_id)
        c.addIssue({ code: 'custom', message: 'Select the account used to pay for service' });
    if (v.next_service_date && v.next_service_date <= v.service_date)
        c.addIssue({ code: 'custom', message: 'Next service must follow this service' });
});
export const transferSchema = z.object({ kind: z.enum(['location', 'person', 'project']), target: text.min(1), condition: z.enum(['Good', 'Fair', 'Needs repair']).default('Good'), note: z.string().trim().max(1000).default(''), request_key: requestKey }).strict();
export const disposalSchema = z.object({ kind: z.enum(['sell', 'scrap', 'lost']), date: pastDateSchema, proceeds: money.default(0), buyer: text.default(''), reason: z.string().trim().max(1000).default(''), account_id: id.optional(), request_key: requestKey }).strict().superRefine((v, c) => {
    if (v.kind === 'sell' && (!v.buyer || !v.account_id || v.proceeds <= 0))
        c.addIssue({ code: 'custom', message: 'A sale needs a buyer, receiving account and price' });
    if (v.kind !== 'sell' && (!v.reason || v.proceeds || v.account_id))
        c.addIssue({ code: 'custom', message: 'Write-offs need a reason and no sale proceeds or account' });
});
export const metadataSchema = z.object({ serial: text, warranty_until: dateSchema.nullable(), next_service_date: dateSchema.nullable() }).strict();
export const monthIndex = (v: string | Date) => { const s = typeof v === 'string' ? v : v.toISOString(); return Number(s.slice(0, 4)) * 12 + Number(s.slice(5, 7)) - 1; };
export const monthLabel = (n: number) => `${Math.floor(n / 12)}-${String(n % 12 + 1).padStart(2, '0')}`;
export const completedMonth = (date: string) => monthLabel(monthIndex(date) - 1);
export interface Depreciable {
    cost: number;
    residual: number;
    lifeMonths: number;
    inUseDate: Date | string;
    disposedAt?: Date | string | null;
}
/** Whole currency units match the cash ledger; cumulative rounding preserves the exact depreciable total. */
export function valuation(a: Depreciable, through: string) {
    const stop = a.disposedAt ? Math.min(monthIndex(through), monthIndex(a.disposedAt) - 1) : monthIndex(through);
    const elapsed = Math.max(0, Math.min(a.lifeMonths, stop - monthIndex(a.inUseDate) + 1));
    const accumulated = Math.round((a.cost - a.residual) * elapsed / a.lifeMonths);
    return { monthly: (a.cost - a.residual) / a.lifeMonths, accumulated, book_value: a.cost - accumulated, elapsed, remaining: a.lifeMonths - elapsed };
}
export function monthlyCharge(a: Depreciable, month: string) {
    return valuation(a, month).accumulated - valuation(a, monthLabel(monthIndex(month) - 1)).accumulated;
}
