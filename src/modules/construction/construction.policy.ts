import { z } from 'zod';
import { money, id, requestKey, dateSchema, pastDateSchema, checkedMoney } from '../billing/billing.policy.js';
import { badRequest } from '../../core/http/api-error.js';
export { money, id, requestKey, dateSchema, pastDateSchema, checkedMoney };
const name = z.string().trim().min(2).max(150);
export const quantity = z.number().positive().max(100000000).refine(n => Math.abs(n * 1000 - Math.round(n * 1000)) < 0.00001, 'Use up to 3 decimal places');
export const settingsSchema = z.object({ building: name, site: z.string().max(500), start_date: dateSchema.optional(), end_date: dateSchema.optional(), financial_target: money.default(0), total_shares: money.refine(v => v > 0).optional(), note: z.string().max(1000).optional() }).strict().refine(v => !v.start_date || !v.end_date || v.end_date >= v.start_date, 'End date must follow start date');
export const headSchema = z.object({ name, phase: name.optional(), phase_id: id.optional(), category: z.enum(['materials', 'labor', 'transport', 'machinery', 'overhead', 'contractor', 'professional', 'other']), budget: money, forecast_remaining: money.default(0) }).strict().refine(v => !!v.phase || !!v.phase_id, 'Choose a construction phase');
export const boqSchema = z.object({ cost_head_id: id, name, unit: z.string().trim().min(1).max(30), quantity, rate: money, is_active: z.boolean().default(true) }).strict();
export const allocationSchema = z.object({ expense_id: id, cost_head_id: id, boq_id: id.optional(), amount: money.refine(n => n > 0), request_key: requestKey }).strict();
export const contractorSchema = z.object({ name, mobile: z.string().max(32).optional(), email: z.string().email().optional(), address: z.string().max(500).optional(), is_active: z.boolean().default(true) }).strict();
export const contractSchema = z.object({ contractor_id: id, cost_head_id: id, title: name, amount: money.refine(n => n > 0), retention_bps: z.number().int().min(0).max(10000).default(500), request_key: requestKey }).strict();
export const runningSchema = z.object({ contract_id: id, cumulative_certified: money.refine(n => n > 0), waste_entry_ids: z.array(id).max(100).optional(), advance_recovery: money.default(0), bill_date: pastDateSchema, note: z.string().max(1000).optional(), request_key: requestKey }).strict();
export const supplierSchema = z.object({ vendor_id: id, cost_head_id: id, boq_id: id.optional(), purchase_id: id.optional(), number: z.string().trim().min(1).max(100), description: name, amount: money.refine(n => n > 0), bill_date: pastDateSchema, request_key: requestKey }).strict();
export const laborSchema = z.object({ cost_head_id: id, worker_name: name, work_date: pastDateSchema, units: quantity, rate: money.refine(n => n > 0), note: z.string().max(1000).optional(), request_key: requestKey }).strict();
export const materialSchema = z.object({ item_id: id, boq_id: id.optional(), kind: z.enum(['consume', 'return', 'waste']), quantity: z.number().int().positive().max(2147483647), entry_date: pastDateSchema, reason: z.string().trim().min(3).max(1000), source_id: id.optional(), charge_contract_id: id.optional(), request_key: requestKey }).strict().refine(v => (v.kind === 'return') === !!v.source_id, 'Returns require source_id from a prior consumption; other movements omit it');
export const paymentSchema = z.object({ kind: z.enum(['advance', 'running_bill', 'retention', 'supplier_bill', 'labor']), contract_id: id.optional(), running_bill_id: id.optional(), supplier_bill_id: id.optional(), labor_entry_id: id.optional(), account_id: id, amount: money.refine(n => n > 0), payment_date: pastDateSchema, reference: z.string().max(200).optional(), request_key: requestKey }).strict().superRefine((v, ctx) => {
    const targets = [v.contract_id, v.running_bill_id, v.supplier_bill_id, v.labor_entry_id].filter(Boolean);
    const target = v.kind === 'running_bill' ? v.running_bill_id : v.kind === 'supplier_bill' ? v.supplier_bill_id : v.kind === 'labor' ? v.labor_entry_id : v.contract_id;
    if (targets.length !== 1 || !target)
        ctx.addIssue({ code: 'custom', message: 'Provide only the target ID matching the payment kind' });
});
export const changeSchema = z.object({ cost_head_id: id.optional(), contract_id: id.optional(), budget_change: z.number().int().min(-2147483647).max(2147483647).default(0), contract_change: z.number().int().min(-2147483647).max(2147483647).default(0), reason: z.string().trim().min(3).max(1000), request_key: requestKey }).strict().refine(v => (!!v.budget_change && !!v.cost_head_id || !!v.contract_change && !!v.contract_id) && (!v.budget_change || !!v.cost_head_id) && (!v.contract_change || !!v.contract_id), 'Specify a nonzero budget/contract change and its target');
export const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']) }).strict();
export function estimated(quantity: number, rate: number) { return checkedMoney(Math.round(quantity * rate)); }
export function runningBill(contract: {
    revisedAmount: number;
    certifiedAmount: number;
    retentionBps: number;
    advancePaid: number;
    advanceRecovered: number;
}, cumulative: number, recovery: number) {
    if (cumulative > contract.revisedAmount || cumulative <= contract.certifiedAmount)
        throw badRequest('Cumulative certification must exceed previous certified work and remain within the contract');
    if (recovery > contract.advancePaid - contract.advanceRecovered)
        throw badRequest('Advance recovery exceeds the unrecovered advance');
    const current = cumulative - contract.certifiedAmount;
    const retention = checkedMoney(Math.round(current * contract.retentionBps / 10000));
    const payable = checkedMoney(current - retention - recovery);
    return { previousCertified: contract.certifiedAmount, currentCertified: current, retention, advanceRecovery: recovery, netPayable: payable };
}

export const siteContentSchema = z.object({
 labor: z.array(z.object({ cost_head_id: id, role: name, workers: z.number().int().min(1).max(10000), rate: money.refine(n => n > 0) }).strict()).max(50),
 materials: z.array(z.object({ item_id: id, boq_id: id.optional(), quantity: z.number().int().positive().max(2147483647) }).strict()).max(100),
 expense_ids: z.array(id).max(100),
 photo_ids: z.array(id).max(20),
 note: z.string().trim().max(2000).default(''),
}).strict();
export const siteSaveSchema = z.object({ work_date: pastDateSchema, version: z.number().int().min(0), content: siteContentSchema }).strict();
export const wasteLimitSchema = z.object({ item_id: id, allowance_bps: z.number().int().min(0).max(10000) }).strict();
