import { z } from 'zod';
import { dateSchema } from '../accounting/workflow.js';
import { requestKey, money } from '../billing/billing.policy.js';
import { ALLOWANCE, mobile, monthSchema, type PayrollRow } from './payroll.policy.js';

/**
 * Spreadsheet imports for organizations that already run payroll elsewhere.
 * - opening: the starting point (employees, PF balances, advance, leave already used). Moves no money.
 * - run: this month's figures prepared from a sheet, then checked/approved/disbursed as usual.
 * - history: months already paid outside the app, recorded as history. Moves no money.
 */
const phone = z.string().max(30).transform(mobile).pipe(z.string().regex(/^01[3-9]\d{8}$/, 'Use a valid 11-digit mobile'));
const days = z.number().int().min(0).max(366);
export const openingRow = z.object({
  name: z.string().trim().min(1).max(120), mobile: phone, designation: z.string().trim().max(120).default(''), department: z.string().trim().max(120).default(''),
  joining_date: dateSchema, basic: money.refine(n => n > 0, 'Basic salary must be positive'), medical: money.default(0), transport: money.default(0), pf_member: z.boolean(),
  probation_completed_on: dateSchema.optional(),
  pf_own: money.default(0), pf_company: money.default(0), pf_profit: money.default(0), advance: money.default(0),
  annual_used: days.default(0), sick_used: days.default(0), casual_used: days.default(0),
}).strict();
export const openingSchema = z.object({ as_of: dateSchema, rows: z.array(openingRow).min(1).max(2000), request_key: requestKey }).strict()
  .refine(b => new Set(b.rows.map(r => r.mobile)).size === b.rows.length, 'An employee mobile occurs twice in this file');

export const salaryImportRow = z.object({
  mobile: phone, basic: money, house_rent: money.default(0), medical: money.default(0), transport: money.default(0), bonus: money.default(0),
  unpaid_days: z.number().min(0).max(31).default(0), unpaid_deduction: money.default(0), pf: money.default(0), company_pf: money.default(0),
  tax: money.default(0), advance: money.default(0), other_deduction: money.default(0), net: money.optional(),
}).strict();
const rows = z.array(salaryImportRow).min(1).max(2000);
export const runImportSchema = z.object({ month: monthSchema, source_name: z.string().trim().max(160).default(''), rows, request_key: requestKey }).strict()
  .refine(b => new Set(b.rows.map(r => r.mobile)).size === b.rows.length, 'An employee mobile occurs twice in this file');
export const historyImportSchema = z.object({ month: monthSchema, paid_on: dateSchema, source_name: z.string().trim().max(160).default(''), rows, request_key: requestKey }).strict()
  .refine(b => new Set(b.rows.map(r => r.mobile)).size === b.rows.length, 'An employee mobile occurs twice in this file')
  .refine(b => b.paid_on >= `${b.month}-01`, 'The paid date cannot be before the salary month');

export type SalaryImportRow = z.infer<typeof salaryImportRow>;
export type ImportedPayrollRow = PayrollRow & { bonus: number; otherDeduction: number; source: 'spreadsheet' };

/** Validates one employee's spreadsheet figures. Net is always recalculated; a sheet net must agree. */
export function importedSalaryRow(employee: { id: string; name: string; advance: number }, row: SalaryImportRow, { checkAdvance }: { checkAdvance: boolean }): { row?: ImportedPayrollRow; issue?: string } {
  const gross = row.basic + row.house_rent + row.medical + row.transport + row.bonus;
  const net = gross - row.unpaid_deduction - row.pf - row.tax - row.advance - row.other_deduction;
  if (!Number.isSafeInteger(gross) || gross > 2147483647) return { issue: `${employee.name}: earnings are too large` };
  if (net < 0) return { issue: `${employee.name}: deductions exceed earnings` };
  if (row.net !== undefined && row.net !== net) return { issue: `${employee.name}: net in the file (${row.net}) does not match earnings minus deductions (${net})` };
  if (checkAdvance && row.advance > employee.advance) return { issue: `${employee.name}: advance recovery ${row.advance} is more than the outstanding advance ${employee.advance}` };
  if (row.unpaid_deduction > gross) return { issue: `${employee.name}: unpaid deduction is more than earnings` };
  return { row: {
    employeeId: employee.id, name: employee.name, employmentType: 'permanent', basic: row.basic, houseRent: row.house_rent, medical: row.medical, transport: row.transport, gross,
    unpaidDays: row.unpaid_days, attendanceUnpaidDays: 0, leaveUnpaidDays: 0, unpaidDeduction: row.unpaid_deduction, pf: row.pf, companyPF: row.company_pf,
    tax: row.tax, advance: row.advance, bills: 0, billIds: [], net, bonus: row.bonus, otherDeduction: row.other_deduction, source: 'spreadsheet',
  } };
}

export function openingIssues(row: z.infer<typeof openingRow>, asOf: string, allowance: Record<keyof typeof ALLOWANCE, number> = ALLOWANCE) {
  const issues: string[] = [];
  if (row.joining_date > asOf) issues.push(`${row.name}: joined after the balance date; add them as a new employee instead`);
  if (row.probation_completed_on && (row.probation_completed_on < row.joining_date || row.probation_completed_on > asOf)) issues.push(`${row.name}: probation completion must be between joining and the balance date`);
  for (const [field, type] of [['annual_used', 'Annual'], ['sick_used', 'Sick'], ['casual_used', 'Casual']] as const)
    if (row[field] > allowance[type]) issues.push(`${row.name}: ${type.toLowerCase()} leave used is more than the ${allowance[type]}-day allowance`);
  if (!row.pf_member && (row.pf_own || row.pf_company || row.pf_profit)) issues.push(`${row.name}: has a PF balance but is not marked as a PF member`);
  return issues;
}
/** Spreadsheet-prepared runs keep their figures; automatic recalculation never overwrites them. */
export const spreadsheetRun = (snapshot: unknown) => !!snapshot && typeof snapshot === 'object' && (snapshot as { source?: unknown }).source === 'spreadsheet';
