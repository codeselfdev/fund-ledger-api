import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { json } from '../billing/billing.policy.js';
import { financialTransaction } from '../accounting/transaction.js';
import { importSchema, settingsSchema, prepareSchema, runDecisionSchema, disburseSchema, employeeSchema, day, atDate, today, checkedMoney, mobile, type PayrollRow } from './payroll.policy.js';
import { access, allowed, mutate, project, config, rebuild, audit, history, revision, mapRun, postPayment, scope, type PayrollAuth } from './payroll.service.js';

export async function importEmployees(a: PayrollAuth, b: z.infer<typeof importSchema>) {
  allowed(access(a).manage);
  return mutate(a, 'employees.import', b, async tx => {
    const users = await tx.user.findMany({ where: { tenantId: a.tenantId, isActive: true }, select: { id: true, mobile: true } });
    let added = 0, updated = 0;
    for (const row of b.rows) {
      const existing = await tx.payrollEmployee.findFirst({ where: { ...scope(a), mobile: row.mobile } });
      let employeeId: string;
      if (existing) {
        employeeId = existing.id;
        await tx.payrollEmployee.update({ where: { id: existing.id }, data: { name: row.name, designation: row.designation, department: row.department, basic: row.basic, medical: row.medical, transport: row.transport, pfMember: row.pfMember, revision: { increment: 1 } } });
        ++updated;
      } else {
        const candidates = users.filter(u => mobile(u.mobile) === row.mobile);
        if (candidates.length > 1) throw conflict(`More than one account uses ${row.mobile}. Resolve the account link before importing.`);
        const created = await tx.payrollEmployee.create({ data: { ...scope(a), ...row, joiningDate: atDate(row.joiningDate), userId: candidates[0]?.id, status: 'probation' } });
        employeeId = created.id;
        ++added;
      }
      await audit(tx, a, existing ? 'employee.updated' : 'employee.imported', 'payroll_employee', employeeId, { before: existing ? { basic: existing.basic, medical: existing.medical, transport: existing.transport, pfMember: existing.pfMember } : null, after: { ...row, joiningDate: existing ? day(existing.joiningDate) : row.joiningDate } });
    }
    await rebuild(tx, a, 'Reprepared after employee import');
    await audit(tx, a, 'employees.imported', 'project', a.projectId, { added, updated });
    return { added, updated };
  });
}
export async function saveSettings(a: PayrollAuth, b: z.infer<typeof settingsSchema>) {
  allowed(access(a).manage);
  // Settings use their revision as the edit token; they never move money.
  return financialTransaction(async tx => {
    await project(tx, a);
    const old = await config(tx, a); revision(old.revision, b.revision);
    const value = { ...b, revision: b.revision + 1 };
    await tx.payrollConfiguration.upsert({ where: { projectId: a.projectId }, create: { ...scope(a), settings: json(value), revision: value.revision }, update: { settings: json(value), revision: value.revision } });
    await rebuild(tx, a, 'Reprepared after PF settings changed');
    await audit(tx, a, 'settings.saved', 'project', a.projectId, value);
    return value;
  }, 30_000);
}
export async function employeeStatus(a: PayrollAuth, employeeId: string, b: z.infer<typeof employeeSchema>) {
  allowed(access(a).manage);
  return mutate(a, `employee:${employeeId}:status`, b, async tx => {
    const row = await tx.payrollEmployee.findFirst({ where: { id: employeeId, ...scope(a) } });
    if (!row) throw notFound('Employee not found');
    revision(row.revision, b.revision);
    if (b.status === 'active' && (!b.probation_completed_on || b.probation_completed_on < day(row.joiningDate) || b.probation_completed_on > today())) throw badRequest('Confirm the actual probation completion date, between joining and today');
    const updated = await tx.payrollEmployee.update({ where: { id: row.id }, data: { status: b.status, probationCompletedOn: b.status === 'active' ? atDate(b.probation_completed_on!) : b.status === 'probation' ? null : row.probationCompletedOn, revision: { increment: 1 } } });
    await rebuild(tx, a, 'Reprepared after employee eligibility changed');
    await audit(tx, a, 'employee.status_changed', 'payroll_employee', row.id, { status: updated.status, probation_completed_on: updated.probationCompletedOn });
    return { id: updated.id, status: updated.status, revision: updated.revision };
  });
}
export async function prepare(a: PayrollAuth, b: z.infer<typeof prepareSchema>) {
  allowed(access(a).manage);
  return mutate(a, 'run.prepare', b, async tx => {
    const old = await tx.payrollRun.findFirst({ where: { ...scope(a), month: b.month } });
    if (old) return mapRun(old);
    const saved = await tx.payrollRun.create({ data: { ...scope(a), month: b.month, createdById: a.userId, rows: [], settingsSnapshot: json(await config(tx, a)), history: json(await history(tx, a, 'Prepared')) } });
    await rebuild(tx, a, 'Prepared salary calculation');
    const run = await tx.payrollRun.findUniqueOrThrow({ where: { id: saved.id } });
    const rows = run.rows as unknown as PayrollRow[];
    if (!rows.length) throw badRequest('No employees have joined by this payroll month');
    checkedMoney(rows.reduce((sum, row) => sum + row.net, 0));
    await audit(tx, a, 'run.prepared', 'payroll_run', run.id, { month: run.month, employees: rows.length });
    return mapRun(run);
  });
}
export async function transition(a: PayrollAuth, id: string, action: 'check' | 'approve', b: z.infer<typeof runDecisionSchema>) {
  const role = access(a); allowed(action === 'check' ? role.check : role.approve);
  return mutate(a, `run:${id}:${action}`, b, async tx => {
    const row = await tx.payrollRun.findFirst({ where: { id, ...scope(a) } });
    if (!row) throw notFound('Salary run not found');
    revision(row.revision, b.revision);
    if (row.status !== (action === 'check' ? 'prepared' : 'checked')) throw conflict('Review this salary run in the required order');
    if (action === 'check' && row.createdById === a.userId) throw forbidden('Another accountant must check a run you prepared');
    // The preparer can be the final approver; the accountant must be a different person.
    if (action === 'approve' && row.checkedById === a.userId) throw forbidden('The checker cannot also approve the salary run');
    const updated = await tx.payrollRun.update({ where: { id }, data: { status: action === 'check' ? 'checked' : 'approved', ...(action === 'check' ? { checkedById: a.userId } : { approvedById: a.userId }), revision: { increment: 1 }, history: json(await history(tx, a, action === 'check' ? 'Checked' : 'Approved', row.history)) } });
    await audit(tx, a, `run.${action}`, 'payroll_run', id, { revision: updated.revision });
    return mapRun(updated);
  });
}
export async function disburseRun(a: PayrollAuth, id: string, b: z.infer<typeof disburseSchema>) {
  allowed(access(a).pay);
  return mutate(a, `run:${id}:disburse`, b, async tx => {
    const row = await tx.payrollRun.findFirst({ where: { id, ...scope(a) } });
    if (!row) throw notFound('Salary run not found');
    revision(row.revision, b.revision);
    if (row.status !== 'approved' || !row.checkedById || !row.approvedById) throw conflict('Only an approved, unpaid salary run can be disbursed');
    if (row.month > today().slice(0, 7)) throw conflict('A future salary month cannot be paid yet');
    const rows = row.rows as unknown as PayrollRow[], billIds = rows.flatMap(r => r.billIds);
    const bills = await tx.payrollBill.findMany({ where: { ...scope(a), id: { in: billIds }, status: 'approved', reservedRunId: id } });
    if (bills.length !== billIds.length || new Set(billIds).size !== billIds.length) throw conflict('Included bills changed. Refresh and review this run again.');
    const result = await postPayment(tx, a, { account_id: b.account_id, amount: rows.reduce((sum, r) => sum + r.net, 0), title: `Salary & reimbursements · ${row.month}`, referenceType: 'payroll_salary', referenceId: id, approvedById: row.approvedById, requestKey: b.request_key });
    for (const salary of rows) {
      if (salary.pf || salary.companyPF) await tx.payrollPFEntry.create({ data: { ...scope(a), employeeId: salary.employeeId, runId: id, own: salary.pf, company: salary.companyPF } });
      if (salary.advance) await tx.payrollEmployee.update({ where: { id: salary.employeeId }, data: { advance: { decrement: salary.advance } } });
    }
    await tx.payrollBill.updateMany({ where: { ...scope(a), id: { in: billIds }, status: 'approved', reservedRunId: id }, data: { status: 'paid', posting: json(result), revision: { increment: 1 } } });
    for (const bill of bills) await tx.payrollBill.update({ where: { id: bill.id }, data: { history: json(await history(tx, a, `Paid with salary ${row.month}`, bill.history)) } });
    await tx.payrollRun.update({ where: { id }, data: { status: 'paid', posting: json(result), paidAt: new Date(result.paidAt), revision: { increment: 1 }, history: json(await history(tx, a, 'Paid', row.history, `Source account: ${result.accountName}`)) } });
    await rebuild(tx, a, 'Reprepared after advance recovery');
    return result;
  });
}
