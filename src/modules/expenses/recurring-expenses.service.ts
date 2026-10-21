import { Prisma, type RecurringExpenseBill } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { sendPushMessage } from '../../core/notifications/fcm.service.js';
import { evaluateSubscription } from '../../core/subscription/subscription.service.js';
import { dhakaToday, toExpenseDate } from './expense-input.js';
import { stepDue, type RecurringBillInput } from './recurring-expenses.policy.js';
export type Scope = { tenantId: string; projectId: string; userId: string };
type Tx = Prisma.TransactionClient;
const dateKey = (date: Date) => date.toISOString().slice(0, 10);
export const billScope = (scope: Scope) => ({ tenantId: scope.tenantId, projectId: scope.projectId, deletedAt: null });

export async function billData(tx: Tx, scope: Scope, body: RecurringBillInput) {
  const where = { tenantId: scope.tenantId, projectId: scope.projectId };
  if (!await tx.account.findFirst({ where: { ...where, id: body.account_id } })) throw notFound('Account not found');
  if (!await tx.expenseCategoryDef.findFirst({ where: { ...where, id: body.category_def_id } })) throw notFound('Category not found');
  const vendor = body.vendor_id ? await tx.vendor.findFirst({ where: { ...where, id: body.vendor_id } }) : null;
  if (body.vendor_id && !vendor) throw notFound('Vendor not found');
  return {
    preset: body.preset, name: body.name, vendor: vendor?.name ?? body.vendor, vendorId: vendor?.id ?? null,
    categoryDefId: body.category_def_id, accountId: body.account_id, kind: body.kind, amount: body.amount,
    frequency: body.frequency, day: body.day, nextDue: toExpenseDate(body.next_due), mode: body.mode,
    remindDays: body.remind_days, reference: body.reference, endDate: body.end_date ? toExpenseDate(body.end_date) : null,
    staff: body.staff as Prisma.InputJsonValue,
  };
}

export async function lockBill(tx: Tx, scope: Scope, id: string) {
  // Serialize edits, worker runs and submissions across devices and API instances.
  await tx.$queryRaw`SELECT id FROM recurring_expense_bills WHERE id = ${id} AND tenant_id = ${scope.tenantId} AND project_id = ${scope.projectId} FOR UPDATE`;
  const bill = await tx.recurringExpenseBill.findFirst({ where: { id, ...billScope(scope) } });
  if (!bill) throw notFound('Recurring bill not found');
  return bill;
}

// In-app notifications commit with the bill transition. Push delivery is best effort.
export async function queueNotification(tx: Tx, bill: RecurringExpenseBill, type: 'expense.submitted' | 'expense.recurring_due', entityId: string) {
  const approval = type === 'expense.submitted';
  const progress = approval ? await tx.onboardingProgress.findUnique({ where: { tenantId: bill.tenantId }, select: { expenseApprovalFlow: true } }) : null;
  const roles: Array<'owner' | 'admin' | 'accountant' | 'approver' | 'cashier'> = approval
    ? progress?.expenseApprovalFlow === 'accountant_only' ? ['owner', 'admin', 'accountant'] : ['owner', 'admin', 'approver']
    : ['owner', 'admin', 'accountant', 'cashier'];
  const recipients = await tx.projectMembership.findMany({ where: { tenantId: bill.tenantId, projectId: bill.projectId, isActive: true, OR: [{ role: { in: roles } }, ...(approval && bill.mode === 'auto' ? [{ userId: bill.createdById }] : [])], user: { isActive: true } }, select: { userId: true } });
  const recipientUserIds = [...new Set(recipients.map(row => row.userId))];
  const title = approval ? 'Recurring expense awaiting approval' : 'Recurring bill due';
  const body = approval ? `${bill.name} is ready for approval.` : `${bill.name} is due ${dateKey(bill.nextDue)}. ${bill.kind === 'variable' ? 'Enter the actual bill amount.' : bill.mode === 'auto' ? 'It will be created automatically on the due date.' : 'Record this period’s bill.'}`;
  if (recipientUserIds.length) await tx.notification.createMany({ data: recipientUserIds.map(recipientUserId => ({ tenantId: bill.tenantId, projectId: bill.projectId, recipientUserId, type, title, body, entityType: approval ? 'expense' : 'recurring_expense', entityId })) });
  return { recipientUserIds, title, body, tenantId: bill.tenantId, projectId: bill.projectId, type, entityId };
}
export async function pushNotification(message: Awaited<ReturnType<typeof queueNotification>> | null) {
  if (!message?.recipientUserIds.length) return;
  try {
    const users = await prisma.user.findMany({ where: { tenantId: message.tenantId, id: { in: message.recipientUserIds }, isActive: true }, select: { deviceId: true } });
    await sendPushMessage({ tokens: users.flatMap(user => user.deviceId ? [user.deviceId] : []), title: message.title, body: message.body, data: { type: message.type, tenant_id: message.tenantId, project_id: message.projectId, entity_type: message.type === 'expense.submitted' ? 'expense' : 'recurring_expense', entity_id: message.entityId } });
  } catch (error) { console.error('[recurring-expenses] push delivery failed; in-app notification saved', error); }
}

async function audit(tx: Tx, scope: Scope, bill: RecurringExpenseBill, action: string, period: string) {
  await tx.activity.create({ data: { tenantId: scope.tenantId, projectId: scope.projectId, actorUserId: scope.userId, action, entityType: 'recurring_expense', entityId: bill.id, after: { due_date: period } } });
}

export async function advanceBill(tx: Tx, scope: Scope, bill: RecurringExpenseBill, input: { due_date: string; skip?: boolean; amount?: number; expense_date?: string; doc_file_id?: string }) {
  const period = dateKey(bill.nextDue);
  // Same-period retries return the original result, including after the schedule advances.
  const previous = await tx.recurringExpensePeriod.findUnique({ where: { billId_dueDate: { billId: bill.id, dueDate: toExpenseDate(input.due_date) } }, include: { expense: true } });
  if (previous) {
    if (previous.status !== (input.skip ? 'skipped' : 'recorded')) throw conflict('This period was already handled differently. Refresh recurring bills.');
    if (!input.skip && previous.expense && (previous.expense.amount !== (input.amount ?? bill.amount) || dateKey(previous.expense.expenseDate!) !== (input.expense_date ?? dhakaToday()))) throw conflict('This period was already recorded with different details. Refresh recurring bills.');
    return { bill, expense: previous.expense, notification: null };
  }
  if (period !== input.due_date) throw conflict('This bill has changed on another device. Refresh recurring bills.');
  if (bill.paused || (bill.endDate && bill.nextDue > bill.endDate)) throw badRequest('This recurring bill is paused or has ended');
  const amount = input.amount ?? bill.amount;
  if (!input.skip && (!Number.isInteger(amount) || amount <= 0 || amount > 2147483647)) throw badRequest('Enter a valid bill amount');
  if (!input.skip && input.doc_file_id && !await tx.upload.findFirst({ where: { id: input.doc_file_id, tenantId: scope.tenantId, projectId: scope.projectId, deletedAt: null } })) throw notFound('Receipt not found');
  // Validate current references: deleting an account/category cannot silently cross project boundaries.
  if (!input.skip && !await tx.account.findFirst({ where: { id: bill.accountId, tenantId: scope.tenantId, projectId: scope.projectId } })) throw badRequest('Choose a valid source account before recording this bill');
  if (!input.skip && !await tx.expenseCategoryDef.findFirst({ where: { id: bill.categoryDefId, tenantId: scope.tenantId, projectId: scope.projectId } })) throw badRequest('Choose a valid category before recording this bill');
  const expense = input.skip ? null : await tx.expense.create({ data: {
    tenantId: scope.tenantId, projectId: scope.projectId, title: `${bill.name} — ${period}`, amount,
    category: 'services', categoryDefId: bill.categoryDefId, vendor: bill.vendor,
    vendorId: bill.vendorId && await tx.vendor.findFirst({ where: { id: bill.vendorId, tenantId: scope.tenantId, projectId: scope.projectId } }) ? bill.vendorId : null,
    accountId: bill.accountId, expenseDate: toExpenseDate(input.expense_date), docFileId: input.doc_file_id,
    recurringBillId: bill.id, recurringDueDate: toExpenseDate(period), status: 'pending', createdById: scope.userId,
  } });
  await tx.recurringExpensePeriod.create({ data: { billId: bill.id, dueDate: bill.nextDue, status: input.skip ? 'skipped' : 'recorded', expenseId: expense?.id, actorUserId: scope.userId } });
  const next = stepDue(period, bill.frequency as RecurringBillInput['frequency'], bill.day);
  const updated = await tx.recurringExpenseBill.update({ where: { id: bill.id }, data: { nextDue: toExpenseDate(next), remindedFor: null, revision: { increment: 1 } } });
  await audit(tx, scope, bill, input.skip ? 'expense.recurring_skipped' : 'expense.recurring_recorded', period);
  const notification = expense ? await queueNotification(tx, bill, 'expense.submitted', expense.id) : null;
  return { bill: updated, expense, notification };
}

export async function runRecurringExpenses(now = new Date()) {
  const today = dhakaToday(now);
  const horizon = new Date(`${today}T00:00:00Z`); horizon.setUTCDate(horizon.getUTCDate() + 7);
  let cursor: string | undefined;
  for (;;) {
    const bills = await prisma.recurringExpenseBill.findMany({ where: { deletedAt: null, paused: false, nextDue: { lte: horizon }, project: { isActive: true }, AND: [{ OR: [{ endDate: null }, { endDate: { gte: prisma.recurringExpenseBill.fields.nextDue } }] }, { OR: [{ mode: 'auto' }, { remindedFor: null }, { NOT: { remindedFor: { equals: prisma.recurringExpenseBill.fields.nextDue } } }] }] }, orderBy: { id: 'asc' }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), take: 500 });
    for (const candidate of bills) {
      try {
        const project = await prisma.project.findFirst({ where: { id: candidate.projectId, tenantId: candidate.tenantId, isActive: true }, include: { tenant: true } });
        if (!project || !evaluateSubscription(project.tenant.contact).has_access) continue;
        // A schedule cannot keep posting after its creator loses expense-writing access.
        const creator = await prisma.projectMembership.findFirst({ where: { tenantId: candidate.tenantId, projectId: candidate.projectId, userId: candidate.createdById, isActive: true, role: { in: ['owner', 'admin', 'accountant', 'cashier'] }, user: { isActive: true } } });
        if (!creator) continue;
        const scope = { tenantId: candidate.tenantId, projectId: candidate.projectId, userId: candidate.createdById };
        for (let count = 0; count < 24; count++) {
          const result = await prisma.$transaction(async tx => {
            const bill = await lockBill(tx, scope, candidate.id);
            if (bill.paused || (bill.endDate && bill.nextDue > bill.endDate)) return null;
            const due = dateKey(bill.nextDue);
            if (bill.mode === 'auto' && bill.kind === 'fixed' && due <= today) return { ...(await advanceBill(tx, scope, bill, { due_date: due, expense_date: due })), again: true };
            const reminder = new Date(bill.nextDue); reminder.setUTCDate(reminder.getUTCDate() - bill.remindDays);
            if (dateKey(reminder) <= today && bill.remindedFor?.getTime() !== bill.nextDue.getTime()) {
              const notification = await queueNotification(tx, bill, 'expense.recurring_due', bill.id);
              await tx.recurringExpenseBill.update({ where: { id: bill.id }, data: { remindedFor: bill.nextDue } });
              return { notification, again: false };
            }
            return null;
          });
          if (!result) break;
          await pushNotification(result.notification);
          if (!result.again) break;
        }
      } catch (error) { console.error('[recurring-expenses] bill will retry', candidate.id, error); }
    }
    if (bills.length < 500) break;
    cursor = bills[bills.length - 1].id;
  }
}

// A stable request key makes setup retries safe after a lost HTTP response.
export async function priorBillRequest(tx: Tx, scope: Scope, key: string, payload: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'recurring-expense:' + scope.projectId + ':' + key}))::text`;
  const previous = await tx.recurringExpenseBill.findUnique({ where: { projectId_requestKey: { projectId: scope.projectId, requestKey: key } } });
  if (previous && (previous.tenantId !== scope.tenantId || previous.createdById !== scope.userId || previous.requestPayload !== payload)) throw conflict('This request key was already used for different bill details');
  return previous;
}
