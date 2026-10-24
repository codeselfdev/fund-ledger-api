import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { json } from '../billing/billing.policy.js';
import { leaveSchema, leaveDecisionSchema, billSchema, decisionSchema, disburseSchema, workingDates, leaveLeft, day, atDate, today, type ALLOWANCE } from './payroll.policy.js';
import { access, allowed, mutate, employee, attachment, scope, audit, history, rebuild, config, revision, postPayment, type PayrollAuth, type Tx } from './payroll.service.js';

async function leaveAvailability(tx: Tx, a: PayrollAuth, input: { employeeId: string; type: string; dates: string[]; days: number; excludeId?: string }) {
  const others = await tx.payrollLeave.findMany({ where: { ...scope(a), employeeId: input.employeeId, status: { in: ['pending', 'approved'] }, ...(input.excludeId ? { id: { not: input.excludeId } } : {}) } });
  const dates = new Set(input.dates);
  if (others.some(l => l.workingDates.some(d => dates.has(d)))) throw conflict('An approved or pending leave request overlaps these working days');
  if (input.type !== 'Unpaid') {
    const left = leaveLeft(others, input.dates[0].slice(0, 4), true);
    if (input.days > left[input.type as keyof typeof ALLOWANCE]) throw conflict('There is not enough leave left, including pending requests');
  }
}
export async function submitLeave(a: PayrollAuth, b: z.infer<typeof leaveSchema>) {
  allowed(access(a).member, 'Employees need a member role to apply for their own leave');
  return mutate(a, 'leave.submit', b, async tx => {
    const row = await employee(tx, a, b.employee_id, true), dates = workingDates(b.start_date, b.days);
    if (b.start_date < today() || dates[0] < day(row.joiningDate)) throw badRequest('Leave must start on or after today and the joining date');
    if (dates.some(d => d.slice(0, 4) !== b.start_date.slice(0, 4))) throw badRequest('Submit separate leave requests for each calendar year');
    if (b.type === 'Sick' && b.days > 2 && !b.note_file_id) throw badRequest('A doctor’s note is required for more than two sick days');
    if (b.note_file_id) await attachment(tx, a, b.note_file_id, 'payroll_leave_note');
    await leaveAvailability(tx, a, { employeeId: row.id, type: b.type, dates, days: b.days });
    const request = await tx.payrollLeave.create({ data: { ...scope(a), employeeId: row.id, type: b.type, startDate: atDate(dates[0]), endDate: atDate(dates[dates.length - 1]), workingDates: dates, days: b.days, reason: b.reason, noteFileId: b.note_file_id, createdById: a.userId } });
    await audit(tx, a, 'leave.submitted', 'payroll_leave', request.id, { employee_id: row.id, days: b.days, type: b.type });
    return { id: request.id, status: request.status };
  });
}
export async function decideLeave(a: PayrollAuth, id: string, b: z.infer<typeof leaveDecisionSchema>) {
  allowed(access(a).approve);
  return mutate(a, `leave:${id}:decision`, b, async tx => {
    const row = await tx.payrollLeave.findFirst({ where: { id, ...scope(a) }, include: { employee: true } });
    if (!row) throw notFound('Leave request not found');
    if (row.status !== 'pending') throw conflict('This leave request was already decided');
    if (row.createdById === a.userId || row.employee.userId === a.userId) throw forbidden('Another approver must review your leave');
    if (b.decision === 'reject' && !b.reason) throw badRequest('Add a rejection reason');
    if (b.decision === 'approve') {
      if (row.employee.status === 'inactive') throw conflict('The employee is inactive');
      await leaveAvailability(tx, a, { employeeId: row.employeeId, type: row.type, dates: row.workingDates, days: row.days, excludeId: row.id });
      if (row.type === 'Unpaid') {
        const paid = await tx.payrollRun.findFirst({ where: { ...scope(a), status: 'paid', month: { in: [...new Set(row.workingDates.map(d => d.slice(0, 7)))] } } });
        if (paid) throw conflict(`Payroll for ${paid.month} is already paid. Record an explicit payroll adjustment before approving this unpaid leave.`);
      }
    }
    const status = b.decision === 'approve' ? 'approved' : 'rejected';
    await tx.payrollLeave.update({ where: { id }, data: { status, rejectionReason: b.decision === 'reject' ? b.reason : null, decidedById: a.userId, decidedAt: new Date() } });
    await rebuild(tx, a, 'Reprepared after unpaid leave approval');
    await audit(tx, a, `leave.${status}`, 'payroll_leave', id, { employee_id: row.employeeId, reason: b.reason });
    return { id, status };
  });
}
export async function submitBill(a: PayrollAuth, b: z.infer<typeof billSchema>) {
  const role = access(a); allowed(role.member || role.manage || role.check);
  return mutate(a, 'bill.submit', b, async tx => {
    const row = await employee(tx, a, b.employee_id, !(role.manage || role.check));
    if (b.date > today() || b.date < day(row.joiningDate)) throw badRequest('Receipt date must be between joining and today');
    const receipt = await attachment(tx, a, b.receipt_file_id, 'payroll_receipt');
    if (await tx.payrollBill.findFirst({ where: { ...scope(a), receiptFileId: receipt.id } })) throw conflict('This receipt was already submitted');
    const bill = await tx.payrollBill.create({ data: { ...scope(a), employeeId: row.id, category: b.category, amount: b.amount, date: atDate(b.date), note: b.note, receiptFileId: receipt.id, receiptName: receipt.fileName, receiptType: receipt.mimeType, createdById: a.userId, history: json(await history(tx, a, 'Submitted')) } });
    await audit(tx, a, 'bill.submitted', 'payroll_bill', bill.id, { employee_id: row.id, amount: bill.amount });
    return { id: bill.id, status: bill.status };
  });
}
export async function decideBill(a: PayrollAuth, id: string, action: 'check' | 'approve' | 'reject', b: z.infer<typeof decisionSchema>) {
  const role = access(a); allowed(action === 'check' ? role.check : action === 'approve' ? role.approve : role.check || role.approve);
  return mutate(a, `bill:${id}:${action}`, b, async tx => {
    const row = await tx.payrollBill.findFirst({ where: { id, ...scope(a) }, include: { employee: true } });
    if (!row) throw notFound('Bill not found');
    revision(row.revision, b.revision);
    if (row.createdById === a.userId || row.employee.userId === a.userId) throw forbidden('Another reviewer must decide your bill');
    const twoStep = (await config(tx, a)).billApproval === 'two_step';
    if (action === 'check' && (!twoStep || row.status !== 'submitted')) throw conflict('This bill does not need an accountant check at this stage');
    if (action === 'approve' && row.status !== (twoStep ? 'checked' : 'submitted') && !(row.status === 'checked' && !twoStep)) throw conflict('Check this bill before final approval');
    if (action === 'approve' && row.checkedById === a.userId) throw forbidden('The bill checker cannot also approve it');
    if (action === 'reject' && (!['submitted', 'checked'].includes(row.status) || !b.reason)) throw badRequest('Only waiting bills can be rejected, with a reason');
    const status = action === 'check' ? 'checked' : action === 'approve' ? 'approved' : 'rejected';
    await tx.payrollBill.update({ where: { id }, data: { status, ...(action === 'check' ? { checkedById: a.userId } : action === 'approve' ? { approvedById: a.userId } : { rejectionReason: b.reason }), revision: { increment: 1 }, history: json(await history(tx, a, status.charAt(0).toUpperCase() + status.slice(1), row.history, b.reason)) } });
    await rebuild(tx, a, 'Reprepared after bill approval');
    await audit(tx, a, `bill.${status}`, 'payroll_bill', id, { reason: b.reason });
    return { id, status };
  });
}
export async function disburseBill(a: PayrollAuth, id: string, b: z.infer<typeof disburseSchema>) {
  allowed(access(a).pay);
  return mutate(a, `bill:${id}:disburse`, b, async tx => {
    const bill = await tx.payrollBill.findFirst({ where: { id, ...scope(a) }, include: { employee: true } });
    if (!bill) throw notFound('Bill not found');
    revision(bill.revision, b.revision);
    if (bill.status !== 'approved' || !bill.approvedById || bill.reservedRunId) throw conflict('Only an approved unpaid bill outside a salary run can be paid separately');
    const result = await postPayment(tx, a, { account_id: b.account_id, amount: bill.amount, title: `${bill.category} reimbursement · ${bill.employee.name}`, referenceType: 'payroll_bill', referenceId: id, approvedById: bill.approvedById, requestKey: b.request_key, receiptFileId: bill.receiptFileId });
    await tx.payrollBill.update({ where: { id }, data: { status: 'paid', posting: json(result), revision: { increment: 1 }, history: json(await history(tx, a, 'Paid separately', bill.history, `Source account: ${result.accountName}`)) } });
    return result;
  });
}
