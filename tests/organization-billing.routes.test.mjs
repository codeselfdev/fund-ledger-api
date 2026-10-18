import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import express from 'express';
import { mkdir, writeFile, rm } from 'node:fs/promises';
const assetRoot = `/tmp/fundledger-logo-test-${process.pid}`;
process.env.UPLOAD_STORAGE = 'local';
process.env.UPLOAD_LOCAL_DIR = assetRoot;
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'org-billing-isolated-test-secret';
process.env.PROVISIONING_API_KEYS = 'test-platform-key';
const { prisma } = await import('../dist/core/prisma/client.js');
const { authRouter } = await import('../dist/modules/auth/auth.routes.js');
const { projectsRouter } = await import('../dist/modules/projects/projects.routes.js');
const { subscriptionRouter } = await import('../dist/modules/subscription/subscription.routes.js');
const { platformBillingRouter } = await import('../dist/modules/subscription/platform-billing.routes.js');
const { tenantsRouter } = await import('../dist/modules/tenants/tenants.routes.js');
const { authenticate, requireProject, requireRoles } = await import('../dist/core/security/auth.middleware.js');
const { signAccessToken, hashToken, verifyAccessToken } = await import('../dist/core/security/jwt.js');
const { createThreeMonthTrial, createTrialSubscription, evaluateSubscription, renewTenantSubscription } = await import('../dist/core/subscription/subscription.service.js');
const { issueLoginSession, findActiveUsersByEmail } = await import('../dist/modules/auth/auth.service.js');
let users, tenants, projects, memberships, sessions, members, accounts, progress, audits, nextId, server, base;
const copy = value => structuredClone(value);
function matches(row, where = {}) {
  if (!row) return false;
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(item => matches(row, item));
    if (key === 'project') return matches(projects.find(project => project.id === row.projectId), value);
    if (key === 'tenant') return matches(tenants.find(tenant => tenant.id === row.tenantId), value);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('gt' in value) return row[key] > value.gt;
      if ('equals' in value) return String(row[key]).toLowerCase() === value.equals.toLowerCase();
      if ('endsWith' in value) return String(row[key]).endsWith(value.endsWith);
      return matches(row[key], value);
    }
    if (value instanceof Date) return row[key]?.getTime() === value.getTime();
    return row[key] === value;
  });
}
function userRow(row) {
  return row && copy({ ...row, tenant: tenants.find(tenant => tenant.id === row.tenantId), memberships: memberships.filter(item => item.userId === row.id && item.isActive && projects.find(p => p.id === item.projectId)?.isActive).map(item => ({ ...item, project: projects.find(p => p.id === item.projectId) })) });
}
function reset(role = 'member') {
  nextId = 0; sessions = []; members = []; accounts = []; progress = []; audits = [];
  users = [{ id: 'original-user', tenantId: 'original-org', identityRootId: null, name: 'Member', mobile: '+8801711000001', email: 'member@example.test', isActive: true, deviceId: null }];
  tenants = [{ id: 'original-org', slug: 'original', name: 'Original', plan: 'free', contact: { subscription: createThreeMonthTrial() }, updatedAt: new Date(1) }];
  projects = [{ id: 'original-project', tenantId: 'original-org', name: 'Original', projectType: 'fund_shares', totalShares: 10, portalSettings: null, logoFileId: null, isActive: true }];
  memberships = [{ id: 'original-membership', tenantId: 'original-org', projectId: 'original-project', userId: 'original-user', role, memberId: role === 'member' ? 'original-member' : null, isActive: true }];
}
function tokenFor(userId = 'original-user', projectId = 'original-project') {
  const user = users.find(row => row.id === userId), id = `session-${++nextId}`;
  const token = signAccessToken({ sessionId: id, userId, tenantId: user.tenantId });
  sessions.push({ id, userId, tenantId: user.tenantId, activeProjectId: projectId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60000), revokedAt: null });
  return token;
}
before(async () => {
  await mkdir(assetRoot, { recursive: true });
  await writeFile(`${assetRoot}/test-logo.png`, Buffer.from([137, 80, 78, 71]));
  prisma.upload.findFirst = async ({ where }) => where.id === 'owned-logo' && where.tenantId === projects.find(p => p.logoFileId === 'owned-logo')?.tenantId && where.projectId === projects.find(p => p.logoFileId === 'owned-logo')?.id && where.purpose === 'project_logo' ? { id: 'owned-logo', storageKey: 'test-logo.png', mimeType: 'image/png' } : null;
  const proofRows = [];
  prisma.subscriptionPaymentReceipt.create = async ({data}) => {proofRows.push(data);return data;};
  prisma.subscriptionPaymentReceipt.findFirst = async ({where}) => proofRows.find(row=>Object.entries(where).every(([k,v])=>row[k]===v))??null;
  prisma.platformAlert.upsert = async ({create}) => create;
  prisma.$queryRaw = async () => [];
  prisma.$transaction = async fn => fn(prisma);
  prisma.user.findUniqueOrThrow = async ({ where }) => { const row = users.find(row => matches(row, where)); if (!row) throw new Error('User not found'); return userRow(row); };
  prisma.user.findMany = async ({ where }) => users.filter(row => matches(row, where)).map(userRow);
  prisma.user.update = async ({where,data}) => { const row=users.find(user=>user.id===where.id); Object.assign(row,data); return copy(row); };
  prisma.user.create = async ({ data }) => { const row = { id: `user-${++nextId}`, identityRootId: null, isActive: true, deviceId: null, ...data }; users.push(row); return copy(row); };
  prisma.tenant.findUnique = async ({ where }) => copy(tenants.find(row => matches(row, where)) ?? null);
  prisma.tenant.findUniqueOrThrow = async ({ where }) => { const row = tenants.find(row => matches(row, where)); if (!row) throw new Error('Tenant not found'); return copy(row); };
  prisma.tenant.create = async ({ data }) => { const row = { id: `org-${++nextId}`, updatedAt: new Date(1), ...data }; tenants.push(row); return copy(row); };
  prisma.tenant.updateMany = async ({ where, data }) => { const row = tenants.find(row => matches(row, where)); if (!row) return { count: 0 }; Object.assign(row, copy(data), { updatedAt: new Date(row.updatedAt.getTime() + 1) }); return { count: 1 }; };
  prisma.tenant.update = async ({ where, data }) => { const row = tenants.find(row => matches(row, where)); Object.assign(row, data); return copy(row); };
  prisma.projectMembership.findMany = async ({ where }) => memberships.filter(row => matches(row, where)).map(row => copy({ ...row, project: projects.find(p => p.id === row.projectId) }));
  prisma.projectMembership.findFirst = async ({ where }) => copy(memberships.find(row => matches(row, where)) ?? null);
  prisma.projectMembership.updateMany = async ({ where, data }) => { const rows = memberships.filter(row => matches(row, where)); rows.forEach(row => Object.assign(row, data)); return { count: rows.length }; };
  prisma.projectMembership.create = async ({ data }) => { const row = { id: `role-${++nextId}`, memberId: null, isActive: true, ...data }; memberships.push(row); return copy(row); };
  prisma.projectMembership.upsert = async ({ where, create, update }) => { const row = memberships.find(row => matches(row, where.projectId_userId_role)); return row ? Object.assign(row, update) : prisma.projectMembership.create({ data: create }); };
  prisma.project.create = async ({ data }) => { const row = { id: `project-${++nextId}`, isActive: true, portalSettings: null, logoFileId: null, ...data }; projects.push(row); return copy(row); };
  prisma.project.findFirst = async ({ where }) => copy(projects.find(row => matches(row, where)) ?? null);
  prisma.project.update = async ({ where, data }) => { const row = projects.find(row => matches(row, where)); Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))); return copy(row); };
  prisma.member.findMany = async ({ where }) => members.filter(row => matches(row, where)).map(copy);
  prisma.member.aggregate = async () => ({ _sum: { shares: 0 } });
  prisma.member.findFirst = async () => null;
  prisma.member.create = async ({ data }) => { const row = { id: `member-${++nextId}`, ...data }; members.push(row); return copy(row); };
  prisma.account.create = async ({ data }) => { const row = { id: `account-${++nextId}`, ...data }; accounts.push(row); return copy(row); };
  prisma.onboardingProgress.create = async ({ data }) => { progress.push(data); return copy(data); };
  prisma.onboardingProgress.findUnique = async ({ where }) => copy(progress.find(row => matches(row, where)) ?? null);
  prisma.session.findFirst = async ({ where }) => { const row = sessions.find(row => matches(row, where)); return row ? copy({ ...row, user: { ...users.find(user => user.id === row.userId), lastActiveAt: new Date() } }) : null; };
  prisma.session.create = async ({ data }) => { const row = { id: `session-${++nextId}`, revokedAt: null, ...data }; sessions.push(row); return copy(row); };
  prisma.session.update = async ({ where, data }) => { const row = sessions.find(row => matches(row, where)); Object.assign(row, data); return copy(row); };
  prisma.session.updateMany = async ({ where, data }) => { const rows = sessions.filter(row => matches(row, where)); rows.forEach(row => Object.assign(row, data)); return { count: rows.length }; };
  prisma.activity.create = async ({ data }) => { audits.push(data); return data; };
  const app = express(); app.use(express.json());
  app.use('/auth', authRouter); app.use('/projects', projectsRouter); app.use('/tenants', tenantsRouter); app.use('/platform/billing', platformBillingRouter);
  app.use('/subscription', authenticate, subscriptionRouter);
  app.get('/manage', authenticate, requireProject, requireRoles('admin'), (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => reset()); after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); await rm(assetRoot, { recursive: true, force: true }); });
async function request(path, { token, body, method = body === undefined ? 'GET' : 'POST', projectId, platformKey } = {}) {
  let form;
  if (/\/subscription\/invoices\/[^/]+\/payment$/.test(path) && body) { form = new FormData();form.append('payment_reference',body.payment_reference);form.append('payment_amount','2500');form.append('request_key',randomUUID());form.append('receipt',new Blob(['%PDF-1.4 synthetic receipt'],{type:'application/pdf'}),'receipt.pdf'); }
  const res = await fetch(base + path, { method, headers: { ...(!form ? {'content-type': 'application/json'} : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(projectId ? { 'x-project-id': projectId } : {}), ...(platformKey ? { 'x-api-key': platformKey } : {}) }, ...(body === undefined ? {} : { body: form ?? JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
}
const create = token => request('/projects/owned-organization', { token, body: { organization_name: 'Owned business', name: 'Owned fund', total_shares: 10, tenant_id: 'spoofed', role: 'owner', identity_root_id: 'someone-else' } });
async function owned() { const originalToken = tokenFor(); const created = await create(originalToken); assert.equal(created.status, 201); const id = created.body.data.project_id; const switched = await request('/auth/switch-project', { token: originalToken, body: { project_id: id } }); assert.equal(switched.status, 200); return { originalToken, id, tenantId: created.body.data.tenant_id, token: switched.body.data.token }; }
for (const role of ['member', 'accountant', 'approver', 'auditor', 'cashier', 'admin', 'owner']) test(`${role} creates an independently billed organization without elevating original access`, async () => {
  reset(role); const token = tokenFor(); const result = await create(token); assert.equal(result.status, 201);
  const created = result.body.data; assert.notEqual(created.tenant_id, 'original-org'); assert.equal(created.role, 'owner');
  assert.equal(memberships[0].role, role); assert.equal(members.length, 0); assert.equal(users.at(-1).identityRootId, 'original-user');
  assert.equal(users[0].tenantId, 'original-org'); assert.equal(tenants.at(-1).contact.subscription.status, 'trial');
  assert.equal(accounts.at(-1).tenantId, created.tenant_id); assert.equal(progress.at(-1).accountantStepStatus, 'skipped');
  assert.equal(evaluateSubscription(tenants.at(-1).contact).has_access, true);
});
test('expired or revoked original project access does not prevent account-level organization creation', async () => {
  memberships[0].isActive = false; tenants[0].contact = { subscription: createTrialSubscription(0, new Date('2020-01-01')) };
  const result = await create(tokenFor()); assert.equal(result.status, 201);
});
test('optional member linkage belongs only to the new organization', async () => {
  const token = tokenFor(); const result = await request('/projects/owned-organization', { token, body: { organization_name: 'Own org', name: 'Own fund', total_shares: 10, owner_is_member: true } });
  assert.equal(result.status, 201); assert.equal(members.length, 1); assert.equal(members[0].tenantId, result.body.data.tenant_id); assert.equal(members[0].shares, 1); assert.deepEqual(result.body.data.roles, ['owner', 'member']);
});
test('switching rotates to a scoped token and switching back restores member access', async () => {
  const own = await owned(); assert.equal(verifyAccessToken(own.token).tenantId, own.tenantId);
  assert.equal((await request('/manage', { token: own.token, projectId: own.id })).status, 200);
  assert.equal((await request('/manage', { token: own.token, projectId: 'original-project' })).status, 403);
  assert.equal((await request('/manage', { token: own.originalToken, projectId: own.id })).status, 403);
  const back = await request('/auth/switch-project', { token: own.token, body: { project_id: 'original-project' } }); assert.equal(back.status, 200);
  assert.equal(verifyAccessToken(back.body.data.token).tenantId, 'original-org');
  const me = await request('/auth/me', { token: back.body.data.token, projectId: 'original-project' }); assert.equal(me.status, 200); assert.deepEqual(me.body.data.roles, ['member']); assert.equal(me.body.data.member_id, 'original-member'); assert.equal(me.body.data.memberships.length, 2);
});
test('project discovery includes only explicitly linked, active accessible projects', async () => {
  const own = await owned(); users.push({ ...users[0], id: 'unrelated', identityRootId: null }); projects.push({ ...projects[0], id: 'foreign-project' }); memberships.push({ ...memberships[0], userId: 'unrelated', projectId: 'foreign-project' });
  const result = await request('/projects', { token: own.originalToken }); assert.equal(result.status, 200); assert.deepEqual(result.body.data.map(row => row.project_id).sort(), ['original-project', own.id].sort());
  assert.equal((await request('/auth/switch-project', { token: own.token, body: { project_id: 'foreign-project' } })).status, 403);
  memberships.find(row => row.projectId === own.id).isActive = false;
  assert.equal((await request('/auth/switch-project', { token: own.originalToken, body: { project_id: own.id } })).status, 403);
});
test('new owner cannot edit the original project or its organization', async () => {
  const own = await owned(); assert.equal((await request('/projects/original-project', { token: own.token, projectId: own.id, method: 'PATCH', body: { name: 'Escalated' } })).status, 403);
  assert.equal((await request('/tenants/current', { token: own.originalToken, projectId: 'original-project', method: 'PATCH', body: { name: 'Escalated' } })).status, 403);
});
test('repeated creation from an owned account retains the same explicit identity root', async () => {
  const own = await owned(); const second = await create(own.token); assert.equal(second.status, 201); assert.equal(users.at(-1).identityRootId, 'original-user'); assert.notEqual(second.body.data.tenant_id, own.tenantId);
});
test('linked login deduplicates identity without merging unrelated accounts sharing contact details', async () => {
  const own = await owned(); let matches = await findActiveUsersByEmail('member@example.test'); assert.equal(matches.length, 1);
  const login = await issueLoginSession(userRow(users[0]), own.id); assert.equal(login.tenant.id, own.tenantId); assert.equal(login.identity_root_id, 'original-user'); assert.equal(login.memberships.length, 2);
  users.push({ ...users[0], id: 'unrelated', identityRootId: null }); matches = await findActiveUsersByEmail('member@example.test'); assert.equal(matches.length, 2);
});
test('trial uses three calendar months, clamps month ends, and never changes existing trials', () => {
  assert.equal(createThreeMonthTrial(new Date('2026-01-31T12:00:00Z')).trial_ends_at, '2026-04-30T12:00:00.000Z');
  assert.equal(createThreeMonthTrial(new Date('2026-10-11T10:00:00Z')).trial_ends_at, '2027-01-11T10:00:00.000Z');
  const contact = { subscription: createThreeMonthTrial(new Date('2026-01-31T12:00:00Z')) };
  assert.equal(evaluateSubscription(contact, new Date('2026-05-01')).has_access, false);
  assert.equal(renewTenantSubscription({ subscription: { renewal_term_years: 4 } }, new Date('2028-02-29T12:00:00Z')).subscription.current_period_end_at, '2029-02-28T12:00:00.000Z');
});
test('customer roles cannot renew, reset trials, or spoof subscription through contact edits', async () => {
  const own = await owned(); const before = copy(tenants.at(-1).contact);
  for (const path of ['/subscription/renew', '/subscription/trial']) assert.equal((await request(path, { token: own.token, projectId: own.id, body: { trial_days: 365 } })).status, 403);
  assert.equal((await request('/tenants/current', { token: own.token, projectId: own.id, method: 'PATCH', body: { contact: { subscription: { status: 'active' } } } })).status, 400);
  assert.deepEqual(tenants.at(-1).contact, before);
});
async function invoiceFor(own) {
  const issued = await request(`/platform/billing/${own.tenantId}/invoices`, { platformKey: 'test-platform-key', body: { amount: 2500, instructions: 'Pay manually; submit transaction reference.' } }); assert.equal(issued.status, 201); return issued.body.data;
}
test('only the billing service can issue bills and approve paid renewals', async () => {
  const own = await owned(); assert.equal((await request(`/platform/billing/${own.tenantId}/invoices`, { token: own.token, body: { amount: 2500, instructions: 'Pay' } })).status, 401);
  const invoice = await invoiceFor(own); assert.equal((await request(`/platform/billing/${own.tenantId}/invoices/${invoice.id}/review`, { token: own.token, body: { decision: 'approve' } })).status, 401);
  assert.equal((await request('/subscription/invoices', { token: own.originalToken, projectId: 'original-project' })).status, 403);
});
test('expired access resumes for one year only after submitted manual payment is approved', async () => {
  const own = await owned(); const tenant = tenants.find(row => row.id === own.tenantId); tenant.contact.subscription = createTrialSubscription(0, new Date('2020-01-01'));
  const invoice = await invoiceFor(own); assert.equal(evaluateSubscription(tenant.contact).has_access, false);
  const submit = await request(`/subscription/invoices/${invoice.id}/payment`, { token: own.token, projectId: own.id, body: { payment_reference: 'TX-123' } }); assert.equal(submit.status, 200); assert.equal(evaluateSubscription(tenant.contact).has_access, false);
  const approved = await request(`/platform/billing/${own.tenantId}/invoices/${invoice.id}/review`, { platformKey: 'test-platform-key', body: { decision: 'approve' } }); assert.equal(approved.status, 200); assert.equal(evaluateSubscription(tenant.contact).has_access, true);
  const end = tenant.contact.subscription.current_period_end_at; assert.equal(new Date(end).getUTCFullYear(), new Date().getUTCFullYear() + 1);
  const again = await request(`/platform/billing/${own.tenantId}/invoices/${invoice.id}/review`, { platformKey: 'test-platform-key', body: { decision: 'approve' } }); assert.equal(again.status, 200); assert.equal(tenant.contact.subscription.current_period_end_at, end);
});
test('rejected payments remain blocked and can be resubmitted without issuing another invoice', async () => {
  const own = await owned(); const tenant = tenants.find(row => row.id === own.tenantId); tenant.contact.subscription = createTrialSubscription(0, new Date('2020-01-01')); const invoice = await invoiceFor(own);
  await request(`/subscription/invoices/${invoice.id}/payment`, { token: own.token, projectId: own.id, body: { payment_reference: 'TX-bad' } });
  const rejected = await request(`/platform/billing/${own.tenantId}/invoices/${invoice.id}/review`, { platformKey: 'test-platform-key', body: { decision: 'reject', reason: 'Payment not found' } }); assert.equal(rejected.status, 200); assert.equal(evaluateSubscription(tenant.contact).has_access, false);
  assert.equal((await request(`/subscription/invoices/${invoice.id}/payment`, { token: own.token, projectId: own.id, body: { payment_reference: 'TX-good' } })).status, 200);
});
test('a payment from another organization cannot be submitted against this invoice', async () => {
  const own = await owned(); reset('owner'); // independent organization has no original invoice.
  assert.equal((await request('/subscription/invoices/foreign-invoice/payment', { token: tokenFor(), projectId: 'original-project', body: { payment_reference: 'TX-123' } })).status, 404);
});

test('concurrent approval requests cannot grant two renewal years', async () => {
  const own = await owned(); const tenant = tenants.find(row => row.id === own.tenantId); tenant.contact.subscription = createTrialSubscription(0, new Date('2020-01-01'));
  const invoice = await invoiceFor(own);
  await request(`/subscription/invoices/${invoice.id}/payment`, { token: own.token, projectId: own.id, body: { payment_reference: 'TX-concurrent' } });
  const approve = () => request(`/platform/billing/${own.tenantId}/invoices/${invoice.id}/review`, { platformKey: 'test-platform-key', body: { decision: 'approve' } });
  const replies = await Promise.all([approve(), approve()]);
  assert.ok(replies.some(reply => reply.status === 200)); assert.ok(replies.every(reply => [200, 409].includes(reply.status)));
  assert.equal(new Date(tenant.contact.subscription.current_period_end_at).getUTCFullYear(), new Date().getUTCFullYear() + 1);
});


test('only explicitly linked project access can read the current project logo across organizations', async () => {
  const own = await owned(); projects.find(p => p.id === own.id).logoFileId = 'owned-logo';
  const response = await fetch(`${base}/projects/${own.id}/logo`, { headers: { authorization: `Bearer ${own.originalToken}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal((await response.arrayBuffer()).byteLength, 4);
  memberships.find(row => row.projectId === own.id).isActive = false;
  assert.equal((await request(`/projects/${own.id}/logo`, { token: own.originalToken })).status, 403);
});


test('general tenant metadata does not expose manual billing payment references', async () => {
  const own = await owned(); const invoice = await invoiceFor(own);
  await request(`/subscription/invoices/${invoice.id}/payment`, { token: own.token, projectId: own.id, body: { payment_reference: 'PRIVATE-TX-123' } });
  const metadata = await request('/tenants/current', { token: own.token, projectId: own.id });
  assert.equal(metadata.status, 200); assert.equal(metadata.body.data.contact.billing, undefined);
  const bills = await request('/subscription/invoices', { token: own.token, projectId: own.id });
  assert.equal(bills.status, 200); assert.equal(bills.body.data[0].payment_reference, 'PRIVATE-TX-123');
});


test('login opens the remaining owned organization when original project access has been removed', async () => {
  const own = await owned(); memberships[0].isActive = false;
  const login = await issueLoginSession(userRow(users[0]));
  assert.equal(login.active_project_id, own.id); assert.equal(login.tenant.id, own.tenantId);
  assert.equal(verifyAccessToken(login.token).tenantId, own.tenantId);
  assert.deepEqual(login.memberships.map(row => row.role), ['owner']);
});
