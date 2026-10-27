import { monthlyEmployment } from './portal.pay.js';
import type { EmployeeProfile } from './portal.types.js';
import { z } from 'zod';
import { unpaidAttendance } from './attendance.policy.js';
import type { PayrollEmployee, PayrollLeave } from '@prisma/client';
import { badRequest } from '../../core/http/api-error.js';
import { dateSchema } from '../accounting/workflow.js';
import { checkedMoney, day, atDate, today, requestKey, id, money } from '../billing/billing.policy.js';
export { checkedMoney, day, atDate, today };
export const monthSchema = z.string().regex(/^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/);
export const leaveType = z.enum(['Annual', 'Sick', 'Casual', 'Unpaid']);
export const billCategory = z.enum(['Conveyance', 'Medical', 'Mobile', 'Food', 'Travel', 'Other']);
export const ALLOWANCE = { Annual: 20, Sick: 14, Casual: 10 };
export const BILL_LIMITS = { Conveyance: 3000, Medical: 5000, Mobile: 500, Food: 1000, Travel: null, Other: null };
export const settingsSchema = z.object({
  rate: z.union([z.literal(5), z.literal(7.5), z.literal(10)]), basis: z.enum(['basic', 'gross']), match: z.enum(['equal', 'half', 'off']),
  eligibility: z.enum(['joining', 'probation', 'one_year']), vesting: z.enum(['graded', 'cliff', 'immediate']),
  profitRate: z.number().finite().min(0).max(100), loans: z.boolean(), loanPercent: z.union([z.literal(50), z.literal(80), z.literal(100)]),
  loanMonths: z.union([z.literal(12), z.literal(24), z.literal(36)]), withdrawalApproval: z.enum(['two_step', 'approver']), billApproval: z.enum(['two_step', 'approver']), revision: z.number().int().nonnegative()
}).strict();
export type PFSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: PFSettings = { rate: 10, basis: 'basic', match: 'equal', eligibility: 'probation', vesting: 'graded', profitRate: 6, loans: true, loanPercent: 80, loanMonths: 24, withdrawalApproval: 'two_step', billApproval: 'two_step', revision: 0 };
export function settings(raw: unknown, revision = 0): PFSettings { return settingsSchema.parse({ ...DEFAULT_SETTINGS, ...(raw as object ?? {}), revision }); }
export const mobile = (value: string) => { if (!/^[+\d\s().-]+$/.test(value)) return ''; const digits = value.replace(/\D/g, ''); return digits.startsWith('880') ? digits.slice(2) : digits; };
const importedMoney = z.string().trim().regex(/^\d+$/, 'Use whole taka').transform(Number).pipe(money);
const importRow = z.object({
  name: z.string().trim().min(1).max(120), mobile: z.string().max(30).transform(mobile).pipe(z.string().regex(/^01[3-9]\d{8}$/)),
  designation: z.string().trim().max(120), department: z.string().trim().max(120), joiningDate: dateSchema,
  basic: importedMoney.refine(n => n > 0, 'Basic salary must be positive'), medical: importedMoney, transport: importedMoney, pfMember: z.boolean()
}).strict();
export const importSchema = z.object({ rows: z.array(importRow).min(1).max(2000), match_by: z.literal('mobile'), request_key: requestKey }).strict().refine(b => new Set(b.rows.map(r => r.mobile)).size === b.rows.length, 'An employee mobile occurs twice in this file');
export const prepareSchema = z.object({ month: monthSchema, request_key: requestKey }).strict();
export const decisionSchema = z.object({ revision: z.number().int().nonnegative(), reason: z.string().trim().max(2000).default(''), request_key: requestKey }).strict();
export const runDecisionSchema = decisionSchema.omit({ reason: true });
export const disburseSchema = z.object({ account_id: id, revision: z.number().int().nonnegative(), request_key: requestKey }).strict();
export const leaveSchema = z.object({ employee_id: id, type: leaveType, start_date: dateSchema, days: z.number().int().min(1).max(366), reason: z.string().trim().min(1).max(2000), note_file_id: id.optional(), request_key: requestKey }).strict();
export const leaveDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(2000).default(''), request_key: requestKey }).strict();
export const billSchema = z.object({ employee_id: id, category: billCategory, amount: money.refine(n => n > 0), date: dateSchema, note: z.string().trim().max(2000), receipt_file_id: id, request_key: requestKey }).strict();
/** Correcting a wrong joining date (for example an import that defaulted to next month). */
export const joiningDateSchema = z.object({ joining_date: dateSchema, revision: z.number().int().nonnegative(), reason: z.string().trim().min(3).max(500), request_key: requestKey }).strict();
export const employeeSchema = z.object({ revision: z.number().int().nonnegative(), status: z.enum(['active', 'probation', 'inactive']).optional(), probation_completed_on: dateSchema.optional(), request_key: requestKey }).strict();
export type History = { action: string; actor: string; actorId: string; at: string; note?: string };
export interface PayrollRow {
  employmentType?: string; payableHours?: number; hourlyRate?: number; employeeId: string; name: string; basic: number; houseRent: number; medical: number; transport: number; gross: number;
  unpaidDays: number; attendanceUnpaidDays: number; leaveUnpaidDays: number; unpaidDeduction: number; pf: number; companyPF: number; tax: number; advance: number; bills: number; billIds: string[]; net: number;
}
export interface Posting { id: string; accountId: string; accountName: string; amount: number; paidAt: string; ledgerTransactionIds: string[]; expenseId: string }
export function workingDates(start: string, count: number, weekendDays: number[] = [5]) {
  const date = atDate(start), dates: string[] = [];
  while (dates.length < count) {
    if (!weekendDays.includes(date.getUTCDay())) dates.push(day(date));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}
export function completedYears(start: string, end: string) {
  let years = Number(end.slice(0, 4)) - Number(start.slice(0, 4));
  if (end.slice(5) < start.slice(5)) --years;
  return Math.max(0, years);
}
export function vested(years: number, rule: PFSettings['vesting']) { return rule === 'immediate' ? 100 : rule === 'cliff' ? years >= 3 ? 100 : 0 : years >= 5 ? 100 : years >= 3 ? 50 : 0; }
export function monthEnd(month: string) { const [year, m] = month.split('-').map(Number); return day(new Date(Date.UTC(year, m, 0))); }
export function leaveLeft(leaves: Pick<PayrollLeave, 'type' | 'status' | 'days' | 'startDate'>[], year: string, pending = false, allowance: Record<keyof typeof ALLOWANCE, number> = ALLOWANCE) {
  return Object.fromEntries(Object.entries(allowance).map(([type, limit]) => [type, Math.max(0, limit - leaves.filter(l => l.type === type && (l.status === 'approved' || pending && l.status === 'pending') && day(l.startDate).startsWith(year)).reduce((sum, l) => sum + l.days, 0))])) as Record<keyof typeof ALLOWANCE, number>;
}
export function salaryRow(employee: PayrollEmployee, month: string, config: PFSettings, leaves: Pick<PayrollLeave, 'type' | 'status' | 'workingDates'>[], bills: { id: string; amount: number }[], attendance: { date: Date; status: string; checkIn?: Date | null; checkOut?: Date | null }[] = [], holidays: { date: string }[] = [], profile?: EmployeeProfile, weekendDays: number[] = [5]): PayrollRow {
  const pay = profile ? monthlyEmployment(day(employee.joiningDate), profile, month, attendance) : { basic: employee.basic, medical: employee.medical, transport: employee.transport, houseRent: Math.round(employee.basic * .5), pfMember: employee.pfMember, employmentType: 'permanent', payableHours: 0, hourlyRate: 0 };
  const houseRent = checkedMoney(pay.houseRent);
  const gross = checkedMoney(pay.basic + houseRent + pay.medical + pay.transport);
  const end = monthEnd(month), joined = day(employee.joiningDate);
  const eligible = pay.pfMember && (config.eligibility === 'joining' || config.eligibility === 'one_year' && completedYears(joined, end) >= 1 || config.eligibility === 'probation' && employee.probationCompletedOn !== null && day(employee.probationCompletedOn) <= end);
  const own = eligible ? checkedMoney(Math.round((config.basis === 'basic' ? pay.basic : gross) * config.rate / 100)) : 0;
  const companyPF = checkedMoney(Math.round(own * (config.match === 'equal' ? 1 : config.match === 'half' ? .5 : 0)));
  const unpaid = unpaidAttendance(month, joined, leaves, attendance, holidays, weekendDays), unpaidDays = pay.employmentType === 'part_time' ? 0 : unpaid.total;
  const unpaidDeduction = checkedMoney(Math.min(gross, Math.round(gross / 30 * unpaidDays)));
  const annual = gross * 12, taxable = annual - Math.min(annual / 3, 450000);
  const tax = checkedMoney(Math.max(0, Math.round((taxable - 350000) * .05 / 12 / 10) * 10));
  const reimbursements = checkedMoney(bills.reduce((sum, b) => sum + b.amount, 0));
  const advance = Math.min(employee.advance, Math.max(0, gross - unpaidDeduction - own - tax));
  const net = gross - unpaidDeduction - own - tax - advance + reimbursements;
  if (net < 0) throw badRequest(`Deductions exceed earnings for ${employee.name}. Review leave or PF before preparing payroll.`);
  return { employeeId: employee.id, name: employee.name, basic: pay.basic, houseRent, medical: pay.medical, transport: pay.transport, gross, employmentType: pay.employmentType, payableHours: pay.payableHours, hourlyRate: pay.hourlyRate, unpaidDays, attendanceUnpaidDays: unpaid.attendanceDays, leaveUnpaidDays: unpaid.leaveDays, unpaidDeduction, pf: own, companyPF, tax, advance, bills: reimbursements, billIds: bills.map(b => b.id), net: checkedMoney(net) };
}
