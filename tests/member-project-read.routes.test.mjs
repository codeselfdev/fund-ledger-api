import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import express from 'express';
import { prisma } from '../dist/core/prisma/client.js';
import { membersRouter } from '../dist/modules/members/members.routes.js';
import { memberProfileRouter } from '../dist/modules/members/member-profile.routes.js';
import { expensesRouter } from '../dist/modules/expenses/expenses.routes.js';
import { dashboardRouter } from '../dist/modules/dashboard/dashboard.routes.js';
import { accountsRouter } from '../dist/modules/accounts/accounts.routes.js';

let server, url, queries;
const member = { id: 'other', tenantId: 'tenant', projectId: 'project', userId: 'private-user', name: 'Member example', mobile: '+8801711000000', shares: 2, status: 'active', email: 'private@example.com', address: 'Private address', profile: { photo_file_id: 'photo', nid: 'private-nid', nominee_mobile: 'private-number' } };
const expense = { id: 'expense', tenantId: 'tenant', projectId: 'project', title: 'Materials', amount: 5000, category: 'materials', status: 'approved', expenseDate: new Date(), createdAt: new Date(), paidAt: null };
const tx = { id: 'transaction', tenantId: 'tenant', projectId: 'project', direction: 'money_out', amount: 5000, accountId: 'cash' };
const matches = (row, where) => Object.entries(where).every(([key, value]) => key === 'OR' || (typeof value === 'object' && value !== null ? !value.in || value.in.includes(row[key]) : row[key] === value));
before(async () => {
  queries = [];
  prisma.member.findMany = async ({ where }) => { queries.push(where); return matches(member, where) ? [member] : []; };
  prisma.member.findFirst = async ({ where }) => matches(member, where) ? member : null;
  prisma.due.groupBy = async ({ where }) => {
    queries.push(where);
    return where.projectId === 'project' ? [{ memberId: 'other', _sum: { amount: 10000, paidAmount: 3000, waivedAmount: 500, penaltyDue: 100, penaltyPaid: 50 } }] : [];
  };
  prisma.expense.findMany = async ({ where }) => { queries.push(where); return matches(expense, where) ? [expense] : []; };
  prisma.accountTransaction.findMany = async ({ where }) => { queries.push(where); return matches(tx, where) ? [tx] : []; };
  prisma.account.findMany = async () => [];
  prisma.upload.findFirst = async () => null;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { tenantId: 'tenant', projectId: req.header('x-project') || 'project', userId: 'viewer', memberId: 'self', roles: [req.header('x-role') || 'member'] }; next();
  });
  app.use('/members', memberProfileRouter, membersRouter); app.use('/expenses', expensesRouter);
  app.use('/', dashboardRouter); app.use('/accounts', accountsRouter);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
test('members can read active directory and outstanding dues without private profile fields', async () => {
  const response = await request('/members?status=inactive'); assert.equal(response.status, 200);
  const row = response.body.data[0]; assert.equal(row.name, member.name); assert.equal(row.due_amount, 6550);
  assert.deepEqual(row.profile, { photo_file_id: 'photo' }); assert.equal(row.email, null); assert.equal(row.address, null); assert.equal(row.userId, null);
  assert.equal(queries.at(-2).status, 'active');
});
test('staff directory retains full existing member records', async () => {
  const response = await request('/members', 'GET', undefined, { 'x-role': 'accountant' });
  assert.equal(response.status, 200); assert.equal(response.body.data[0].email, member.email); assert.equal(response.body.data[0].profile.nid, 'private-nid');
});
test('members can read expense list, category charts, and ledger filters', async () => {
  assert.equal((await request('/expenses')).body.data[0].id, 'expense');
  assert.equal((await request('/expenses/by-category')).body.data[0].total_amount, 5000);
  const response = await request('/ledger?direction=out'); assert.equal(response.status, 200); assert.equal(response.body.data[0].id, 'transaction');
  assert.equal(queries.at(-1).direction, 'money_out');
});
test('all shared reads keep tenant and active-project scope', async () => {
  for (const path of ['/members', '/expenses', '/expenses/by-category', '/ledger']) {
    const response = await request(path, 'GET', undefined, { 'x-project': 'foreign' }); assert.equal(response.status, 200); assert.deepEqual(response.body.data, []);
  }
  for (const where of queries) { assert.equal(where.tenantId, 'tenant'); assert.ok(['project', 'foreign'].includes(where.projectId)); }
});
test('member-only accounts cannot create, approve, reject, or disburse expenses', async () => {
  for (const path of ['/expenses', '/expenses/expense/approve', '/expenses/expense/reject', '/expenses/expense/disburse']) {
    assert.equal((await request(path, 'POST', { title: 'New expense', amount: 1000, category: 'materials', account_id: 'cash', reason: 'Reason' })).status, 403, path);
  }
});
test('member directory access does not grant edits, invitations, settlement or account actions', async () => {
  for (const [path, method, body] of [
    ['/members', 'POST', { name: 'New member', mobile: '+8801711000001', shares: 1 }],
    ['/members/other', 'PATCH', { shares: 10 }],
    ['/members/other/profile', 'PATCH', { email: 'changed@example.com' }],
    ['/members/other/invitation/resend', 'POST', {}],
    ['/members/other/remove', 'POST', { reason: 'Reason' }],
    ['/accounts', 'POST', { name: 'New account', type: 'cash' }],
    ['/accounts/cash/adjust', 'POST', { amount: 1000, reason: 'Reason' }],
  ]) assert.equal((await request(path, method, body)).status, 403, path);
});
test('directory photo access stays limited to active project members without allowing other profile reads', async () => {
  // Missing storage record is 404 after permission passes, rather than a 403.
  assert.equal((await request('/members/other/photo')).status, 404);
  assert.equal((await request('/members/other')).status, 403);
  assert.equal((await request('/members/other/dues')).status, 403);
  assert.equal((await request('/members/other/payments')).status, 403);
  assert.equal((await request('/members/other/photo', 'GET', undefined, { 'x-project': 'foreign' })).status, 404);
});
