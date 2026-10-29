import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { z } from 'zod';
import { badRequest, conflict } from '../../core/http/api-error.js';
import { json } from '../billing/billing.policy.js';
import { record } from './portal.store.js';
import { atDate, day, today, monthEnd, checkedMoney, mobile } from './payroll.policy.js';
import { attendanceConfig, access, allowed, mutate, config, rebuild, audit, history, mapRun, scope, type PayrollAuth, type Tx } from './payroll.service.js';
import { openingSchema, runImportSchema, historyImportSchema, importedSalaryRow, openingIssues, type ImportedPayrollRow } from './payroll.imports.policy.js';

const fail = (issues: string[]) => { if (issues.length) throw badRequest(issues.slice(0, 12).join(' · ') + (issues.length > 12 ? ` · and ${issues.length - 12} more` : '')); };

/** Opening balances for an organization that already ran payroll: no money moves, nothing is paid. */
export async function importOpening(a: PayrollAuth, b: z.infer<typeof openingSchema>) {
  allowed(access(a).manage);
  if (b.as_of > today()) throw badRequest('The balance date cannot be in the future');
  return mutate(a, 'import.opening', b, async tx => {
    const allowance = (await attendanceConfig(tx, a)).leaveAllowance;
    fail(b.rows.flatMap(row => openingIssues(row, b.as_of, allowance)));
    const users = await tenantAccounts(tx).findMany({ where: { tenantId: a.tenantId, isActive: true }, select: { id: true, mobile: true } });
    const issues: string[] = [];
    let added = 0, updated = 0, pfTotal = 0;
    for (const row of b.rows) {
      let employee = await tx.payrollEmployee.findFirst({ where: { ...scope(a), mobile: row.mobile } });
      if (employee) {
        // Opening balances start the ledger once; existing PF history would be counted twice.
        if (await tx.payrollPFEntry.count({ where: { ...scope(a), employeeId: employee.id } })) { issues.push(`${row.name}: already has PF records in this project`); continue; }
        if (await tx.payrollLeave.count({ where: { ...scope(a), employeeId: employee.id, reason: OPENING_LEAVE } })) { issues.push(`${row.name}: opening leave was already imported`); continue; }
        const profile = await record(tx, a, 'profile', employee.id, false);
        employee = await tx.payrollEmployee.update({ where: { id: employee.id }, data: {
          name: row.name, designation: row.designation, department: row.department,
          ...(profile ? {} : { basic: row.basic, medical: row.medical, transport: row.transport, pfMember: row.pf_member }),
          advance: row.advance, ...(row.probation_completed_on ? { status: 'active', probationCompletedOn: atDate(row.probation_completed_on) } : {}), revision: { increment: 1 } } });
        ++updated;
      } else {
        const candidates = users.filter(u => mobile(u.mobile) === row.mobile);
        if (candidates.length > 1) { issues.push(`${row.name}: more than one account uses ${row.mobile}`); continue; }
        employee = await tx.payrollEmployee.create({ data: { ...scope(a), name: row.name, mobile: row.mobile, designation: row.designation, department: row.department, joiningDate: atDate(row.joining_date),
          basic: row.basic, medical: row.medical, transport: row.transport, pfMember: row.pf_member, advance: row.advance, userId: candidates[0]?.id,
          status: row.probation_completed_on ? 'active' : 'probation', probationCompletedOn: row.probation_completed_on ? atDate(row.probation_completed_on) : null } });
        ++added;
      }
      if (row.pf_own || row.pf_company || row.pf_profit) {
        await tx.payrollPFEntry.create({ data: { ...scope(a), employeeId: employee.id, runId: null, source: 'opening', own: row.pf_own, company: row.pf_company, profit: row.pf_profit } });
        pfTotal += row.pf_own + row.pf_company + row.pf_profit;
      }
      // Leave already taken this year reduces the remaining allowance only; it never deducts salary.
      const year = b.as_of.slice(0, 4);
      for (const [type, used] of [['Annual', row.annual_used], ['Sick', row.sick_used], ['Casual', row.casual_used]] as const) if (used) {
        await tx.payrollLeave.create({ data: { ...scope(a), employeeId: employee.id, type, startDate: atDate(`${year}-01-01`), endDate: atDate(b.as_of), workingDates: [], days: used,
          reason: OPENING_LEAVE, status: 'approved', createdById: a.userId, decidedById: a.userId, decidedAt: new Date() } });
      }
      await audit(tx, a, 'opening.imported', 'payroll_employee', employee.id, { as_of: b.as_of, pf: { own: row.pf_own, company: row.pf_company, profit: row.pf_profit }, advance: row.advance, leave_used: { Annual: row.annual_used, Sick: row.sick_used, Casual: row.casual_used } });
    }
    fail(issues);
    checkedMoney(pfTotal);
    await rebuild(tx, a, 'Reprepared after opening balances import');
    await audit(tx, a, 'opening.import_completed', 'project', a.projectId, { added, updated, as_of: b.as_of });
    return { added, updated, pfTotal };
  });
}
export const OPENING_LEAVE = 'Opening balance · leave taken before payroll tracking';

async function importedRows(tx: Tx, a: PayrollAuth, month: string, rows: z.infer<typeof runImportSchema>['rows'], checkAdvance: boolean) {
  const employees = await tx.payrollEmployee.findMany({ where: scope(a) });
  const issues: string[] = [], result: ImportedPayrollRow[] = [], end = monthEnd(month);
  for (const row of rows) {
    const employee = employees.find(e => e.mobile === row.mobile);
    if (!employee) { issues.push(`${row.mobile}: no employee with this mobile. Import employees or opening balances first`); continue; }
    if (day(employee.joiningDate) > end) { issues.push(`${employee.name}: joined after ${month}`); continue; }
    const built = importedSalaryRow(employee, row, { checkAdvance });
    if (built.issue) issues.push(built.issue); else result.push(built.row!);
  }
  fail(issues);
  checkedMoney(result.reduce((sum, r) => sum + r.net, 0));
  return result.sort((x, y) => x.name.localeCompare(y.name) || x.employeeId.localeCompare(y.employeeId));
}

/** This month's run prepared from a spreadsheet; it then follows check → approve → disburse. */
export async function importRun(a: PayrollAuth, b: z.infer<typeof runImportSchema>) {
  allowed(access(a).manage);
  if (b.month > today().slice(0, 7)) throw badRequest('A future salary month cannot be prepared from a spreadsheet');
  return mutate(a, 'import.run', b, async tx => {
    if (await tx.payrollRun.findFirst({ where: { ...scope(a), month: b.month } })) throw conflict(`${b.month} already has a salary run. Review that run instead of importing another.`);
    const rows = await importedRows(tx, a, b.month, b.rows, true);
    const run = await tx.payrollRun.create({ data: { ...scope(a), month: b.month, createdById: a.userId, rows: json(rows),
      settingsSnapshot: json({ ...(await config(tx, a)), source: 'spreadsheet' }),
      history: json(await history(tx, a, 'Prepared from spreadsheet', [], b.source_name || undefined)) } });
    await audit(tx, a, 'run.imported', 'payroll_run', run.id, { month: b.month, employees: rows.length, source: b.source_name });
    return mapRun(run);
  });
}

/** Months already paid elsewhere. Recorded as paid history with PF contributions; no account balance changes. */
export async function importHistory(a: PayrollAuth, b: z.infer<typeof historyImportSchema>) {
  allowed(access(a).manage);
  if (b.month >= today().slice(0, 7)) throw badRequest('Only months before the current month can be imported as paid history');
  if (b.paid_on > today()) throw badRequest('The paid date cannot be in the future');
  return mutate(a, 'import.history', b, async tx => {
    if (await tx.payrollRun.findFirst({ where: { ...scope(a), month: b.month } })) throw conflict(`${b.month} already has a salary run`);
    const rows = await importedRows(tx, a, b.month, b.rows, false);
    const run = await tx.payrollRun.create({ data: { ...scope(a), month: b.month, status: 'paid', createdById: a.userId, rows: json(rows), paidAt: atDate(b.paid_on),
      settingsSnapshot: json({ ...(await config(tx, a)), source: 'spreadsheet' }),
      history: json(await history(tx, a, 'Imported as paid history', [], `Paid outside the app on ${b.paid_on}. No account balance changed.${b.source_name ? ` Source: ${b.source_name}` : ''}`)) } });
    for (const row of rows) if (row.pf || row.companyPF) await tx.payrollPFEntry.create({ data: { ...scope(a), employeeId: row.employeeId, runId: run.id, source: 'history', own: row.pf, company: row.companyPF } });
    await audit(tx, a, 'history.imported', 'payroll_run', run.id, { month: b.month, paid_on: b.paid_on, employees: rows.length, net: rows.reduce((s, r) => s + r.net, 0) });
    return mapRun(run);
  });
}
