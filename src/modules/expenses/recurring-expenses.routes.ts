import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { conflict } from '../../core/http/api-error.js';
import { created, ok } from '../../core/http/response.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody, validateParams } from '../../core/validation/validate.js';
import { idParamSchema } from '../../core/validation/common.schemas.js';
import { recurringBillSchema, calendarDateSchema } from './recurring-expenses.policy.js';
import { dhakaToday } from './expense-input.js';
import { advanceBill, billData, billScope, lockBill, priorBillRequest, pushNotification } from './recurring-expenses.service.js';
const router = Router();
router.use(requireProject);
const write = requireRoles('accountant', 'cashier');
const revisionSchema = z.object({ revision: z.number().int().positive(), paused: z.boolean().optional() });
router.get('/', requireRoles('staff', 'member', 'cashier'), asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req);
  return ok(res, await prisma.recurringExpenseBill.findMany({ where: billScope(scope), orderBy: [{ paused: 'asc' }, { nextDue: 'asc' }] }));
}));
router.post('/', write, validateBody(z.object({ request_key: z.string().uuid(), bill: recurringBillSchema })), asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req);
  const result = await prisma.$transaction(async tx => {
    const payload = JSON.stringify(req.body.bill);
    const previous = await priorBillRequest(tx, scope, req.body.request_key, payload);
    if (previous) return previous;
    const data = await billData(tx, scope, req.body.bill);
    const bill = await tx.recurringExpenseBill.create({ data: { ...data, requestKey: req.body.request_key, requestPayload: payload, tenantId: scope.tenantId, projectId: scope.projectId, createdById: scope.userId } });
    await tx.activity.create({ data: { tenantId: scope.tenantId, projectId: scope.projectId, actorUserId: scope.userId, action: 'expense.recurring_created', entityType: 'recurring_expense', entityId: bill.id } });
    return bill;
  });
  return created(res, result);
}));
router.put('/:id', write, validateParams(idParamSchema), validateBody(z.object({ revision: z.number().int().positive(), bill: recurringBillSchema })), asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req);
  const bill = await prisma.$transaction(async tx => {
    const current = await lockBill(tx, scope, req.params.id);
    if (current.revision !== req.body.revision) throw conflict('This bill changed on another device. Refresh before editing.');
    const data = await billData(tx, scope, req.body.bill);
    // Never move an edited schedule back into a recorded or skipped period.
    const last = await tx.recurringExpensePeriod.findFirst({ where: { billId: current.id }, orderBy: { dueDate: 'desc' } });
    if (last && data.nextDue <= last.dueDate) throw conflict('Choose a due date after the last recorded or skipped period');
    const updated = await tx.recurringExpenseBill.update({ where: { id: current.id }, data: { ...data, remindedFor: null, revision: { increment: 1 } } });
    await tx.activity.create({ data: { tenantId: scope.tenantId, projectId: scope.projectId, actorUserId: scope.userId, action: 'expense.recurring_updated', entityType: 'recurring_expense', entityId: current.id } });
    return updated;
  });
  return ok(res, bill);
}));
router.patch('/:id', write, validateParams(idParamSchema), validateBody(revisionSchema.extend({ paused: z.boolean() })), asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req);
  const bill = await prisma.$transaction(async tx => {
    const current = await lockBill(tx, scope, req.params.id);
    if (current.revision !== req.body.revision) throw conflict('This bill changed on another device. Refresh before editing.');
    const updated = await tx.recurringExpenseBill.update({ where: { id: current.id }, data: { paused: req.body.paused, revision: { increment: 1 } } });
    await tx.activity.create({ data: { tenantId: scope.tenantId, projectId: scope.projectId, actorUserId: scope.userId, action: req.body.paused ? 'expense.recurring_paused' : 'expense.recurring_resumed', entityType: 'recurring_expense', entityId: current.id } });
    return updated;
  });
  return ok(res, bill);
}));
router.delete('/:id', write, validateParams(idParamSchema), validateBody(revisionSchema), asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req);
  await prisma.$transaction(async tx => {
    const current = await lockBill(tx, scope, req.params.id);
    if (current.revision !== req.body.revision) throw conflict('This bill changed on another device. Refresh before deleting.');
    await tx.recurringExpenseBill.update({ where: { id: current.id }, data: { deletedAt: new Date(), revision: { increment: 1 } } });
    await tx.activity.create({ data: { tenantId: scope.tenantId, projectId: scope.projectId, actorUserId: scope.userId, action: 'expense.recurring_deleted', entityType: 'recurring_expense', entityId: current.id } });
  });
  return ok(res, { deleted: true });
}));
const recordSchema = z.object({ due_date: calendarDateSchema, amount: z.number().int().positive().max(2147483647), expense_date: calendarDateSchema.refine(value => value <= dhakaToday(), 'Expense date cannot be in the future'), doc_file_id: z.string().min(1).optional() });
router.post('/:id/record', write, validateParams(idParamSchema), validateBody(recordSchema), asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req);
  const result = await prisma.$transaction(async tx => advanceBill(tx, scope, await lockBill(tx, scope, req.params.id), req.body));
  await pushNotification(result.notification);
  return ok(res, { bill: result.bill, expense: result.expense });
}));
router.post('/:id/skip', write, validateParams(idParamSchema), validateBody(z.object({ due_date: calendarDateSchema })), asyncHandler(async (req, res) => {
  const scope = requireProjectContext(req);
  const result = await prisma.$transaction(async tx => advanceBill(tx, scope, await lockBill(tx, scope, req.params.id), { ...req.body, skip: true }));
  return ok(res, { bill: result.bill, expense: null });
}));
export const recurringExpensesRouter = router;
