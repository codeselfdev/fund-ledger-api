import { records } from './portal.store.js';
import { effectiveEmployment } from './portal.pay.js';
import type { EmployeeProfile } from './portal.types.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ATTENDANCE, type AttendanceSettings } from './attendance.policy.js';
import type { Prisma, PayrollEmployee, PayrollRun } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { financialTransaction } from '../accounting/transaction.js';
import { hash, json } from '../billing/billing.policy.js';
import { settings, DEFAULT_SETTINGS, day, atDate, today, monthEnd, salaryRow, leaveLeft, completedYears, vested, checkedMoney, mobile, type History, type PFSettings, type PayrollRow, type Posting } from './payroll.policy.js';
export type Tx = Prisma.TransactionClient;
export interface PayrollAuth { tenantId: string; projectId: string; userId: string; roles: readonly string[] }
export const scope = (a: PayrollAuth) => ({ tenantId: a.tenantId, projectId: a.projectId });
export function access(a: PayrollAuth) {
  const manage = a.roles.some(r => r === 'owner' || r === 'admin');
  return { manage, check: a.roles.includes('accountant'), approve: manage || a.roles.includes('approver'), pay: manage || a.roles.some(r => r === 'accountant' || r === 'cashier'), staff: a.roles.some(r => ['owner', 'admin', 'accountant', 'approver', 'cashier', 'auditor'].includes(r)), member: a.roles.includes('member') };
}
/** Custom-only personal routes must not inherit a synthetic auditor's team access. */
export function workspaceAccess(a: PayrollAuth & { builtinRoles?: readonly string[]; menuPermissions?: Record<string, {read:boolean;write:boolean}> }) {
  const role=access({...a,roles:a.builtinRoles??a.roles});
  const customTeamRead=['payroll_employees','payroll_run','payroll_attendance','payroll_leave','payroll_bills','payroll_pf'].some(key=>a.menuPermissions?.[key]?.read);
  return {...role,staff:role.staff||customTeamRead,member:role.member||!!a.menuPermissions};
}
export function allowed(condition: boolean, message = 'This payroll action is not permitted for your role'): asserts condition { if (!condition) throw forbidden(message); }
export async function project(tx: Tx, a: PayrollAuth) {
  const row = await tx.project.findFirst({ where: { id: a.projectId, tenantId: a.tenantId, isActive: true } });
  if (!row || row.projectType !== 'payroll_pf') throw forbidden('This feature belongs to Payroll & PF projects');
}
export async function audit(tx: Tx, a: PayrollAuth, action: string, entityType: string, entityId: string, detail: unknown) {
  await tx.activity.create({ data: { ...scope(a), actorUserId: a.userId, action: `payroll.${action}`, entityType, entityId, after: json(detail) } });
}
export async function history(tx: Tx, a: PayrollAuth, action: string, prior: unknown = [], note?: string): Promise<History[]> {
  const user = await tx.user.findFirstOrThrow({ where: { id: a.userId, tenantId: a.tenantId } });
  return [...(prior as History[]), { action, actor: user.name, actorId: a.userId, at: new Date().toISOString(), ...(note ? { note } : {}) }];
}
export function revision(actual: number, expected: number) { if (actual !== expected) throw conflict('This record changed. Refresh before reviewing or paying it.'); }
export async function config(tx: Tx, a: PayrollAuth) {
  const row = await tx.payrollConfiguration.findFirst({ where: scope(a) });
  return row ? settings(row.settings, row.revision) : { ...DEFAULT_SETTINGS };
}
export async function attendanceConfig(tx: Tx, a: PayrollAuth): Promise<AttendanceSettings> {
  const row = await tx.payrollAttendanceConfiguration.findFirst({ where: scope(a) });
  return row ? { ...DEFAULT_ATTENDANCE, ...(row.settings as object), gpsRequired: true, revision: row.revision } : { ...DEFAULT_ATTENDANCE };
}
/** Permanent actor/payload-bound request receipts are committed with the underlying mutation. */
export async function mutate<T>(a: PayrollAuth, action: string, body: { request_key: string }, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return financialTransaction(async tx => {
    await project(tx, a);
    const requestHash = hash({ action, body });
    const old = await tx.payrollOperation.findFirst({ where: { ...scope(a), requestKey: body.request_key } });
    if (old) {
      if (old.userId !== a.userId || old.requestHash !== requestHash) throw conflict('This request key belongs to another action or payload');
      return old.result as T;
    }
    const result = await fn(tx);
    await tx.payrollOperation.create({ data: { ...scope(a), userId: a.userId, requestKey: body.request_key, requestHash, result: json(result) } });
    return result;
  }, 30_000);
}
export async function ownEmployee(tx: Tx, a: PayrollAuth): Promise<PayrollEmployee | null> {
  const linked = await tx.payrollEmployee.findFirst({ where: { ...scope(a), userId: a.userId } });
  if (linked) return linked;
  const user = await tx.user.findFirstOrThrow({ where: { id: a.userId, tenantId: a.tenantId, isActive: true } });
  const candidate = await tx.payrollEmployee.findFirst({ where: { ...scope(a), mobile: mobile(user.mobile), userId: null } });
  if (!candidate) return null;
  // Bind once to the authenticated account, so a later phone-number change cannot transfer salary history.
  const employee = await tx.payrollEmployee.update({ where: { id: candidate.id }, data: { userId: a.userId } });
  await audit(tx, a, 'employee.linked', 'payroll_employee', employee.id, { user_id: a.userId });
  return employee;
}
export async function employee(tx: Tx, a: PayrollAuth, id: string, selfOnly = false) {
  const row = await tx.payrollEmployee.findFirst({ where: { id, ...scope(a) } });
  if (!row) throw notFound('Employee not found');
  if (selfOnly) {
    const own = await ownEmployee(tx, a);
    if (!own || own.id !== id) throw forbidden('You can submit requests only for your linked employee');
  }
  if (row.status === 'inactive') throw conflict('This employee is inactive');
  return row;
}
export async function attachment(tx: Tx, a: PayrollAuth, id: string, purpose: 'payroll_receipt' | 'payroll_leave_note') {
  const row = await tx.upload.findFirst({ where: { id, ...scope(a), userId: a.userId, deletedAt: null, purpose } });
  if (!row || (!row.mimeType.startsWith('image/') && row.mimeType !== 'application/pdf')) throw badRequest('Attach your own image or PDF from this payroll project');
  return row;
}
export async function rebuild(tx: Tx, a: PayrollAuth, reason: string) {
  const runs = await tx.payrollRun.findMany({ where: { ...scope(a), status: { not: 'paid' } }, orderBy: { month: 'asc' } });
  if (!runs.length) return;
  const settings = await config(tx, a);
  const profiles = await records<EmployeeProfile>(tx, a, 'profile');
  const employees = await tx.payrollEmployee.findMany({ where: { ...scope(a), status: { not: 'inactive' } }, orderBy: { id: 'asc' } });
  const leaves = await tx.payrollLeave.findMany({ where: { ...scope(a), status: 'approved' } });
  const attendanceSettings = await attendanceConfig(tx, a);
  const attendance = await tx.payrollAttendance.findMany({ where: scope(a) });
  const bills = await tx.payrollBill.findMany({ where: { ...scope(a), status: 'approved' }, orderBy: [{ date: 'asc' }, { id: 'asc' }] });
  const unpaidIds = new Set(runs.map(r => r.id)), assigned = new Map<string, string>();
  for (const run of runs) {
    const end = monthEnd(run.month);
    const rows = employees.filter(e => day(e.joiningDate) <= end).map(e => {
      const eligible = bills.filter(b => b.employeeId === e.id && day(b.date) <= end && !assigned.has(b.id) && (!b.reservedRunId || unpaidIds.has(b.reservedRunId)));
      eligible.forEach(b => assigned.set(b.id, run.id));
      return salaryRow(e, run.month, settings, leaves.filter(l => l.employeeId === e.id), eligible, attendance.filter(r => r.employeeId === e.id), attendanceSettings.holidays, profiles.find(p => p.employee_id === e.id)?.data);
    });
    if (JSON.stringify(rows) !== JSON.stringify(run.rows) || JSON.stringify(settings) !== JSON.stringify(run.settingsSnapshot)) {
      await tx.payrollRun.update({ where: { id: run.id }, data: { rows: json(rows), settingsSnapshot: json(settings), status: 'prepared', createdById: a.userId, checkedById: null, approvedById: null, revision: { increment: 1 }, history: json(await history(tx, a, reason, run.history)) } });
    }
  }
  for (const bill of bills) {
    const reservation = assigned.get(bill.id) ?? null;
    if (bill.reservedRunId !== reservation && (!bill.reservedRunId || unpaidIds.has(bill.reservedRunId))) await tx.payrollBill.update({ where: { id: bill.id }, data: { reservedRunId: reservation, revision: { increment: 1 } } });
  }
}
export function mapRun(row: PayrollRun, ownId?: string | null) {
  const rows = (row.rows as unknown as PayrollRow[]).filter(r => ownId === undefined || r.employeeId === ownId);
  return { id: row.id, month: row.month, revision: row.revision, status: row.status, rows, history: ownId === undefined ? row.history : [], ...(ownId === undefined && row.posting ? { posting: row.posting } : {}) };
}
export async function workspace(a: PayrollAuth, month: string) {
  return financialTransaction(async tx => {
    await project(tx, a);
    const role = workspaceAccess(a); allowed(role.staff || role.member);
    const me = await ownEmployee(tx, a), where = { ...scope(a), ...(role.staff ? {} : { employeeId: me?.id ?? '__none__' }) };
    const [settings, employees, leaves, bills, run, contributions, attendanceSettings, attendanceRecords] = await Promise.all([
      config(tx, a), tx.payrollEmployee.findMany({ where: { ...scope(a), ...(role.staff ? {} : { id: me?.id ?? '__none__' }) }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      tx.payrollLeave.findMany({ where, include: { employee: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
      tx.payrollBill.findMany({ where, include: { employee: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
      tx.payrollRun.findFirst({ where: { ...scope(a), month } }),
      tx.payrollPFEntry.groupBy({ by: ['employeeId'], where, _sum: { own: true, company: true, profit: true } }),
      attendanceConfig(tx, a), tx.payrollAttendance.findMany({ where: { ...where, date: { gte: atDate(`${month}-01`), lte: atDate(monthEnd(month)) } }, orderBy: [{ date: 'desc' }, { employeeId: 'asc' }] })
    ]);
    const date = today();
    const profiles = await records<EmployeeProfile>(tx, a, 'profile');
    const mapped = employees.map(e => {
      const profile = profiles.find(p => p.employee_id === e.id)?.data, terms = profile ? effectiveEmployment(profile, date) : null;
      const pf = contributions.find(c => c.employeeId === e.id)?._sum;
      const own = pf?.own ?? 0, company = pf?.company ?? 0, profit = pf?.profit ?? 0;
      const vest = vested(completedYears(day(e.joiningDate), date), settings.vesting);
      return { id: e.id, revision: e.revision, name: e.name, mobile: e.mobile, designation: terms?.designation ?? e.designation, department: e.department, joiningDate: day(e.joiningDate), basic: terms?.basic ?? e.basic, medical: e.medical, transport: e.transport, pfMember: e.pfMember, status: e.status, leaveLeft: leaveLeft(leaves.filter(l => l.employeeId === e.id), date.slice(0, 4)), pf: { own, company, profit, loanOutstanding: 0, vestedPercent: vest, payable: checkedMoney(own + profit + Math.round(company * vest / 100)) } };
    });
    return { month, today: date, settings, attendance: { settings: attendanceSettings, records: attendanceRecords.map(r => ({ id: r.id, employeeId: r.employeeId, date: day(r.date), status: r.status, checkIn: r.checkIn?.toISOString() ?? null, checkOut: r.checkOut?.toISOString() ?? null, source: r.source, officeVerified: r.officeVerified, revision: r.revision, history: r.history })) }, employees: mapped, me: mapped.find(e => e.id === me?.id) ?? null,
      run: run && (role.staff || (run.rows as unknown as PayrollRow[]).some(r => r.employeeId === me?.id)) ? mapRun(run, role.staff ? undefined : me?.id) : null,
      leaves: leaves.map(l => ({ id: l.id, employeeId: l.employeeId, name: l.employee.name, type: l.type, startDate: day(l.startDate), endDate: day(l.endDate), days: l.days, reason: l.reason, status: l.status, noteFileId: l.noteFileId, rejectionReason: l.rejectionReason })),
      bills: bills.map(b => ({ id: b.id, revision: b.revision, employeeId: b.employeeId, name: b.employee.name, category: b.category, amount: b.amount, date: day(b.date), note: b.note, receiptFileId: b.receiptFileId, receiptName: b.receiptName, receiptType: b.receiptType, status: b.status, history: b.history, rejectionReason: b.rejectionReason, reservedRunId: b.reservedRunId, ...(role.staff && b.posting ? { posting: b.posting } : {}) }))
    };
  }, 30_000);
}
/** The expense, cash movement and posting reference commit together, with the caller's run/bill changes. */
export async function postPayment(tx: Tx, a: PayrollAuth, input: { account_id: string; amount: number; title: string; referenceType: string; referenceId: string; approvedById: string; requestKey: string; receiptFileId?: string }): Promise<Posting> {
  const amount = checkedMoney(input.amount);
  if (!amount) throw badRequest('The payable amount must be greater than zero');
  const account = await tx.account.findFirst({ where: { id: input.account_id, ...scope(a) } });
  if (!account) throw notFound('Source account not found in this project');
  const changed = await tx.account.updateMany({ where: { id: account.id, ...scope(a), balance: { gte: amount } }, data: { balance: { decrement: amount } } });
  if (changed.count !== 1) throw conflict('Insufficient account balance');
  const updated = await tx.account.findUniqueOrThrow({ where: { id: account.id } });
  const paidAt = new Date(), postingId = randomUUID();
  const categoryName = input.referenceType === 'payroll_salary' ? 'Payroll & reimbursements' : 'Employee reimbursements';
  const category = await tx.expenseCategoryDef.upsert({ where: { projectId_name: { projectId: a.projectId, name: categoryName } }, create: { ...scope(a), name: categoryName }, update: {} });
  const expense = await tx.expense.create({ data: { ...scope(a), title: input.title, amount, category: 'services', categoryDefId: category.id, status: 'paid', accountId: account.id, paidAccountId: account.id, createdById: a.userId, approvedById: input.approvedById, disbursedById: a.userId, paidAt, expenseDate: atDate(today()), docFileId: input.receiptFileId } });
  const movement = await tx.accountTransaction.create({ data: { ...scope(a), accountId: account.id, direction: 'money_out', amount, referenceType: input.referenceType, referenceId: input.referenceId, description: input.title, balanceAfter: updated.balance, occurredOn: atDate(today()), createdById: a.userId, requestKey: `payroll:${input.requestKey}` } });
  const result = { id: postingId, accountId: account.id, accountName: account.name, amount, paidAt: paidAt.toISOString(), ledgerTransactionIds: [movement.id], expenseId: expense.id };
  await audit(tx, a, 'payment.posted', input.referenceType, input.referenceId, result);
  return result;
}
