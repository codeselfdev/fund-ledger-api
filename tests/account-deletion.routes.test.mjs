import { normalizedAccountRelations } from './helpers/normalized-fixtures.mjs';
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import express from 'express';

process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'account-deletion-unit-test-secret';
const { prisma } = await import('../dist/core/prisma/client.js');
const { accountDeletionRouter } = await import('../dist/modules/auth/account-deletion.routes.js');
const { authenticate } = await import('../dist/core/security/auth.middleware.js');
const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');

let server, base, requests, sessions, membershipReads, failWrite;
function reset() {
  requests = new Map(); sessions = new Map(); membershipReads = 0; failWrite = false;
}
function tokenFor(userId = 'user-a', tenantId = 'tenant-a') {
  const sessionId = `session-${userId}`;
  const token = signAccessToken({ userId, tenantId, sessionId });
  sessions.set(sessionId, normalizedAccountRelations({ id: sessionId, userId, tenantId, tokenHash: hashToken(token),
    revokedAt: null, expiresAt: new Date(Date.now() + 60000), activeProjectId: 'removed-project', user: { isActive: true, lastActiveAt: new Date() } }));
  return token;
}
before(async () => {
  reset();
  prisma.session.findFirst = async ({ where }) => {
    const row = sessions.get(where.id);
    return row && row.userId === where.userId && row.tenantId === where.tenantId && row.tokenHash === where.tokenHash
      && row.revokedAt === null && row.expiresAt > where.expiresAt.gt ? row : null;
  };
  prisma.projectMembership.findMany = async () => { membershipReads++; return []; };
  prisma.accountDeletionRequest.upsert = async ({ where, create, update }) => {
    if (failWrite) throw new Error('storage unavailable');
    assert.deepEqual(update, {});
    let row = requests.get(where.userId);
    if (!row) { row = { id: `request-${where.userId}`, status: 'pending', ...create }; requests.set(where.userId, row); }
    return row;
  };
  prisma.accountDeletionRequest.findUnique = async ({ where }) => requests.get(where.userId) ?? null;
  const app = express(); app.use(express.json()); app.use('/v1/auth', accountDeletionRouter);
  app.get('/ordinary-project-route', authenticate, (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({ error: error.code ?? 'SERVER_ERROR' }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
const submit = (token, body = {}) => fetch(`${base}/v1/auth/account-deletion-requests`, {
  method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'X-Project-Id': 'foreign-project' }, body: JSON.stringify(body)
});
test('a verified account can request deletion without a project, role, or active subscription', async () => {
  reset(); const before = Date.now(); const response = await submit(tokenFor()); const { data } = await response.json();
  assert.equal(response.status, 200); assert.equal(data.status, 'pending'); assert.equal(data.support_email, 'hello@appnesta.com');
  assert.equal(requests.get('user-a').tenantId, 'tenant-a'); assert.equal(membershipReads, 0);
  assert.ok(new Date(data.requested_at).getTime() >= before);
  assert.equal(new Date(data.due_at) - new Date(data.requested_at), 30 * 24 * 60 * 60 * 1000);
});
test('retries keep the original reference and deadline', async () => {
  reset(); const token = tokenFor(); const first = (await (await submit(token)).json()).data;
  const again = (await (await submit(token)).json()).data; assert.deepEqual(again, first); assert.equal(requests.size, 1);
});
test('users cannot submit another user or tenant in the request body', async () => {
  reset(); const response = await submit(tokenFor(), { user_id: 'victim', tenant_id: 'foreign' });
  assert.equal(response.status, 400); assert.equal(requests.size, 0);
});
test('missing, invalid, revoked, expired and inactive sessions cannot create requests', async () => {
  reset(); assert.equal((await submit()).status, 401); assert.equal((await submit('invalid')).status, 401);
  for (const kind of ['revoked', 'expired', 'inactive']) {
    const token = tokenFor(); const session = sessions.get('session-user-a');
    if (kind === 'revoked') session.revokedAt = new Date();
    if (kind === 'expired') session.expiresAt = new Date(0);
    if (kind === 'inactive') session.user.isActive = false;
    assert.equal((await submit(token)).status, 401, kind);
  }
  assert.equal(requests.size, 0);
});
test('request status is scoped to the signed-in account', async () => {
  reset(); const first = tokenFor(); const second = tokenFor('user-b', 'tenant-b'); await submit(first);
  const response = await fetch(`${base}/v1/auth/account-deletion-requests/current`, { headers: { Authorization: `Bearer ${second}` } });
  assert.equal((await response.json()).data, null);
  const own = await fetch(`${base}/v1/auth/account-deletion-requests/current`, { headers: { Authorization: `Bearer ${first}` } });
  assert.equal((await own.json()).data.id, 'request-user-a');
});
test('database failures do not return a false confirmation', async () => {
  reset(); failWrite = true; assert.equal((await submit(tokenFor())).status, 500); assert.equal(requests.size, 0);
});
test('ordinary authentication still enforces project membership', async () => {
  reset(); const response = await fetch(`${base}/ordinary-project-route`, { headers: { Authorization: `Bearer ${tokenFor()}` } });
  assert.equal(response.status, 403); assert.equal(membershipReads, 1);
});
