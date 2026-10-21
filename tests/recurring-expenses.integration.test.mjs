import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
const database = process.env.RECURRING_EXPENSE_TEST_DATABASE_URL;
test('recurring expenses persist periods, approvals and cross-device transitions in PostgreSQL', { skip: !database }, async t => {
  process.env.DATABASE_URL = database;
  process.env.JWT_SECRET = 'isolated-recurring-expense-test';
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { recurringExpensesRouter } = await import('../dist/modules/expenses/recurring-expenses.routes.js');
  const { expensesRouter } = await import('../dist/modules/expenses/expenses.routes.js');
  const { runRecurringExpenses } = await import('../dist/modules/expenses/recurring-expenses.service.js');
  const { errorHandler } = await import('../dist/core/http/error-handler.js');
  const { default: express } = await import('express');
  const tenant = await prisma.tenant.create({ data: { name: 'Synthetic recurring test', slug: randomUUID(), contact: { subscription: { status: 'active', current_period_end_at: '2099-01-01T00:00:00Z' } } } });
  const author = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Synthetic accountant', mobile: '+16505550173' } });
  const approver = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Synthetic approver', mobile: '+16505550174' } });
  const projects = [];
  for (const projectType of ['fund_shares', 'accounting', 'billing', 'construction']) {
    const project = await prisma.project.create({ data: { tenantId: tenant.id, name: projectType, projectType, totalShares: 1 } });
    const account = await prisma.account.create({ data: { tenantId: tenant.id, projectId: project.id, name: 'Test cash', type: 'cash', balance: 100000 } });
    const category = await prisma.expenseCategoryDef.create({ data: { tenantId: tenant.id, projectId: project.id, name: 'Utilities' } });
    await prisma.projectMembership.createMany({ data: [{ tenantId: tenant.id, projectId: project.id, userId: author.id, role: 'accountant' }, { tenantId: tenant.id, projectId: project.id, userId: approver.id, role: 'approver' }] });
    projects.push({ project, account, category });
  }
  const fixture = projects[0];
  await prisma.onboardingProgress.create({ data: { tenantId: tenant.id, projectId: fixture.project.id } });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.auth = { tenantId: tenant.id, projectId: req.header('x-project-id') ?? fixture.project.id, userId: req.header('x-user-id') ?? author.id, roles: [req.header('x-role') ?? 'accountant'] }; next(); });
  app.use('/expenses/recurring', recurringExpensesRouter); app.use('/expenses', expensesRouter); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/expenses`;
  const request = async (path, body, method = body ? 'POST' : 'GET', headers = {}) => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, ...(await response.json()) };
  };
  const good = async (...args) => { const result = await request(...args); assert.ok(result.status < 300, JSON.stringify(result)); return result.data; };
  const body = (patch = {}, f = fixture) => ({ preset: 'electricity', name: 'Electricity bill', vendor: 'Synthetic utility', category_def_id: f.category.id, account_id: f.account.id, kind: 'variable', amount: 1200, frequency: 'monthly', day: 21, next_due: '2026-10-21', mode: 'remind', remind_days: 3, reference: 'SYNTHETIC-METER', end_date: null, staff: [], ...patch });
  const create = (patch = {}, f = fixture) => good('/recurring', { request_key: randomUUID(), bill: body(patch, f) }, 'POST', { 'x-project-id': f.project.id });
  const record = (bill, patch = {}) => ({ due_date: bill.nextDue.slice(0, 10), amount: 1500, expense_date: '2026-10-21', ...patch });
  const balance = async () => (await prisma.account.findUnique({ where: { id: fixture.account.id } })).balance;
  try {
    await t.test('same module supports every project type and each read stays scoped', async () => {
      for (const f of projects) { const bill = await create({}, f); const list = await good('/recurring', undefined, 'GET', { 'x-project-id': f.project.id }); assert.equal(list.length, 1); assert.equal(list[0].id, bill.id); }
      const bad = await request('/recurring', { request_key: randomUUID(), bill: body({ account_id: projects[1].account.id }) }); assert.equal(bad.status, 404);
      const foreign = await request('/recurring', { request_key: randomUUID(), bill: body({ category_def_id: projects[1].category.id }) }); assert.equal(foreign.status, 404);
    });
    await t.test('setup retries create once and mismatched key payloads conflict', async () => {
      const requestBody = { request_key: randomUUID(), bill: body({ name: 'Retry-safe utility' }) };
      const results = await Promise.all([good('/recurring', requestBody), good('/recurring', requestBody)]);
      assert.equal(results[0].id, results[1].id);
      assert.equal((await request('/recurring', { ...requestBody, bill: { ...requestBody.bill, amount: 9999 } })).status, 409);
    });
    await t.test('two phones record one period exactly once without debiting an account', async () => {
      const bill = await create(); const count = await prisma.expense.count();
      const results = await Promise.all([good(`/recurring/${bill.id}/record`, record(bill)), good(`/recurring/${bill.id}/record`, record(bill))]);
      assert.equal(results[0].expense.id, results[1].expense.id); assert.equal(await prisma.expense.count(), count + 1);
      assert.equal(results[0].expense.status, 'pending'); assert.equal(results[0].bill.nextDue.slice(0, 10), '2026-11-21'); assert.equal(await balance(), 100000);
      assert.equal((await request(`/recurring/${bill.id}/skip`, { due_date: '2026-10-21' })).status, 409);
      assert.equal((await request(`/recurring/${bill.id}/record`, record(bill, { amount: 9999 }))).status, 409);
      assert.equal((await request(`/recurring/${bill.id}/record`, record(bill, { due_date: '2026-09-21' }))).status, 409);
      const paid = await good(`/${results[0].expense.id}/approve`, {}, 'POST', { 'x-role': 'approver', 'x-user-id': approver.id }); assert.equal(paid.status, 'paid'); assert.equal(await balance(), 98500);
      assert.equal((await request(`/${paid.id}/approve`, {}, 'POST', { 'x-role': 'approver', 'x-user-id': approver.id })).status, 400); assert.equal(await balance(), 98500);
    });
    await t.test('skips persist once, never create an expense, and use the original month-end anchor', async () => {
      const bill = await create({ day: 31, next_due: '2026-01-31' }); const count = await prisma.expense.count();
      const a = await good(`/recurring/${bill.id}/skip`, { due_date: '2026-01-31' });
      assert.equal(a.bill.nextDue.slice(0, 10), '2026-02-28'); await good(`/recurring/${bill.id}/skip`, { due_date: '2026-01-31' });
      const b = await good(`/recurring/${bill.id}/skip`, { due_date: '2026-02-28' }); assert.equal(b.bill.nextDue.slice(0, 10), '2026-03-31'); assert.equal(await prisma.expense.count(), count);
    });
    await t.test('stale edits conflict; pause blocks recording; deleting keeps past expenses', async () => {
      const bill = await create(); const paused = await good(`/recurring/${bill.id}`, { revision: bill.revision, paused: true }, 'PATCH');
      assert.equal((await request(`/recurring/${bill.id}`, { revision: bill.revision, bill: body() }, 'PUT')).status, 409);
      assert.equal((await request(`/recurring/${bill.id}/record`, record(bill))).status, 400);
      await good(`/recurring/${bill.id}`, { revision: paused.revision, paused: false }, 'PATCH');
      const recorded = await good(`/recurring/${bill.id}/record`, record(bill));
      assert.equal((await request(`/recurring/${bill.id}`, { revision: recorded.bill.revision, bill: body() }, 'PUT')).status, 409);
      await good(`/recurring/${bill.id}`, { revision: recorded.bill.revision }, 'DELETE');
      assert.ok(await prisma.expense.findUnique({ where: { id: recorded.expense.id } })); assert.ok(!(await good('/recurring')).some(row => row.id === bill.id));
    });
    await t.test('variable auto mode, invalid dates, mismatched payroll and read-only writes are rejected', async () => {
      for (const patch of [{ mode: 'auto' }, { next_due: '2026-02-30' }, { day: 3 }, { end_date: '2026-09-30' }, { preset: 'payroll', kind: 'fixed', staff: [{ name: 'Person', amount: 100 }] }]) assert.equal((await request('/recurring', { request_key: randomUUID(), bill: body(patch) })).status, 400);
      for (const role of ['member', 'auditor', 'approver']) assert.equal((await request('/recurring', { request_key: randomUUID(), bill: body() }, 'POST', { 'x-role': role })).status, 403);
      const bill = await create(); assert.equal((await request(`/recurring/${bill.id}/record`, record(bill, { doc_file_id: 'foreign-receipt' }))).status, 404);
      assert.equal((await request(`/recurring/${bill.id}/skip`, { due_date: '2026-10-21' }, 'POST', { 'x-project-id': projects[1].project.id })).status, 404);
    });
    await t.test('new repeating expense and schedule commit together and retry without duplicates', async () => {
      const requestBody = { request_key: randomUUID(), repeat: 'monthly', title: 'Office rent', amount: 500, category_def_id: fixture.category.id, account_id: fixture.account.id, vendor: 'Synthetic landlord', expense_date: '2026-09-30' };
      const before = await balance(), count = await prisma.expense.count();
      const expense = await good('', requestBody, 'POST', { 'x-role': 'admin' }); const again = await good('', requestBody, 'POST', { 'x-role': 'admin' });
      assert.equal(expense.id, again.id); assert.equal(expense.status, 'pending'); assert.equal(await prisma.expense.count(), count + 1); assert.equal(await balance(), before);
      const bill = await prisma.recurringExpenseBill.findUnique({ where: { id: expense.recurringBillId } }); assert.equal(bill.nextDue.toISOString().slice(0, 10), '2026-10-30'); assert.equal(bill.remindDays, 3);
    });
    await t.test('worker creates fixed bills once and persists variable reminders once', async () => {
      await prisma.recurringExpenseBill.updateMany({ data: { paused: true } });
      const auto = await create({ kind: 'fixed', mode: 'auto', day: 31, next_due: '2026-08-31', end_date: '2026-09-30' });
      const variable = await create({ next_due: '2026-10-21' });
      await Promise.all([runRecurringExpenses(new Date('2026-10-21T06:00:00Z')), runRecurringExpenses(new Date('2026-10-21T06:00:00Z'))]);
      const expenses = await prisma.expense.findMany({ where: { recurringBillId: auto.id }, orderBy: { recurringDueDate: 'asc' } });
      assert.equal(expenses.length, 2);
      assert.equal(await prisma.notification.count({ where: { type: 'expense.submitted', entityId: { in: expenses.map(e => e.id) }, recipientUserId: author.id } }), 2); assert.ok(expenses.every(e => e.status === 'pending')); assert.deepEqual(expenses.map(e => e.recurringDueDate.toISOString().slice(0, 10)), ['2026-08-31', '2026-09-30']);
      assert.equal(await prisma.expense.count({ where: { recurringBillId: variable.id } }), 0);
      const notifications = await prisma.notification.count({ where: { entityType: 'recurring_expense', entityId: variable.id } }); assert.equal(notifications, 1);
      await runRecurringExpenses(new Date('2026-10-21T06:00:00Z')); assert.equal(await prisma.notification.count({ where: { entityType: 'recurring_expense', entityId: variable.id } }), notifications);
    });
    await t.test('worker stops when creator access or subscription expires', async () => {
      await prisma.recurringExpenseBill.updateMany({ data: { paused: true } });
      const bill = await create({ kind: 'fixed', mode: 'auto' });
      await prisma.projectMembership.updateMany({ where: { userId: author.id }, data: { isActive: false } }); await runRecurringExpenses(new Date('2026-10-21T06:00:00Z'));
      assert.equal(await prisma.expense.count({ where: { recurringBillId: bill.id } }), 0);
      await prisma.projectMembership.updateMany({ where: { userId: author.id }, data: { isActive: true } });
      await prisma.tenant.update({ where: { id: tenant.id }, data: { contact: { subscription: { status: 'expired', current_period_end_at: '2020-01-01T00:00:00Z' } } } });
      await runRecurringExpenses(new Date('2026-10-21T06:00:00Z')); assert.equal(await prisma.expense.count({ where: { recurringBillId: bill.id } }), 0);
    });
  } finally { await new Promise(resolve => server.close(resolve)); await prisma.tenant.delete({ where: { id: tenant.id } }); await prisma.$disconnect(); }
});
