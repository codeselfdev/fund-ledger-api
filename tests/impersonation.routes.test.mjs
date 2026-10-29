import { fixtureTransactionClient, installAccountReadFixtures, installAccountRelationFixtures, installSubscriptionReadFixtures } from './helpers/normalized-fixtures.mjs';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const privateImageTestRoot = await mkdtemp(join(tmpdir(), 'fundnesta-support-images-'));
process.env.UPLOAD_STORAGE = 'local';
process.env.UPLOAD_LOCAL_DIR = privateImageTestRoot;
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'isolated-impersonation-jwt-secret-only';
process.env.MASTER_USER_EMAIL = 'master@example.test';
process.env.MASTER_IMPERSONATION_CODE = 'test-only-master-passphrase-at-least-32-bytes';
process.env.MASTER_WEB_ORIGIN = 'https://support.example.test';
const { prisma } = await import('../dist/core/prisma/client.js');
const { masterAdminRouter } = await import('../dist/modules/auth/master-admin.routes.js');
const { impersonationRouter } = await import('../dist/modules/auth/impersonation.routes.js');
const { authRouter } = await import('../dist/modules/auth/auth.routes.js');
const { projectsRouter } = await import('../dist/modules/projects/projects.routes.js');
const { accountsRouter } = await import('../dist/modules/accounts/accounts.routes.js');
const { stockRouter } = await import('../dist/modules/inventory/stock.routes.js');
const { inventoryRouter } = await import('../dist/modules/inventory/inventory.routes.js');
const { whatsappRouter } = await import('../dist/modules/integrations/whatsapp.routes.js');
const { activityRouter } = await import('../dist/modules/activity/activity.routes.js');
const { assistantRouter } = await import('../dist/modules/assistant/assistant.routes.js');
const { assistantContext } = await import('../dist/modules/assistant/assistant.context.js');
const { storeObject } = await import('../dist/core/storage/object-storage.service.js');
const { authenticate } = await import('../dist/core/security/auth.middleware.js');
const { hashToken, signAccessToken, verifyAccessToken } = await import('../dist/core/security/jwt.js');
const { errorHandler } = await import('../dist/core/http/error-handler.js');
let users, sessions, activities, memberships, projects, tenants, mutationCount, memberCreates, server, base, serial = Promise.resolve(), sequence;
const copy = value => structuredClone(value);
function matches(row, where = {}) {
  if (!row) return false;
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(clause => matches(row, clause));
    if (key === 'NOT') return !matches(row, value);
    if (key === 'project') return matches(projects.find(p => p.id === row.projectId), value);
    if (key === 'tenant') return matches(tenants.find(t => t.id === row.tenantId), value);
    if (key === 'memberships') return memberships.some(m => m.userId === row.id && matches(m, value.some));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('path' in value) return row[key]?.[value.path[0]] === value.equals;
      if ('gt' in value && !(row[key] > value.gt)) return false;
      if ('gte' in value && !(row[key] >= value.gte)) return false;
      if ('not' in value && row[key] === value.not) return false;
      if ('equals' in value) return String(row[key]).toLowerCase() === value.equals.toLowerCase();
      if ('contains' in value) return String(row[key]).toLowerCase().includes(value.contains.toLowerCase());
      if ('in' in value) return value.in.includes(row[key]);
      return true;
    }
    if (value instanceof Date) return row[key]?.getTime() === value.getTime();
    return row[key] === value;
  });
}
function userRow(row) {
  return row && copy({ ...row, tenant: tenants.find(t => t.id === row.tenantId), memberships: memberships.filter(m => m.userId === row.id && m.isActive && projects.find(p => p.id === m.projectId)?.isActive).map(m => ({ ...m, project: projects.find(p => p.id === m.projectId) })) });
}
function tokenFor(userId = 'master', options = {}) {
  const user = users.find(u => u.id === userId), id = `s-${++sequence}`;
  const session = { id, tenantId: user.tenantId, userId, activeProjectId: userId === 'master' ? 'master-project' : 'p1',
    verifiedEmail: userId === 'master' ? user.email : null, impersonatorUserId: null, impersonatorSessionId: null,
    impersonationReason: null, impersonationPolicyHash: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, ...options };
  const token = signAccessToken({ sessionId: id, userId, tenantId: user.tenantId }); session.tokenHash = hashToken(token); sessions.push(session); return token;
}
let fixtureSequence = 0, fixtureIp;
function reset() {
  fixtureIp = `192.0.2.${++fixtureSequence}`;
  process.env.MASTER_USER_EMAIL = 'master@example.test'; process.env.MASTER_IMPERSONATION_CODE = 'test-only-master-passphrase-at-least-32-bytes'; delete process.env.MASTER_USER_ID;
  sequence = 0; mutationCount = 0; memberCreates = 0; sessions = []; activities = [];
  tenants = [{ id: 'admin-org', name: 'Platform', slug: 'platform', contact: {} }, { id: 'target-org', name: 'Target organization', slug: 'target', contact: {} }, { id: 'foreign-org', name: 'Another organization', slug: 'foreign', contact: {} }];
  users = [{ id: 'master', tenantId: 'admin-org', name: 'Master', email: 'master@example.test', mobile: 'master-mobile', isActive: true, identityRootId: null, lastActiveAt: new Date() },
    { id: 'target', tenantId: 'target-org', name: 'Target accountant', email: 'target@example.test', mobile: 'private-mobile', isActive: true, identityRootId: 'foreign', lastActiveAt: new Date() },
    { id: 'foreign', tenantId: 'foreign-org', name: 'Other account', email: 'other@example.test', mobile: 'other-mobile', isActive: true, identityRootId: null, lastActiveAt: new Date() }];
  projects = [{ id: 'master-project', tenantId: 'admin-org', name: 'Admin', isActive: true, projectType: 'accounting' }, { id: 'p1', tenantId: 'target-org', name: 'First', isActive: true, projectType: 'accounting' }, { id: 'p2', tenantId: 'target-org', name: 'Second', isActive: true, projectType: 'accounting' }, { id: 'foreign-project', tenantId: 'foreign-org', name: 'Foreign', isActive: true, projectType: 'accounting' }];
  memberships = [{ userId: 'master', tenantId: 'admin-org', projectId: 'master-project', role: 'owner', isActive: true, memberId: null },
    ...['p1', 'p2'].map(projectId => ({ userId: 'target', tenantId: 'target-org', projectId, role: 'accountant', isActive: true, memberId: null })),
    { userId: 'foreign', tenantId: 'foreign-org', projectId: 'foreign-project', role: 'owner', isActive: true, memberId: null }];
}
before(async () => {
  prisma.$queryRaw = async () => [];
  prisma.$transaction = callback => {
    const run = serial.then(async () => { const snapshot = { sessions: copy(sessions), activities: copy(activities) }; try { return await callback(fixtureTransactionClient(prisma)); } catch (error) { sessions = snapshot.sessions; activities = snapshot.activities; throw error; } });
    serial = run.catch(() => {}); return run;
  };
  prisma.session.findFirst = async ({ where, include }) => { const row = sessions.find(s => matches(s, where)); return row ? copy({ ...row, ...(include?.user ? { user: users.find(u => u.id === row.userId) } : {}) }) : null; };
  prisma.session.create = async ({ data }) => { const row = { id: `s-${++sequence}`, verifiedEmail: null, revokedAt: null, createdAt: new Date(), ...data }; sessions.push(row); return copy(row); };
  prisma.session.update = async ({ where, data }) => { const row = sessions.find(s => matches(s, where)); Object.assign(row, data); return copy(row); };
  prisma.session.updateMany = async ({ where, data }) => { const rows = sessions.filter(s => matches(s, where)); rows.forEach(s => Object.assign(s, data)); return { count: rows.length }; };
  prisma.user.findFirst = async ({ where }) => userRow(users.find(u => matches(u, where))) ?? null;
  prisma.user.findUniqueOrThrow = async ({ where }) => { const row = userRow(users.find(u => matches(u, where))); if (!row) throw Error('missing'); return row; };
  prisma.user.findMany = async ({ where, take }) => users.filter(u => matches(u, where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map(u => { const row = userRow(u); return { id: row.id, name: row.name, email: row.email, tenant: { id: row.tenant.id, name: row.tenant.name, slug: row.tenant.slug }, memberships: row.memberships.map(m => ({ role: m.role, project: { id: m.project.id, name: m.project.name } })) }; });
  prisma.user.updateMany = async () => { mutationCount++; return { count: 1 }; };
  prisma.projectMembership.findMany = async ({ where }) => memberships.filter(m => matches(m, where)).map(m => ({ ...copy(m), project: copy(projects.find(p => p.id === m.projectId)) }));
  prisma.projectMembership.findFirst = async ({ where }) => copy(memberships.find(m => matches(m, where)) ?? null);
  prisma.project.findFirst = async ({ where }) => copy(projects.find(p => matches(p, where)) ?? null);
  prisma.member.findMany = async () => [];
  prisma.member.create = async () => { memberCreates++; throw Error('Support must never repair member records'); };
  prisma.onboardingProgress.findUnique = async () => null;
  prisma.activity.create = async ({ data }) => { const row = { ...copy(data), createdAt: new Date() }; activities.push(row); return row; };
  prisma.activity.count = async ({ where }) => activities.filter(a => matches(a, where)).length;
  prisma.internalAudit.create = async ({ data }) => { activities.push(structuredClone(data)); return data; };
  prisma.platformBroadcast.findMany = async () => [];
  prisma.supportTicket.findMany = async () => [];
  installSubscriptionReadFixtures(prisma);
installAccountRelationFixtures(prisma);
const app = express(); app.set('trust proxy', 1); installAccountReadFixtures(prisma);
app.use(express.json()); app.use('/v1/support/admin', masterAdminRouter); app.use('/v1/support/impersonation', impersonationRouter); app.use('/v1/auth', authRouter); app.use('/v1/projects', projectsRouter); app.use('/v1/accounts', authenticate, accountsRouter); app.use('/v1/inventory', authenticate, stockRouter, inventoryRouter); app.use('/v1/assistant', authenticate, assistantRouter); app.use('/v1', authenticate, whatsappRouter, activityRouter);
  app.get('/v1/protected', authenticate, (req, res) => res.json({ ok: true, data: req.auth }));
  app.post('/v1/protected', authenticate, (_req, res) => { mutationCount++; res.json({ ok: true }); });
  app.use(errorHandler); server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(reset); after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); await rm(privateImageTestRoot, { recursive: true, force: true }); });
async function request(path, { token, body, origin = 'https://support.example.test', platform = 'web' } = {}) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-forwarded-for': fixtureIp, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), 'x-client-platform': platform }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const startBody = () => ({ user_id: 'target', project_id: 'p1', code: process.env.MASTER_IMPERSONATION_CODE, reason: 'Investigating the support request' });
async function start(token = tokenFor()) { const response = await request('/v1/support/impersonation/start', { token, body: startBody() }); assert.equal(response.status, 200, JSON.stringify(response.body)); return { parent: token, login: response.body.data }; }

test('disabled configuration, ordinary users and unverified/edited master emails cannot access the directory', async () => {
  const token = tokenFor(); delete process.env.MASTER_IMPERSONATION_CODE; assert.equal((await request('/v1/support/impersonation/users', { token })).status, 404);
  process.env.MASTER_IMPERSONATION_CODE = 'test-only-master-passphrase-at-least-32-bytes';
  assert.equal((await request('/v1/support/impersonation/users', { token: tokenFor('target') })).status, 404);
  sessions[0].verifiedEmail = null; assert.equal((await request('/v1/support/impersonation/users', { token })).status, 404);
  sessions[0].verifiedEmail = 'another@example.test'; assert.equal((await request('/v1/support/impersonation/users', { token })).status, 404);
});
test('master ID pin, recent verified login and exact browser origin are all required', async () => {
  const token = tokenFor(); process.env.MASTER_USER_ID = 'different-master'; assert.equal((await request('/v1/support/impersonation/status', { token })).status, 404); delete process.env.MASTER_USER_ID;
  assert.equal((await request('/v1/support/impersonation/users', { token, platform: 'android' })).status, 403);
  assert.equal((await request('/v1/support/impersonation/users', { token, origin: 'https://evil.example.test' })).status, 403);
  assert.equal((await request('/v1/support/impersonation/users', { token, origin: '' })).status, 403);
  sessions[0].createdAt = new Date(Date.now() - 31 * 60_000); assert.equal((await request('/v1/support/impersonation/status', { token })).status, 403);
});
test('directory search returns bounded account-specific rows without phone numbers or credentials', async () => {
  const response = await request('/v1/support/impersonation/users?search=target', { token: tokenFor() });
  assert.equal(response.status, 200); assert.equal(response.body.data.users.length, 1); assert.equal(response.body.data.users[0].email, 'target@example.test');
  assert.doesNotMatch(JSON.stringify(response.body), /private-mobile|password|tokenHash/);
});
test('correct code issues a separate short-lived session scoped to the selected account and preserves real sessions', async () => {
  const realTarget = tokenFor('target'); const { parent, login } = await start();
  assert.notEqual(login.token, parent); assert.equal(login.user.id, 'target'); assert.equal(login.identity_root_id, 'target'); assert.equal(login.tenant.id, 'target-org');
  assert.deepEqual(login.memberships.map(m => m.project_id).sort(), ['p1', 'p2']); assert.equal(login.impersonation.read_only, true);
  const child = sessions.find(s => s.id === verifyAccessToken(login.token).sessionId); assert.equal(child.impersonatorSessionId, verifyAccessToken(parent).sessionId); assert.equal(child.impersonatorUserId, 'master'); assert.equal(child.verifiedEmail, null); assert.ok(verifyAccessToken(login.token).exp * 1000 <= child.expiresAt.getTime());
  assert.ok(child.expiresAt <= new Date(Date.now() + 15 * 60_000)); assert.ok(child.expiresAt > new Date(Date.now() + 14 * 60_000));
  assert.equal(sessions.find(s => s.tokenHash === hashToken(realTarget)).revokedAt, null);
  assert.ok(activities.some(a => a.action === 'support.impersonation.started' && a.actorUserId === 'master' && a.after.target_user_id === 'target'));
});
test('wrong codes are audited without secrets and a new login cannot reset the account-wide failure limit', async () => {
  const token = tokenFor(); for (let i = 0; i < 5; i++) assert.equal((await request('/v1/support/impersonation/start', { token, body: { ...startBody(), code: 'wrong-secret' } })).status, 403);
  assert.equal((await request('/v1/support/impersonation/start', { token: tokenFor(), body: startBody() })).status, 429);
  assert.equal(sessions.filter(s => s.impersonatorSessionId).length, 0); assert.doesNotMatch(JSON.stringify(activities), /wrong-secret|test-only-master-passphrase/);
});
test('target inactivity, self-impersonation, forged project and extra privilege fields are rejected', async () => {
  const token = tokenFor(); assert.equal((await request('/v1/support/impersonation/start', { token, body: { ...startBody(), user_id: 'master' } })).status, 403);
  assert.equal((await request('/v1/support/impersonation/start', { token, body: { ...startBody(), project_id: 'foreign-project' } })).status, 403);
  assert.equal((await request('/v1/support/impersonation/start', { token, body: { ...startBody(), read_only: false } })).status, 400);
  users.find(u => u.id === 'target').isActive = false; assert.equal((await request('/v1/support/impersonation/start', { token, body: startBody() })).status, 404);
});
test('view-only is enforced on direct API calls and reads never mark the target as active', async () => {
  const { login } = await start(); const response = await request('/v1/protected', { token: login.token }); assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.roles, ['accountant']); assert.equal(response.body.data.impersonation.actorUserId, 'master');
  assert.equal((await request('/v1/protected', { token: login.token, body: { amount: 100 } })).status, 403); assert.equal(mutationCount, 0);
  assert.equal((await request('/v1/protected', { token: login.token, platform: 'ios' })).status, 403);
});
test('missing member links are not repaired during support reads', async () => {
  memberships.filter(m => m.userId === 'target').forEach(m => { m.role = 'member'; m.memberId = null; }); const { login } = await start();
  assert.equal((await request('/v1/protected', { token: login.token })).status, 200); assert.equal(memberCreates, 0); assert.equal(mutationCount, 0);
});
test('parent logout/revocation, secret rotation and expiry invalidate support access immediately', async () => {
  const { parent, login } = await start(); sessions.find(s => s.tokenHash === hashToken(parent)).revokedAt = new Date(); assert.equal((await request('/v1/protected', { token: login.token })).status, 401);
  const second = await start(); process.env.MASTER_IMPERSONATION_CODE += '-rotated'; assert.equal((await request('/v1/protected', { token: second.login.token })).status, 401);
});
test('impersonation cannot nest or mint an ordinary session through account selection or business writes', async () => {
  const { login } = await start(); assert.equal((await request('/v1/support/impersonation/start', { token: login.token, body: startBody() })).status, 403);
  assert.equal((await request('/v1/support/impersonation/users', { token: login.token })).status, 404);
});
test('project switching rotates and revokes the support token without changing its actor or expiry', async () => {
  const { login } = await start(); const switched = await request('/v1/auth/switch-project', { token: login.token, body: { project_id: 'p2' } }); assert.equal(switched.status, 200);
  assert.notEqual(switched.body.data.token, login.token); assert.equal(switched.body.data.active_project_id, 'p2'); assert.equal(switched.body.data.impersonation.expires_at, login.impersonation.expires_at);
  assert.equal((await request('/v1/protected', { token: login.token })).status, 401);
  assert.equal((await request('/v1/protected', { token: switched.body.data.token })).body.data.impersonation.actorUserId, 'master');
  assert.equal((await request('/v1/auth/switch-project', { token: switched.body.data.token, body: { project_id: 'foreign-project' } })).status, 403);
});
test('me response never expands to the target linked identity and stop never returns a master credential', async () => {
  const { parent, login } = await start(); const me = await request('/v1/auth/me', { token: login.token }); assert.equal(me.status, 200); assert.equal(me.body.data.identity_root_id, 'target'); assert.deepEqual(me.body.data.memberships.map(m => m.project_id).sort(), ['p1', 'p2']);
  const stopped = await request('/v1/support/impersonation/stop', { token: login.token, body: {} }); assert.equal(stopped.status, 200); assert.deepEqual(stopped.body.data, { revoked: true });
  assert.equal((await request('/v1/protected', { token: login.token })).status, 401); assert.equal(sessions.find(s => s.tokenHash === hashToken(parent)).revokedAt, null);
});
test('a second support session revokes only the first child and cannot extend the fresh-login window', async () => {
  const token = tokenFor(); sessions[0].createdAt = new Date(Date.now() - 28 * 60_000); const a = await start(token), b = await start(token);
  assert.equal((await request('/v1/protected', { token: a.login.token })).status, 401); assert.equal((await request('/v1/protected', { token: b.login.token })).status, 200);
  assert.ok(new Date(b.login.impersonation.expires_at) <= new Date(Date.now() + 2 * 60_000));
});

test('session expiry and master deactivation reject reads without changing the target session', async () => {
 const first=await start(); sessions.find(s=>s.tokenHash===hashToken(first.login.token)).expiresAt=new Date(Date.now()-1);
 assert.equal((await request('/v1/protected',{token:first.login.token})).status,401);
 const second=await start(); users.find(u=>u.id==='master').isActive=false;
 assert.equal((await request('/v1/protected',{token:second.login.token})).status,401);
});
test('audit failure rolls back issuance and blocks reads before private data is returned', async () => {
 const token=tokenFor(), original=prisma.activity.create;
 try {
  prisma.activity.create=async({data})=>{if(data.action==='support.impersonation.started') {const {ApiError}=await import('../dist/core/http/api-error.js');throw new ApiError(503,'AUDIT_UNAVAILABLE','Audit unavailable');}return original({data});};
  assert.equal((await request('/v1/support/impersonation/start',{token,body:startBody()})).status,503);
  assert.equal(sessions.filter(s=>s.impersonatorSessionId).length,0);
  prisma.activity.create=original;const {login}=await start(token);
  prisma.activity.create=async({data})=>{if(data.action==='support.impersonation.request') {const {ApiError}=await import('../dist/core/http/api-error.js');throw new ApiError(503,'AUDIT_UNAVAILABLE','Audit unavailable');}return original({data});};
  const response=await request('/v1/protected',{token:login.token});assert.equal(response.status,503);assert.equal(response.body.data,undefined);
 } finally {prisma.activity.create=original;}
});
test('the requested mixed-case email alias works when the uppercase example variable is blank', async () => {
 const token=tokenFor();process.env.MASTER_USER_EMAIL='';process.env.Master_user_email=' MASTER@example.test ';
 try {assert.equal((await request('/v1/support/impersonation/status',{token})).status,200);} finally {delete process.env.Master_user_email;}
});

test('the preserved master login revokes the rotated child family without logging out either real account', async () => {
  const realTarget = tokenFor('target');
  const { parent, login } = await start();
  const rotated = await request('/v1/auth/switch-project', { token: login.token, body: { project_id: 'p2' } });
  assert.equal(rotated.status, 200);
  assert.equal((await request('/v1/support/impersonation/stop', { token: parent, body: {} })).status, 200);
  assert.equal((await request('/v1/protected', { token: rotated.body.data.token })).status, 401);
  assert.equal((await request('/v1/protected', { token: parent })).status, 200);
  assert.equal((await request('/v1/protected', { token: realTarget })).status, 200);
});

test('project discovery and logo reads cannot expose the selected user’s linked organizations', async () => {
  const { login } = await start();
  const listed = await request('/v1/projects', { token: login.token });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.map(p => p.project_id).sort(), ['p1', 'p2']);
  assert.equal((await request('/v1/projects/foreign-project/logo', { token: login.token })).status, 403);
  assert.equal((await request('/v1/projects/p1/logo', { token: login.token })).status, 404);
});

test('financial opening-balance reads never create a backfilled transaction', async () => {
  const original = { find: prisma.account.findFirst, list: prisma.accountTransaction.findMany, count: prisma.accountTransaction.count, create: prisma.accountTransaction.create };
  try {
    prisma.account.findFirst = async () => ({ id: 'a', tenantId: 'target-org', projectId: 'p1', name: 'Cash', type: 'cash', balance: 500 });
    prisma.accountTransaction.findMany = async () => [];
    prisma.accountTransaction.count = async () => 0;
    prisma.accountTransaction.create = async () => { mutationCount++; throw Error('Support must never backfill'); };
    const { login } = await start();
    for (const suffix of ['transactions', 'in-out', 'entries']) assert.equal((await request(`/v1/accounts/a/${suffix}`, { token: login.token })).status, 200);
    assert.equal(mutationCount, 0);
  } finally { prisma.account.findFirst = original.find; prisma.accountTransaction.findMany = original.list; prisma.accountTransaction.count = original.count; prisma.accountTransaction.create = original.create; }
});
test('inventory reads cannot initialize missing storage and can inspect an existing store', async () => {
  const original = { find: prisma.inventoryLocation.findFirst, list: prisma.inventoryLocation.findMany, create: prisma.inventoryLocation.create, items: prisma.inventoryItem.findMany, groups: prisma.stockMovement.groupBy };
  let main = null;
  try {
    prisma.inventoryLocation.findFirst = async () => main;
    prisma.inventoryLocation.findMany = async () => main ? [main] : [];
    prisma.inventoryLocation.create = async () => { mutationCount++; throw Error('Support must never initialize inventory'); };
    prisma.inventoryItem.findMany = async () => [];
    prisma.stockMovement.groupBy = async () => [];
    const { login } = await start();
    for (const path of ['/settings', '/locations', '/items']) assert.equal((await request('/v1/inventory' + path, { token: login.token })).status, 403);
    main = { id: 'main', tenantId: 'target-org', projectId: 'p1', name: 'Main store', isDefault: true, isActive: true };
    for (const path of ['/settings', '/locations', '/items']) assert.equal((await request('/v1/inventory' + path, { token: login.token })).status, 200);
    assert.equal(mutationCount, 0);
  } finally { prisma.inventoryLocation.findFirst = original.find; prisma.inventoryLocation.findMany = original.list; prisma.inventoryLocation.create = original.create; prisma.inventoryItem.findMany = original.items; prisma.stockMovement.groupBy = original.groups; }
});
test('WhatsApp setup reads return stored status without reconciling or updating the connection', async () => {
  const original = { tenant: prisma.tenant.findUnique, connection: prisma.whatsAppConnection.findFirst, event: prisma.whatsAppGroupCreationEvent.findUnique };
  try {
    memberships.filter(m => m.userId === 'target').forEach(m => { m.role = 'owner'; });
    prisma.tenant.findUnique = async ({ where }) => tenants.find(t => t.id === where.id);
    prisma.whatsAppConnection.findFirst = async () => ({ managedByFundNesta: true, groupSetupStatus: 'pending', groupCreateRequestId: 'request', groupName: 'Test group' });
    prisma.whatsAppGroupCreationEvent.findUnique = async () => { mutationCount++; throw Error('Support must never reconcile setup'); };
    const { login } = await start();
    const response = await request('/v1/integrations/whatsapp/setup', { token: login.token });
    assert.equal(response.status, 200); assert.equal(response.body.data.group.status, 'pending'); assert.equal(mutationCount, 0);
  } finally { prisma.tenant.findUnique = original.tenant; prisma.whatsAppConnection.findFirst = original.connection; prisma.whatsAppGroupCreationEvent.findUnique = original.event; }
});

test('customer activity feeds exclude private support audit actors and reasons', async () => {
  const original = prisma.activity.findMany;
  try {
    prisma.activity.findMany = async ({ where }) => activities.filter(row => matches(row, where)).map(row => ({ ...row, actor: { name: row.entityType === 'support_impersonation' ? 'Private master name' : 'Accountant' } }));
    activities.push({ tenantId: 'target-org', projectId: 'p1', action: 'expense.created', entityType: 'expense', entityId: 'e', after: {} });
    const { login } = await start();
    const response = await request('/v1/activity', { token: login.token });
    assert.equal(response.status, 200); assert.deepEqual(response.body.data.map(row => row.action), ['expense.created']);
    assert.doesNotMatch(JSON.stringify(response.body), /Private master name|Investigating the support request/);
    assert.ok(activities.some(row => row.action === 'support.impersonation.started'));
  } finally { prisma.activity.findMany = original; }
});

test('private chat images can be viewed during support access while origin, account, project and revocation checks stay enforced', async () => {
  const saved = { tenant: prisma.tenant.findUniqueOrThrow, due: prisma.due.aggregate, account: prisma.account.aggregate, member: prisma.member.count, expense: prisma.expense.groupBy, attachment: prisma.assistantAttachment.findFirst };
  try {
    prisma.tenant.findUniqueOrThrow = async ({ where }) => ({ ...tenants.find(t => t.id === where.id), currency: 'BDT' });
    prisma.due.aggregate = async () => ({ _sum: {} });
    prisma.account.aggregate = async () => ({ _sum: {} });
    prisma.member.count = async () => 0;
    prisma.expense.groupBy = async () => [];
    const context = await assistantContext('target-org', 'p1', 'target');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LZkAAAAASUVORK5CYII=', 'base64');
    const file = { storageKey: 'target-org/assistant/support-image', mimeType: 'image/png' };
    await storeObject({ storageKey: file.storageKey, buffer: image, contentType: file.mimeType });
    prisma.assistantAttachment.findFirst = async ({ where }) => where.id === 'private-receipt' && where.tenantId === 'target-org' && where.reply.userId === 'target' && where.reply.projectId === 'p1' && where.reply.channel === 'ai_chat' && where.reply.OR[0].authorizationHash === context.authorization_hash ? file : null;
    const { parent, login } = await start();
    const headers = { Authorization: `Bearer ${login.token}`, Origin: 'https://support.example.test', 'X-Project-Id': 'p1', 'X-Client-Platform': 'web' };
    const url = base + '/v1/assistant/attachments/private-receipt';
    assert.equal((await fetch(url, { headers: { ...headers, 'X-Client-Platform': '' } })).status, 403);
    const response = await fetch(url, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Content-Type'), 'image/png');
    assert.match(response.headers.get('Cache-Control'), /no-store/); assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
    assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://wrong.example.test' } })).status, 403);
    assert.equal((await fetch(url, { headers: { ...headers, 'X-Project-Id': 'foreign-project' } })).status, 403);
    assert.equal((await fetch(url, { headers: { ...headers, Authorization: `Bearer ${parent}`, 'X-Project-Id': 'master-project' } })).status, 404);
    assert.equal((await request('/v1/protected', { token: login.token, body: { amount: 999 } })).status, 403);
    await request('/v1/support/impersonation/stop', { token: parent, body: {} });
    assert.equal((await fetch(url, { headers })).status, 401);
    assert.equal(mutationCount, 0);
  } finally { prisma.tenant.findUniqueOrThrow = saved.tenant; prisma.due.aggregate = saved.due; prisma.account.aggregate = saved.account; prisma.member.count = saved.member; prisma.expense.groupBy = saved.expense; prisma.assistantAttachment.findFirst = saved.attachment; }
});

async function unlockAdmin(token = tokenFor()) {
  const result = await request('/v1/support/admin/unlock', { token, body: { code: process.env.MASTER_IMPERSONATION_CODE } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { token, ...result.body.data };
}
async function adminRead(access, { path = '/notifications', headers = {}, token = access.token } = {}) {
  const response = await fetch(base + '/v1/support/admin' + path, { headers: {
    'x-forwarded-for': fixtureIp, authorization: `Bearer ${token}`, origin: 'https://support.example.test', 'x-client-platform': 'web',
    'x-master-grant': access.grant, ...headers,
  } });
  return { status: response.status, body: await response.json() };
}
test('master administration requires verified identity and code before returning operational data', async () => {
  assert.equal((await request('/v1/support/admin/status')).status, 401);
  assert.equal((await request('/v1/support/admin/unlock', { token: tokenFor('target'), body: { code: process.env.MASTER_IMPERSONATION_CODE } })).status, 404);
  const token = tokenFor();
  assert.equal((await request('/v1/support/admin/notifications', { token })).status, 403);
  const access = await unlockAdmin(token);
  assert.equal((await adminRead(access)).status, 200);
  assert.ok(new Date(access.expires_at).getTime() <= Date.now() + 15 * 60_000);
  assert.doesNotMatch(JSON.stringify(activities), /test-only-master-passphrase|"grant"/);
});
test('master administration cannot use another login grant, a forged signature or impersonation session', async () => {
  const access = await unlockAdmin();
  assert.equal((await adminRead(access, { token: tokenFor() })).status, 403);
  assert.equal((await adminRead({ ...access, grant: access.grant + 'tampered' })).status, 403);
  const { login } = await start(access.token);
  assert.equal((await adminRead(access, { token: login.token })).status, 404);
  assert.equal((await request('/v1/support/admin/unlock', { token: login.token, body: { code: process.env.MASTER_IMPERSONATION_CODE } })).status, 403);
});
test('master administration enforces origin, platform, fresh login and the exact pinned master ID', async () => {
  const access = await unlockAdmin();
  for (const headers of [{ origin: 'https://untrusted.test' }, { origin: '' }, { 'x-client-platform': 'android' }])
    assert.equal((await adminRead(access, { headers })).status, 403);
  process.env.MASTER_USER_ID = 'other-user';
  assert.equal((await adminRead(access)).status, 404); delete process.env.MASTER_USER_ID;
  sessions.find(row => row.tokenHash === hashToken(access.token)).createdAt = new Date(Date.now() - 31 * 60_000);
  assert.equal((await adminRead(access)).status, 403);
});
test('master administration grants expire and fail immediately on parent revocation or policy rotation', async () => {
  let access = await unlockAdmin();
  const now = Date.now;
  try { Date.now = () => now() + 16 * 60_000; assert.equal((await adminRead(access)).status, 403); }
  finally { Date.now = now; }
  access = await unlockAdmin();
  process.env.MASTER_IMPERSONATION_CODE += '-rotated';
  assert.equal((await adminRead(access)).status, 403);
  access = await unlockAdmin(); sessions.find(row => row.tokenHash === hashToken(access.token)).revokedAt = new Date();
  assert.equal((await adminRead(access)).status, 401);
});
test('administration shares the account-wide failed-code lockout with impersonation', async () => {
  const token = tokenFor();
  for (let i = 0; i < 3; i++) assert.equal((await request('/v1/support/admin/unlock', { token, body: { code: 'wrong-admin-code' } })).status, 403);
  for (let i = 0; i < 2; i++) assert.equal((await request('/v1/support/impersonation/start', { token, body: { ...startBody(), code: 'wrong-impersonation-code' } })).status, 403);
  assert.equal((await request('/v1/support/admin/unlock', { token: tokenFor(), body: { code: process.env.MASTER_IMPERSONATION_CODE } })).status, 429);
  assert.doesNotMatch(JSON.stringify(activities), /wrong-admin-code|wrong-impersonation-code/);
});
test('administration derives its operator from the master session and exposes no cleanup or key-based bypass', async () => {
  const access = await unlockAdmin();
  assert.equal((await adminRead(access, { headers: { 'x-internal-actor': 'forged-operator' } })).status, 200);
  const audit = activities.findLast(row => row.action === 'master_admin.request');
  assert.equal(audit.actor, 'master:master');
  assert.equal(audit.metadata.session_id, verifyAccessToken(access.token).sessionId);
  assert.equal((await adminRead(access, { path: '/tenants/target-org/cleanup' })).status, 404);
  assert.equal((await adminRead({ ...access, grant: '' }, { headers: { 'x-internal-api-key': 'synthetic-internal-key', 'x-api-key': 'synthetic-provisioning-key' } })).status, 403);
  assert.equal((await adminRead(access, { path: '/support/tickets' })).status, 200);
  assert.doesNotMatch(JSON.stringify(activities), /forged-operator/);
});
test('failed administration audit prevents unlock and data disclosure', async () => {
  const access = await unlockAdmin(), original = prisma.internalAudit.create;
  prisma.internalAudit.create = async () => { throw new Error('Synthetic audit unavailable'); };
  try {
    assert.equal((await adminRead(access)).status, 500);
    assert.equal((await request('/v1/support/admin/unlock', { token: access.token, body: { code: process.env.MASTER_IMPERSONATION_CODE } })).status, 500);
  } finally { prisma.internalAudit.create = original; }
});


test('master billing notification links load the exact invoice only after master-code unlock', async () => {
  const access = await unlockAdmin(), original = prisma.tenant.findFirst;
  prisma.tenant.findFirst = async ({ where }) => {
    assert.equal(where.deletionStartedAt, null);
    return where.id === 'target-org' ? { id: 'target-org', name: 'Target organization', slug: 'target', contact: { billing: { invoices: [{ id: 'requested-invoice', status: 'submitted', amount: 5000, currency: 'BDT' }] } } } : null;
  };
  prisma.subscriptionInvoice.findMany=async({where})=>where.tenantId==='target-org'?[{id:'requested-invoice',tenantId:'target-org',status:'submitted',amount:5000,currency:'BDT',instructions:'Pay',issuedAt:new Date(),paymentReference:null,paymentAmount:null,paymentRequestKey:null,receiptId:null,submittedAt:null,approvedAt:null,rejectionReason:null,periodEndsAt:null}]:[];
  prisma.subscriptionPaymentReceipt.findMany=async()=>[];
  try {
    const path = '/billing/target-org/invoices/requested-invoice';
    assert.equal((await adminRead({ ...access, grant: '' }, { path })).status, 403);
    const response = await adminRead(access, { path }); assert.equal(response.status, 200);
    assert.equal(response.body.data.invoice.id, 'requested-invoice'); assert.equal(response.body.data.tenant.id, 'target-org');
    assert.equal((await adminRead(access, { path: '/billing/target-org/invoices/missing' })).status, 404);
    assert.equal((await adminRead(access, { path: '/billing/missing/invoices/requested-invoice' })).status, 404);
  } finally { prisma.tenant.findFirst = original; }
});
