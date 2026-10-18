import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import express from 'express';
import { prisma } from '../dist/core/prisma/client.js';
import { accountsRouter } from '../dist/modules/accounts/accounts.routes.js';
import { onboardingRouter } from '../dist/modules/onboarding/onboarding.routes.js';
import { signAccessToken } from '../dist/core/security/jwt.js';
let server, url, rows, transactions, progress, writes, scopeQueries;
const bank = { type: 'bank', bank_name: ' City Bank ', account_name: ' Sunrise Foundation ', account_number: ' 001234567890 ', branch_name: ' Mirpur ' };
const matches = (row, where) => Object.entries(where ?? {}).every(([key,value]) => typeof value === 'object' || row[key] === value);
before(async () => {
  prisma.$transaction = async fn => { const snapshot = structuredClone({ rows, transactions, progress }); try { return await fn(prisma); } catch (e) { ({ rows, transactions, progress } = snapshot); throw e; } };
  prisma.session.findFirst = async ({ where }) => ({ id: 'session', userId: where.userId, tenantId: 'tenant', activeProjectId: 'project', user: { id: where.userId, isActive: true, lastActiveAt: new Date() } });
  prisma.projectMembership.findMany = async ({ where }) => [{ role: where.userId, memberId: null }];
  prisma.onboardingProgress.findUnique = async () => structuredClone(progress);
  prisma.onboardingProgress.update = async ({ data }) => { writes++; return Object.assign(progress, data); };
  prisma.account.findFirst = async ({ where }) => rows.find(row => matches(row, where)) ?? null;
  prisma.account.findMany = async ({ where }) => { scopeQueries.push(where); return rows.filter(row => matches(row, where)); };
  prisma.account.create = async ({ data }) => { writes++; const row = { id: `account-${rows.length}`, ...data }; rows.push(row); return row; };
  prisma.account.updateMany = async ({ where, data }) => { writes++; const selected = rows.filter(row => matches(row, where)); selected.forEach(row => Object.assign(row, data)); return { count: selected.length }; };
  prisma.accountTransaction.create = async ({ data }) => { writes++; const row = { id: `transaction-${transactions.length}`, ...data }; transactions.push(row); return row; };
  prisma.activity.create = async ({ data }) => data;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.auth = { tenantId: 'tenant', projectId: req.header('x-project-id') ?? 'project', userId: 'owner', roles: [req.header('x-role') ?? 'owner'] }; next(); });
  app.use('/accounts', accountsRouter); app.use('/onboarding', onboardingRouter);
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({ error: error.message, fields: error.fields }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); url = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { rows = []; transactions = []; writes = 0; scopeQueries = []; progress = { tenantId: 'tenant', projectId: 'project', status: 'in_progress', organizationStepStatus: 'done', accountantStepStatus: 'skipped', accountsStepStatus: 'pending', shareholdersStepStatus: 'pending', incomeApprovalFlow: 'accountant_only', expenseApprovalFlow: 'accountant_only', completedAt: null }; });
after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
async function request(path, body, role = 'owner', method = 'POST', project = 'project') {
  const token = signAccessToken({ sessionId: 'session', tenantId: 'tenant', userId: role });
  const response = await fetch(url + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-role': role, 'x-project-id': project }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
for (const path of ['/accounts', '/onboarding/accounts']) {
  test(`${path}: each missing or whitespace-only bank field refuses the entire write`, async () => {
    for (const field of ['bank_name', 'account_name', 'account_number', 'branch_name']) {
      for (const value of [undefined, '   ']) {
        const input = { ...bank, [field]: value };
        const res = await request(path, path.startsWith('/onboarding') ? { accounts: [{ name: 'Cash box', type: 'cash' }, input] } : input);
        assert.equal(res.status, 400); assert.ok(res.body.fields[path.startsWith('/onboarding') ? `accounts.1.${field}` : field]);
        assert.equal(writes, 0); assert.equal(rows.length, 0); assert.equal(progress.accountsStepStatus, 'pending');
      }
    }
  });
  test(`${path}: persists bank details, leading zeros, default and opening balance together`, async () => {
    rows.push({ id: 'old', tenantId: 'tenant', projectId: 'project', name: 'Old cash', type: 'cash', isDefault: true, balance: 10 });
    const input = { ...bank, opening_balance: 1200, is_default: true };
    const res = await request(path, path.startsWith('/onboarding') ? { accounts: [input] } : input);
    assert.equal(res.status, 201); const row = rows[1];
    assert.equal(row.name, 'City Bank · Mirpur · 7890'); assert.equal(row.bankName, 'City Bank'); assert.equal(row.accountName, 'Sunrise Foundation'); assert.equal(row.accountNumber, '001234567890'); assert.equal(row.branchName, 'Mirpur');
    assert.equal(row.balance, 1200); assert.equal(row.isDefault, true); assert.equal(rows[0].isDefault, false);
    assert.equal(transactions.length, 1); assert.equal(transactions[0].balanceAfter, 1200); assert.equal(transactions[0].accountId, row.id);
    if (path.startsWith('/onboarding')) assert.equal(progress.accountsStepStatus, 'done');
  });
  test(`${path}: cash requires only a name and ignores stale bank fields`, async () => {
    const input = { ...bank, type: 'cash', name: ' Office cash ' };
    const res = await request(path, path.startsWith('/onboarding') ? { accounts: [input] } : input);
    assert.equal(res.status, 201); assert.equal(rows[0].name, 'Office cash'); assert.equal(rows[0].balance, 0);
    for (const field of ['bankName', 'accountName', 'accountNumber', 'branchName']) assert.equal(rows[0][field], null);
    assert.equal(transactions.length, 0);
  });
}
test('bank holder name can repeat across banks while custom labels remain supported', async () => {
  assert.equal((await request('/accounts', bank)).status, 201);
  assert.equal((await request('/accounts', { ...bank, bank_name: 'BRAC Bank' })).status, 201);
  assert.equal((await request('/accounts', { ...bank, name: ' Reserve funds ', account_number: '002' })).status, 201);
  assert.deepEqual(rows.map(row => row.accountName), ['Sunrise Foundation', 'Sunrise Foundation', 'Sunrise Foundation']);
  assert.equal(rows[2].name, 'Reserve funds');
});
test('invalid balance or non-string account number refuses writes', async () => {
  for (const opening_balance of [-1, 1.5, 2147483648, '100']) assert.equal((await request('/accounts', { ...bank, opening_balance })).status, 400);
  assert.equal((await request('/accounts', { ...bank, account_number: 123 })).status, 400); assert.equal(writes, 0);
});
test('batch rejects duplicate labels and multiple defaults without writes', async () => {
  for (const accounts of [[bank, bank], [{ name:'A cash', type:'cash', is_default:true }, { ...bank, is_default:true }]]) assert.equal((await request('/onboarding/accounts', { accounts })).status, 400);
  assert.equal(writes, 0);
});
test('bank details in list stay scoped and legacy accounts with no details still return', async () => {
  await request('/accounts', bank); rows.push({ id:'legacy', tenantId:'tenant', projectId:'project', name:'Legacy bank', type:'bank', balance:25 });
  rows.push({ id:'foreign', tenantId:'other', projectId:'elsewhere', name:'Private bank', type:'bank', accountNumber:'secret' });
  const res = await request('/accounts', undefined, 'owner', 'GET'); assert.equal(res.status, 200);
  assert.equal(res.body.data.accounts.length, 2); assert.equal(res.body.data.accounts[0].accountNumber, '001234567890'); assert.equal(res.body.data.accounts[1].name, 'Legacy bank');
  assert.deepEqual(scopeQueries.at(-1), { tenantId:'tenant', projectId:'project' });
});
test('unauthorized role and wrong onboarding project cannot write bank details', async () => {
  assert.equal((await request('/accounts', bank, 'approver')).status, 403);
  assert.equal((await request('/onboarding/accounts', { accounts:[bank] }, 'accountant')).status, 403);
  assert.equal((await request('/onboarding/accounts', { accounts:[bank] }, 'owner', 'POST', 'different')).status, 400);
  assert.equal(writes, 0);
});
