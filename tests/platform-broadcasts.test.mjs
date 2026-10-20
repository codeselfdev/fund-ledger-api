import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
Object.assign(process.env, { DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/no_database', JWT_SECRET: 'synthetic-test-jwt-secret', INTERNAL_API_KEY: 'synthetic-internal-key-with-over-32-characters' });
const { createPlatformBroadcasts, broadcastAudience, broadcastDraftSchema, broadcastSendSchema } = await import('../dist/modules/internal/platform-broadcasts.service.js');
const draft = { title: 'A new feature', body: 'Explore what is new in Fund Nesta.' };
const actor = 'admin@example.test';
const users = [
  { id: 'u1', tenantId: 'org1', deviceId: 'same-device' },
  { id: 'u2', tenantId: 'org2', deviceId: 'same-device' },
  { id: 'u3', tenantId: 'org3', deviceId: 'another-device' },
];
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const rows = [], deliveries = [], inbox = [], audit = [], pushes = [];
  let recipients = structuredClone(users), ready = true, result = { sent_count: 1, failed_count: 0, invalid_tokens: [], skipped: false }, claimable = true;
  const writes = [];
  const db = {
    user: { async findMany({ where }) { assert.equal(where.isActive, true); assert.deepEqual(where.tenant, { deletionStartedAt: null }); return recipients; }, async updateMany(input) { writes.push(input); return { count: 1 }; } },
    platformBroadcast: {
      async findUnique({ where }) { return rows.find(row => where.id ? row.id === where.id : row.actor === where.actor_requestKey.actor && row.requestKey === where.actor_requestKey.requestKey) ?? null; },
      async create({ data }) { const row = { id: 'broadcast1', createdAt: new Date(), ...data }; rows.push(row); return row; },
      async findMany() { return rows; },
    },
    platformBroadcastDelivery: {
      async createMany({ data }) { deliveries.push(...data); return { count: data.length }; },
      async groupBy() { return []; },
      async findMany() { return deliveries; },
      async updateMany(input) { writes.push(input); return { count: input.where.id && !claimable ? 0 : 1 }; },
    },
    notification: { async createMany({ data }) { inbox.push(...data); return { count: data.length }; } },
    internalAudit: { async create({ data }) { audit.push(data); return data; } },
    async $transaction(fn) { return fn(db); },
  };
  const service = createPlatformBroadcasts(db, async input => { pushes.push(input); if (result instanceof Error) throw result; return result; }, () => ready, 'synthetic-preview-secret');
  const input = async () => { const p = await service.preview(actor, draft); return { draft, request_key: randomUUID(), preview_token: p.preview_token, expires_at: p.expires_at }; };
  const workerRow = (extra = {}) => { deliveries.push({ id: 'delivery1', broadcastId: 'broadcast1', recipientIds: ['u1', 'u2'], tokenHash: digest('same-device'), attempts: 0, broadcast: draft, ...extra }); };
  return { service, rows, deliveries, inbox, audit, pushes, writes, input, workerRow,
    recipients(value) { recipients = value; }, ready(value) { ready = value; }, result(value) { result = value; }, claimable(value) { claimable = value; } };
}
test('reach counts unique registered devices across organizations and omits empty tokens', () => {
  const audience = broadcastAudience([...users, { id: 'u4', tenantId: 'org4', deviceId: '   ' }, { id: 'u5', tenantId: 'org4', deviceId: null }]);
  assert.deepEqual(audience.reach, { devices: 2, accounts: 3, organizations: 3 });
  assert.deepEqual(audience.devices.get(digest('same-device')), ['u1', 'u2']);
});
test('input rejects blank, oversize and unknown fields', () => {
  for (const value of [{ ...draft, title: '  ' }, { ...draft, title: 'x'.repeat(66) }, { ...draft, body: 'x'.repeat(501) }, { ...draft, tenant_id: 'foreign' }]) assert.equal(broadcastDraftSchema.safeParse(value).success, false);
  assert.equal(broadcastSendSchema.safeParse({ draft, request_key: 'not-a-uuid' }).success, false);
});
test('preview returns counts and a signed token without exposing tokens or account IDs', async () => {
  const f = fixture(), preview = await f.service.preview(actor, draft);
  assert.equal(preview.devices, 2); assert.equal(preview.accounts, 3);
  assert.equal(preview.preview_token.length, 64);
  assert.doesNotMatch(JSON.stringify(preview), /same-device|another-device|u1|org1/);
  assert.equal(f.inbox.length, 0); assert.equal(f.pushes.length, 0);
});
test('queue snapshots one delivery per device and an inbox copy per account without sending live push', async () => {
  const f = fixture(), input = await f.input();
  const sent = await f.service.send(actor, input);
  assert.equal(sent.devices, 2); assert.equal(f.deliveries.length, 2); assert.equal(f.inbox.length, 3);
  assert.deepEqual(f.inbox.map(row => row.tenantId), ['org1', 'org2', 'org3']);
  assert.ok(f.inbox.every(row => row.type === 'announcement.platform' && !row.projectId));
  assert.doesNotMatch(JSON.stringify(f.deliveries), /same-device|another-device/);
  assert.equal(f.audit[0].actor, actor); assert.equal(f.pushes.length, 0);
  await f.service.send(actor, input);
  assert.equal(f.rows.length, 1); assert.equal(f.inbox.length, 3);
  await assert.rejects(f.service.send(actor, { ...input, draft: { ...draft, body: 'Different message' } }), /another message/);
});
test('changed token, changed message, another actor and expired preview all require fresh review', async () => {
  for (const change of ['token', 'draft', 'actor', 'expired']) {
    const f = fixture(), input = await f.input(); let who = actor;
    if (change === 'token') f.recipients([{ ...users[0], deviceId: 'changed-token' }]);
    if (change === 'draft') input.draft = { ...draft, title: 'A different title' };
    if (change === 'actor') who = 'other-admin@example.test';
    if (change === 'expired') input.expires_at = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(f.service.send(who, input), /Review|review/); assert.equal(f.rows.length, 0);
  }
});
test('missing Firebase configuration and empty audiences cannot be queued', async () => {
  const f = fixture(), input = await f.input(); f.ready(false);
  await assert.rejects(f.service.send(actor, input), /not configured/);
  f.ready(true); f.recipients([]);
  await assert.rejects(f.service.send(actor, await f.input()), /No registered devices/);
});
test('worker sends one push for a shared device without project-scoped navigation', async () => {
  const f = fixture(); f.workerRow(); await f.service.deliver();
  assert.equal(f.pushes.length, 1); assert.deepEqual(f.pushes[0].tokens, ['same-device']);
  assert.equal(f.pushes[0].data.type, 'announcement.platform'); assert.equal(f.pushes[0].data.project_id, undefined);
  assert.ok(f.writes.some(write => write.data.status === 'sent' && write.where.leaseToken));
});
test('worker skips revoked recipients and changed device registrations', async () => {
  for (const recipients of [[], [{ ...users[0], deviceId: 'new-owner-device' }]]) {
    const f = fixture(); f.workerRow(); f.recipients(recipients); await f.service.deliver();
    assert.equal(f.pushes.length, 0); assert.ok(f.writes.some(write => write.data.status === 'skipped'));
  }
});
test('worker clears invalid tokens and skips them without recording success', async () => {
  const f = fixture(); f.workerRow(); f.result({ sent_count: 0, failed_count: 1, skipped: false, invalid_tokens: ['same-device'] });
  await f.service.deliver();
  assert.ok(f.writes.some(write => write.where.deviceId === 'same-device' && write.data.deviceId === null));
  assert.ok(f.writes.some(write => write.data.lastError === 'invalid_device_token'));
  assert.ok(!f.writes.some(write => write.data.status === 'sent'));
});
test('worker retries temporary failures with a limit and does not send a delivery claimed by another worker', async () => {
  for (const attempts of [0, 4]) {
    const f = fixture(); f.workerRow({ attempts }); f.result(new Error('Mock provider outage')); await f.service.deliver();
    const failed = f.writes.find(write => write.data.lastError === 'provider_unavailable');
    assert.equal(failed.data.status, attempts === 4 ? 'failed' : 'pending'); assert.ok(failed.data.nextAttemptAt > new Date());
  }
  const f = fixture(); f.workerRow(); f.claimable(false); await f.service.deliver(); assert.equal(f.pushes.length, 0);
});
test('manual retry resets only failed delivery rows and records the operator', async () => {
  const f = fixture(); await f.service.send(actor, await f.input()); await f.service.retry(actor, 'broadcast1');
  const write = f.writes.find(write => write.where.broadcastId);
  assert.deepEqual(write.where, { broadcastId: 'broadcast1', status: 'failed' }); assert.equal(write.data.attempts, 0);
  assert.equal(f.audit.at(-1).action, 'notification.broadcast_retried');
});
test('HTTP routes require the internal key, operator identity and validated drafts', async () => {
  const { createApp } = await import('../dist/app.js');
  const { platformBroadcasts } = await import('../dist/modules/internal/platform-broadcasts.service.js');
  const calls = [], originals = {};
  for (const name of ['reach', 'preview', 'send', 'history', 'retry']) {
    originals[name] = platformBroadcasts[name];
    platformBroadcasts[name] = async (...args) => { calls.push({ name, args }); return { synthetic: true }; };
  }
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}/v1/internal/notifications`;
  const headers = { 'x-internal-api-key': process.env.INTERNAL_API_KEY, 'x-internal-actor': actor, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/audience')).status, 401);
    assert.equal((await fetch(base + '/audience', { headers: { Authorization: 'Bearer synthetic-user-token' } })).status, 401);
    assert.equal((await fetch(base + '/audience', { headers: { 'x-api-key': 'synthetic-provisioning-key' } })).status, 401);
    assert.equal((await fetch(base + '/audience', { headers })).status, 200);
    assert.equal(calls.at(-1).name, 'reach');
    assert.equal((await fetch(base + '/preview', { method: 'POST', headers: { 'x-internal-api-key': process.env.INTERNAL_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(draft) })).status, 400);
    assert.equal((await fetch(base + '/preview', { method: 'POST', headers, body: JSON.stringify({ ...draft, title: '  ' }) })).status, 400);
    assert.equal((await fetch(base + '/preview', { method: 'POST', headers, body: JSON.stringify(draft) })).status, 200);
    assert.deepEqual(calls.at(-1), { name: 'preview', args: [actor, draft] });
    const input = { draft, request_key: randomUUID(), preview_token: 'a'.repeat(64), expires_at: new Date().toISOString() };
    assert.equal((await fetch(base, { method: 'POST', headers, body: JSON.stringify(input) })).status, 200);
    assert.deepEqual(calls.at(-1), { name: 'send', args: [actor, input] });
    assert.equal((await fetch(base + '?offset=30', { headers })).status, 200);
    assert.deepEqual(calls.at(-1), { name: 'history', args: [30] });
    assert.equal((await fetch(base + '/broadcast1/retry', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.deepEqual(calls.at(-1), { name: 'retry', args: [actor, 'broadcast1'] });
  } finally {
    Object.assign(platformBroadcasts, originals);
    await new Promise(resolve => server.close(resolve));
  }
});
