import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'billing-isolated-test';
const { prisma } = await import('../dist/core/prisma/client.js');
const { Prisma } = await import('@prisma/client');
const { registerRoutes } = await import('../dist/routes.js');
const { notFoundHandler } = await import('../dist/core/http/not-found.js');
const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');
const { errorHandler } = await import('../dist/core/http/error-handler.js');
const { processRun } = await import('../dist/modules/billing/billing.service.js');
const { cycleAmount, aging, today } = await import('../dist/modules/billing/billing.policy.js');
const { normalizePortalSettings, portalSettingsSchema } = await import('../dist/core/projects/project-settings.js');
let db, counter, server, base, failAudit, retry, queue = Promise.resolve();
const copy = value => structuredClone(value);
const models = { project: 'projects', customer: 'customers', account: 'accounts', billingPlan: 'plans', billingUnit: 'units', billingAssignment: 'assignments', billingMeterReading: 'readings', billingInvoice: 'invoices', billingPayment: 'payments', billingAllocation: 'allocations', billingAdjustment: 'adjustments', billingRun: 'runs', billingMessage: 'messages', activity: 'activity', accountTransaction: 'transactions', session: 'sessions', projectMembership: 'memberships' };
function reset() {
  counter = 0; failAudit = false; retry = false;
  db = Object.fromEntries(Object.values(models).map(t => [t, []]));
  db.projects = [{ id: 'p', tenantId: 't', projectType: 'billing', name: 'Community', isActive: true, billingSettings: null }, { id: 'fund', tenantId: 't', projectType: 'fund_shares', isActive: true }, { id: 'foreign', tenantId: 'other', projectType: 'billing', isActive: true }];
  db.customers = [{ id: 'c', tenantId: 't', projectId: 'p', name: 'Customer', isActive: true, email: 'customer@example.test', mobile: null, address: null }, { id: 'c2', tenantId: 't', projectId: 'p', name: 'Second', isActive: true, email: null }, { id: 'foreign-c', tenantId: 'other', projectId: 'foreign', name: 'Private', isActive: true }];
  db.accounts = [{ id: 'a', tenantId: 't', projectId: 'p', name: 'Cash', balance: 0 }, { id: 'foreign-a', tenantId: 'other', projectId: 'foreign', balance: 1000 }];
}
function match(row, where = {}) {
  if (!row) return false;
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === 'OR') return v.some(w => match(row, w));
    if (k === 'AND') return v.every(w => match(row, w));
    if (v instanceof Date) return row[k]?.getTime() === v.getTime();
    if (v && typeof v === 'object') {
      if (k === 'project') return match(db.projects.find(p => p.id === row.projectId), v);
      if (k === 'user') return match(row.user ?? { isActive: true }, v);
      if ('in' in v) return v.in.includes(row[k]);
      return Object.entries(v).every(([op, n]) => op === 'gt' ? row[k] > n : op === 'gte' ? row[k] >= n : op === 'lt' ? row[k] < n : op === 'lte' ? row[k] <= n : op === 'not' ? row[k] !== n : false);
    }
    return row[k] === v;
  });
}
function decorate(table, row, include) {
  if (!row) return null;
  const r = copy(row);
  if (include?.plan) r.plan = copy(db.plans.find(p => p.id === row.planId));
  if (include?.unit) r.unit = copy(db.units.find(u => u.id === row.unitId) ?? null);
  if (include?.customer) r.customer = copy(db.customers.find(c => c.id === row.customerId));
  if (include?.tenant) r.tenant = { currency: 'BDT', contact: null };
  if (include?.allocations) r.allocations = db.allocations.filter(a => table === 'invoices' ? a.invoiceId === row.id : a.paymentId === row.id).map(a => ({ ...copy(a), ...(include.allocations.include?.invoice ? { invoice: copy(db.invoices.find(i => i.id === a.invoiceId)) } : {}) }));
  if (include?.adjustments) r.adjustments = db.adjustments.filter(a => a.invoiceId === row.id).map(copy);
  return r;
}
function mutate(row, data) {
  for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v && typeof v === 'object' && 'decrement' in v ? row[k] - v.decrement : copy(v);
  return row;
}
function defaults(table) {
  return table === 'invoices' ? { status: 'issued', paidAmount: 0, creditAmount: 0, debitAmount: 0, lateFeeAmount: 0, lateFeeAppliedAt: null, assignmentId: null, periodStart: null } : table === 'payments' ? { refundedAmount: 0, reference: null } : table === 'allocations' ? { releasedAt: null } : table === 'assignments' ? { status: 'active', endDate: null, unitId: null } : table === 'adjustments' ? { status: 'pending', decidedAt: null, decidedById: null, invoiceId: null, paymentId: null } : table === 'runs' ? { cursor: 0, status: 'queued' } : table === 'messages' ? { status: 'queued', attempts: 0, leaseUntil: null } : table === 'customers' ? { isActive: true, email: null } : {};
}
function mock(table) {
  const findMany = async ({ where = {}, orderBy = [], take = 100000, skip = 0, include } = {}) => {
    const order = Array.isArray(orderBy) ? orderBy : [orderBy];
    const rows = db[table].filter(r => match(r, where));
    rows.sort((a, b) => { for (const o of order) for (const [k, direction] of Object.entries(o)) { const diff = a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0; if (diff) return direction === 'desc' ? -diff : diff; } return 0; });
    return rows.slice(skip, skip + take).map(r => decorate(table, r, include));
  };
  return {
    findMany, findFirst: async args => (await findMany({ ...args, take: 1 }))[0] ?? null,
    findFirstOrThrow: async args => { const row = (await findMany({ ...args, take: 1 }))[0]; assert.ok(row, `${table} missing`); return row; },
    count: async ({ where }) => db[table].filter(r => match(r, where)).length,
    create: async ({ data, include }) => {
      if (table === 'activity' && failAudit) throw new Error('Injected audit failure');
      if (db[table].some(r => data.requestKey && data.requestKey === r.requestKey && data.projectId === r.projectId || table === 'invoices' && data.assignmentId && data.assignmentId === r.assignmentId && data.periodStart.getTime() === r.periodStart.getTime())) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      const row = { id: `${table}-${++counter}`, createdAt: new Date(), updatedAt: new Date(), ...defaults(table) }; mutate(row, data); db[table].push(row); return decorate(table, row, include);
    },
    update: async ({ where, data, include }) => { const row = db[table].find(r => match(r, where)); assert.ok(row); mutate(row, data); return decorate(table, row, include); },
    updateMany: async ({ where, data }) => { const rows = db[table].filter(r => match(r, where)); rows.forEach(row => mutate(row, data)); return { count: rows.length }; },
    upsert: async ({ where, create, update }) => { const nested = Object.values(where)[0]; const row = db[table].find(r => match(r, nested)); return row ? copy(mutate(row, update)) : prisma.billingMessage.create({ data: create }); }
  };
}
before(async () => {
  for (const [model, table] of Object.entries(models)) Object.assign(prisma[model], mock(table));
  prisma.tenant.findUnique = async () => ({ contact: { subscription: { status: 'trial', trial_ends_at: new Date(Date.now() + 86400000).toISOString() } } });
  prisma.$transaction = async fn => {
    const previous = queue; let release; queue = new Promise(r => release = r); await previous;
    const snapshot = copy(db);
    try { if (retry) { retry = false; throw new Prisma.PrismaClientKnownRequestError('serialization', { code: 'P2034', clientVersion: 'test' }); } return await fn(prisma); }
    catch (e) { db = snapshot; throw e; } finally { release(); }
  };
  const app = express(); app.use(express.json({ limit: '2mb' })); registerRoutes(app); app.use(notFoundHandler); app.use(errorHandler);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(reset);
after(async () => { await new Promise(r => server.close(r)); await prisma.$disconnect(); });
function token(role, project, userId) {
  const sessionId = randomUUID(), value = signAccessToken({ sessionId, tenantId: 't', userId });
  db.sessions.push({ id: sessionId, tenantId: 't', userId, tokenHash: hashToken(value), revokedAt: null, expiresAt: new Date(Date.now() + 60000), activeProjectId: project, user: { isActive: true } });
  db.memberships.push({ tenantId: 't', projectId: project, userId, role, isActive: true, memberId: role === 'member' ? 'member' : null }); return value;
}
async function request(path, body, role = 'accountant', method = body ? 'POST' : 'GET', project = 'p', userId = `user-${role}`) {
  const response = await fetch(base + '/v1/billing' + path, { method, headers: { authorization: `Bearer ${token(role, project, userId)}`, 'x-project-id': project, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: response.headers.get('content-type')?.includes('pdf') ? Buffer.from(await response.arrayBuffer()) : await response.json() };
}
const invoiceBody = (extra = {}) => ({ customer_id: 'c', invoice_date: '2026-01-01', due_date: '2026-01-10', lines: [{ description: 'Service charge', quantity: 1, unit_price: 1000 }], request_key: randomUUID(), ...extra });
const paymentBody = (amount = 1000, extra = {}) => ({ customer_id: 'c', account_id: 'a', amount, method: 'bkash', payment_date: '2026-01-05', request_key: randomUUID(), ...extra });
async function newInvoice(extra = {}) { const r = await request('/invoices', invoiceBody(extra)); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; }
async function newPlan(extra = {}) { const r = await request('/plans', { name: 'Service', category: 'apartment_community', mode: 'fixed', amount: 1000, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; }
async function assignment(plan, extra = {}) { const r = await request('/assignments', { customer_id: 'c', plan_id: plan.id, label: 'Flat A-101', start_date: '2026-01-01', ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; }
async function adjustment(kind, target, amount) { const r = await request('/adjustments', { kind, customer_id: 'c', ...target, ...(amount !== undefined ? { amount } : {}), reason: 'Approved billing correction', request_key: randomUUID() }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; }
const approve = row => request(`/adjustments/${row.id}/decision`, { decision: 'approve' }, 'approver');

test('billing configuration exposes category-specific menus and defaults without shareholder shortcuts', async () => {
  const r = await request('/configuration'); assert.equal(r.status, 200); assert.equal(r.body.data.categories.length, 4); assert.ok(r.body.data.menus.some(m => m.key === 'billing_invoices')); assert.equal(r.body.data.menus.find(m => m.key === 'billing_approvals').can_write, false);
  assert.deepEqual(normalizePortalSettings(null, 'billing').member_shortcuts, []); assert.ok(normalizePortalSettings(null, 'billing').accountant_shortcuts.includes('billing_collections')); assert.equal(portalSettingsSchema.safeParse(normalizePortalSettings(null, 'billing')).success, true); assert.ok(normalizePortalSettings(null).member_shortcuts.includes('members'));
});
test('a newly created billing project loads through the application routes with no plans or invoices', async () => {
  db.customers = []; db.accounts = [];
  for (const path of ['/plans', '/units', '/customers']) {
    const response = await request(path, undefined, 'admin');
    assert.equal(response.status, 200, path);
    assert.deepEqual(response.body.data, [], path);
  }
  assert.equal((await request('/configuration', undefined, 'admin')).status, 200);
  const overview = await request('/overview?month=2026-10', undefined, 'admin');
  assert.equal(overview.status, 200);
  for (const key of ['customers', 'total_billed', 'collected', 'outstanding', 'overdue_accounts', 'collection_progress']) assert.equal(overview.body.data[key], 0, key);
  assert.deepEqual(overview.body.data.recent, []);
});
for (const role of ['member', 'auditor', 'approver', 'cashier']) test(`${role} cannot issue billing invoices or configure plans`, async () => {
  assert.equal((await request('/invoices', invoiceBody(), role)).status, 403); assert.equal((await request('/plans', { name: 'Service', category: 'general_business', mode: 'fixed', amount: 100 }, role)).status, 403);
});
test('read access and project type/tenant boundaries are enforced', async () => {
  assert.equal((await request('/overview', undefined, 'auditor')).status, 200); assert.equal((await request('/overview', undefined, 'member')).status, 403);
  assert.equal((await request('/overview', undefined, 'admin', 'GET', 'fund')).status, 403); assert.equal((await request('/overview', undefined, 'admin', 'GET', 'foreign')).status, 403);
  assert.equal((await request('/invoices', invoiceBody({ customer_id: 'foreign-c' }))).status, 404); assert.equal((await request('/invoices/missing')).status, 404);
});
test('one-time invoices calculate server totals and do not change cash', async () => {
  const i = await newInvoice({ discount: 100, tax: 50 }); assert.equal(i.total, 950); assert.equal(i.outstanding, 950); assert.equal(db.accounts[0].balance, 0); assert.equal(db.messages.length, 1);
  assert.equal((await request('/invoices', invoiceBody({ total: 1 }))).status, 400); assert.equal((await request('/invoices', invoiceBody({ due_date: '2025-01-01' }))).status, 400); assert.equal((await request('/invoices', invoiceBody({ invoice_date: '2026-02-30' }))).status, 400);
});
test('invoice request keys compare the complete payload and survive retries', async () => {
  const b = invoiceBody(); retry = true; const r = await request('/invoices', b); assert.equal(r.status, 201); assert.equal((await request('/invoices', b)).body.data.id, r.body.data.id); assert.equal((await request('/invoices', { ...b, tax: 1 })).status, 409); assert.equal(db.invoices.length, 1);
});
test('partial payment and explicit multi-invoice allocation post cash only once', async () => {
  const i = await newInvoice(), j = await newInvoice(); const b = paymentBody(1500, { allocations: [{ invoice_id: i.id, amount: 1000 }, { invoice_id: j.id, amount: 500 }] });
  const r = await request('/payments', b, 'cashier'); assert.equal(r.status, 201); assert.equal((await request('/payments', b, 'cashier')).body.data.id, r.body.data.id); assert.equal(db.accounts[0].balance, 1500); assert.equal(db.transactions.length, 1); assert.equal(db.invoices[1].paidAmount, 500); assert.equal(db.allocations.length, 2); assert.equal(db.messages.filter(m => m.dedupeKey.startsWith('receipt')).length, 1);
});
test('advance is automatically applied to later invoices without recording cash again', async () => {
  const p = await request('/payments', paymentBody(1500)); assert.equal(p.body.data.remainingAmount, 1500); const i = await newInvoice(); assert.equal(i.paidAmount, 1000); assert.equal(db.payments[0].remainingAmount, 500); assert.equal(db.accounts[0].balance, 1500); assert.equal(db.transactions.length, 1);
  const l = (await request('/customers/c/ledger')).body.data; assert.equal(l.closing_balance, -500); assert.equal(l.outstanding - l.advance, -500);
});
test('automatic advance setting can be disabled and explicit application remains idempotent', async () => {
  await request('/configuration', { category: 'isp_subscription', automatic_advance: false }, 'admin', 'PUT'); await request('/payments', paymentBody(1000)); const i = await newInvoice(); assert.equal(i.paidAmount, 0);
  assert.equal((await request('/customers/c/apply-advance', {}, 'accountant')).body.data.applied, 1000); assert.equal((await request('/customers/c/apply-advance', {}, 'accountant')).body.data.applied, 0); assert.equal(db.transactions.length, 1);
});
test('foreign accounts, foreign customer invoices and excessive allocations roll back the collection', async () => {
  const i = await newInvoice({ customer_id: 'c2' }); assert.equal((await request('/payments', paymentBody(100, { allocations: [{ invoice_id: i.id, amount: 100 }] }))).status, 404); assert.equal((await request('/payments', paymentBody(100, { account_id: 'foreign-a' }))).status, 404);
  const j = await newInvoice(); assert.equal((await request('/payments', paymentBody(1100, { allocations: [{ invoice_id: j.id, amount: 1100 }] }))).status, 409); assert.equal(db.accounts[0].balance, 0); assert.equal(db.payments.length, 0);
});
test('duplicate and concurrent collection requests are atomic while overpayments become advances', async () => {
  await newInvoice(); const b = paymentBody(700); const dup = await Promise.all([request('/payments', b), request('/payments', b)]); assert.deepEqual(dup.map(r => r.status), [201, 201]); assert.equal(db.accounts[0].balance, 700);
  await Promise.all([request('/payments', paymentBody(200)), request('/payments', paymentBody(200))]); assert.equal(db.accounts[0].balance, 1100); assert.equal(db.invoices[0].paidAmount, 1000); assert.equal(db.payments.reduce((n, p) => n + p.remainingAmount, 0), 100);
  assert.equal((await request('/payments', { ...b, method: 'cash' })).status, 409);
});
test('an audit failure rolls back cash, invoice allocation, outbox and payment together', async () => {
  await newInvoice(); failAudit = true; const old = console.error; console.error = () => {}; try { assert.equal((await request('/payments', paymentBody())).status, 500); } finally { console.error = old; }
  assert.equal(db.accounts[0].balance, 0); assert.equal(db.payments.length, 0); assert.equal(db.allocations.length, 0); assert.equal(db.invoices[0].paidAmount, 0); assert.equal(db.messages.length, 1);
});
test('recurring monthly and quarterly cycles deduplicate the assignment/period and skip suspended subscriptions', async () => {
  const p = await newPlan({ interval_months: 3 }); const a = await assignment(p);
  assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: '2026-01-01' })).status, 201); assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: '2026-01-01' })).status, 201); assert.equal(db.invoices.length, 1);
  assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: '2026-02-01' })).status, 409); assert.equal((await request(`/assignments/${a.id}`, { status: 'disconnected' }, 'accountant', 'PATCH')).status, 200); assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: '2026-04-01' })).status, 409);
});
test('installments sum exactly to contract value and stop at contract end; one-time plans bill once', async () => {
  const p = await newPlan({ mode: 'installment', amount: 1001, installment_count: 3 }); const a = await assignment(p);
  for (const month of ['01', '02', '03']) assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: `2026-${month}-01` })).status, 201);
  assert.deepEqual(db.invoices.map(i => i.total), [333, 333, 335]); assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: '2026-04-01' })).status, 409);
  const one = await assignment(await newPlan({ name: 'Installation', mode: 'one_time' })); await request(`/assignments/${one.id}/invoice`, { period_start: '2026-01-01' }); assert.equal((await request(`/assignments/${one.id}/invoice`, { period_start: '2026-02-01' })).status, 409);
});
test('rent escalation is applied at anniversaries and assigned contract cycles cannot be changed', async () => {
  const p = await newPlan({ escalation_bps: 500 }); const a = await assignment(p);
  const r = await request(`/assignments/${a.id}/invoice`, { period_start: '2027-01-01' }); assert.equal(r.body.data.total, 1050);
  assert.equal((await request(`/plans/${p.id}`, { name: p.name, category: p.category, mode: 'fixed', amount: 1000, interval_months: 3 }, 'accountant', 'PATCH')).status, 409);
});
test('meter readings enforce chronological continuity and freeze after issuing usage invoices', async () => {
  const a = await assignment(await newPlan({ mode: 'usage', amount: 5 })); assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: '2026-01-01' })).status, 409);
  const b = { assignment_id: a.id, period_start: '2026-01-01', previous: 100, current: 130 }; assert.equal((await request('/meter-readings', b)).status, 201);
  assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: '2026-01-01' })).body.data.total, 150); assert.equal((await request('/meter-readings', { ...b, current: 140 })).status, 409);
  assert.equal((await request('/meter-readings', { ...b, period_start: '2026-02-01', previous: 125, current: 150 })).status, 409);
  assert.equal((await request('/meter-readings', { ...b, period_start: '2026-02-01', previous: 130, current: 130 })).status, 201); assert.equal((await request(`/assignments/${a.id}/invoice`, { period_start: '2026-02-01' })).body.data.total, 0);
});
test('bulk runs snapshot up to 5000 assignments, persist progress and are restart safe', async () => {
  const p = await newPlan(); const a = await assignment(p); const b = await assignment(p, { label: 'Flat B' }); const data = { period_start: '2026-01-01', request_key: randomUUID() };
  const r = await request('/invoice-runs', data); assert.equal(r.status, 202); await processRun(r.body.data.id, 1); assert.equal(db.runs[0].cursor, 1); await processRun(r.body.data.id, 10); assert.equal(db.runs[0].status, 'completed'); assert.equal(db.invoices.length, 2);
  assert.equal((await request('/invoice-runs', data)).body.data.id, r.body.data.id); await processRun(r.body.data.id); assert.equal(db.invoices.length, 2);
  assert.equal((await request('/invoice-runs', { ...data, period_start: '2026-02-01' })).status, 409); assert.equal((await request('/invoice-runs', { ...data, request_key: randomUUID(), assignment_ids: [a.id, 'foreign'] })).status, 404);
  assert.equal((await request('/invoice-runs', { ...data, request_key: randomUUID(), assignment_ids: [a.id, a.id] })).status, 400); assert.ok(b.id);
});
test('bulk validation errors remain visible without failing valid assignments', async () => {
  const a = await assignment(await newPlan({ mode: 'usage' })); const b = await assignment(await newPlan({ name: 'Fixed' })); const r = await request('/invoice-runs', { period_start: '2026-01-01', assignment_ids: [a.id, b.id], request_key: randomUUID() }); await processRun(r.body.data.id, 10);
  assert.equal(db.runs[0].status, 'completed'); assert.ok(db.runs[0].results.some(v => v.error?.includes('meter reading'))); assert.equal(db.invoices.length, 1);
});
test('credit/debit notes, waivers and write-offs require a separate approver and preserve the ledger', async () => {
  const i = await newInvoice(); const r = await adjustment('waiver', { invoice_id: i.id }, 100);
  assert.equal((await request(`/adjustments/${r.id}/decision`, { decision: 'approve' }, 'admin', 'POST', 'p', 'user-accountant')).status, 409);
  assert.equal((await approve(r)).status, 200); assert.equal((await approve(r)).status, 200); assert.equal(db.invoices[0].creditAmount, 100);
  assert.equal((await approve(await adjustment('debit_note', { invoice_id: i.id }, 50))).status, 200); assert.equal((await approve(await adjustment('write_off', { invoice_id: i.id }, 950))).status, 200);
  assert.equal((await request('/customers/c/ledger')).body.data.closing_balance, 0); assert.equal(db.accounts[0].balance, 0);
});
test('excess credits and unauthorized approvals cannot change customer balances', async () => {
  const i = await newInvoice(); const r = await adjustment('credit_note', { invoice_id: i.id }, 1001); assert.equal((await approve(r)).status, 409); assert.equal(db.invoices[0].creditAmount, 0);
  for (const role of ['cashier', 'accountant', 'auditor', 'member']) assert.equal((await request(`/adjustments/${r.id}/decision`, { decision: 'approve' }, role)).status, 403);
});
test('cancellation releases payment credit, and approved refunds debit the original account once', async () => {
  const i = await newInvoice(); const p = (await request('/payments', paymentBody())).body.data; const cancel = await adjustment('cancel', { invoice_id: i.id }); assert.equal((await approve(cancel)).status, 200);
  assert.equal(db.invoices[0].status, 'cancelled'); assert.equal(db.payments[0].remainingAmount, 1000); assert.ok(db.allocations[0].releasedAt); assert.equal(db.accounts[0].balance, 1000);
  const refund = await adjustment('refund', { payment_id: p.id }, 600); assert.equal((await approve(refund)).status, 200); assert.equal((await approve(refund)).status, 200); assert.equal(db.accounts[0].balance, 400); assert.equal(db.payments[0].remainingAmount, 400); assert.equal(db.transactions.length, 2);
  const l = (await request('/customers/c/ledger')).body.data; assert.equal(l.closing_balance, -400); assert.equal(l.outstanding - l.advance, -400);
});
test('refunds cannot consume allocated cash or exceed the account balance', async () => {
  const i = await newInvoice(); const p = (await request('/payments', paymentBody())).body.data; assert.equal((await approve(await adjustment('refund', { payment_id: p.id }, 100))).status, 409);
  await approve(await adjustment('cancel', { invoice_id: i.id })); db.accounts[0].balance = 50; assert.equal((await approve(await adjustment('refund', { payment_id: p.id }, 100))).status, 409); assert.equal(db.payments[0].remainingAmount, 1000);
});
test('late fees use grace periods, unpaid balances and invoice policy snapshots exactly once', async () => {
  const p = await newPlan({ due_days: 1, grace_days: 2, late_fee_type: 'percentage', late_fee_value: 1000 }); const a = await assignment(p); await request(`/assignments/${a.id}/invoice`, { period_start: '2026-01-01' }); await request('/payments', paymentBody(400));
  assert.equal((await request('/late-fees/apply', { as_of: '2026-01-04' })).body.data.applied, 0); assert.equal((await request('/late-fees/apply', { as_of: '2026-01-05' })).body.data.amount, 60); assert.equal((await request('/late-fees/apply', { as_of: '2026-01-06' })).body.data.applied, 0);
  assert.equal((await request('/customers/c/ledger')).body.data.closing_balance, 660); assert.equal(db.accounts[0].balance, 400);
});
test('carry-forward dues are reported without being counted as new invoices/revenue', async () => {
  await newInvoice(); await newInvoice({ invoice_date: '2026-02-01', due_date: '2026-02-10' }); await request('/payments', paymentBody(500));
  const r = (await request('/overview?month=2026-02')).body.data; assert.equal(r.total_billed, 1000); assert.equal(r.carry_forward, 500); assert.equal(r.outstanding, 1500); assert.equal(r.overdue_accounts, 1); assert.equal(r.collected, 0);
  const l = (await request('/customers/c/ledger?from=2026-02-01')).body.data; assert.equal(l.opening_balance, 500); assert.equal(l.closing_balance, 1500); assert.equal((await request('/reports?from=2026-02-01&to=2026-01-01')).status, 400);
});
test('due/overdue reminders are deduplicated by invoice and date; receipt and statements are printable PDFs', async () => {
  await newInvoice(); await request('/reminders', { as_of: '2026-01-10' }); await request('/reminders', { as_of: '2026-01-10' }); assert.equal(db.messages.filter(m => m.dedupeKey.startsWith('reminder')).length, 1);
  const p = (await request('/payments', paymentBody(100))).body.data; const receipt = await request(`/payments/${p.id}/receipt.pdf`); assert.equal(receipt.status, 200); assert.equal(receipt.body.subarray(0, 4).toString(), '%PDF');
  const statement = await request('/customers/c/statement.pdf'); assert.equal(statement.status, 200); assert.equal(statement.body.subarray(0, 4).toString(), '%PDF');
});
test('numeric limits, future payment dates, units and customer assignments are validated', async () => {
  db.accounts[0].balance = 2147483640; assert.equal((await request('/payments', paymentBody(10))).status, 400); assert.equal((await request('/payments', paymentBody(1, { payment_date: '2099-01-01' }))).status, 400);
  assert.equal((await request('/plans', { name: 'Small', category: 'general_business', mode: 'installment', amount: 1, installment_count: 2 })).status, 400);
  assert.equal((await request('/meter-readings', { assignment_id: 'none', period_start: '2026-01-15', previous: 1, current: 2 })).status, 400);
  const p = await newPlan(); assert.equal((await request('/assignments', { customer_id: 'c', plan_id: p.id, unit_id: 'foreign', label: 'Private', start_date: '2026-01-01' })).status, 404);
  const u = await request('/units', { name: 'Shop 1', kind: 'shop' }); assert.equal(u.status, 201);
  assert.equal((await request('/assignments', { customer_id: 'foreign-c', plan_id: p.id, label: 'Invalid', start_date: '2026-01-01' })).status, 404);
});

test('bulk contract accepts 5000 assignments and refuses selecting 5001', async () => {
  const p = await newPlan();
  db.assignments = Array.from({ length: 5000 }, (_, n) => ({ id: `batch-${n}`, tenantId: 't', projectId: 'p', customerId: 'c', planId: p.id, unitId: null, label: `Unit ${n}`, status: 'active', startDate: new Date('2026-01-01'), endDate: null }));
  const r = await request('/invoice-runs', { period_start: '2026-01-01', request_key: randomUUID() }); assert.equal(r.status, 202); assert.equal(r.body.data.assignmentIds.length, 5000);
  db.assignments.push({ ...db.assignments[0], id: 'extra' }); assert.equal((await request('/invoice-runs', { period_start: '2026-01-01', request_key: randomUUID() })).status, 400);
});
