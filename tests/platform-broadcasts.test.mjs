import { installAccountReadFixtures } from './helpers/normalized-fixtures.mjs';
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
function fixture(includeInboxOnlyAccounts = false) {
  const rows = [], deliveries = [], inbox = [], audit = [], pushes = [];
  let recipients = structuredClone(users), ready = true, result = { sent_count: 1, failed_count: 0, invalid_tokens: [], skipped: false }, claimable = true;
  const writes = [], lookups = [];
  const db = {
    user: { async findMany(input) {
      const { where, take } = input; lookups.push(input);
      assert.equal(where.isActive, true); assert.deepEqual(where.tenant, { deletionStartedAt: null });
      let found = recipients.filter(user => typeof where.id === 'string' ? user.id === where.id : where.id?.in ? where.id.in.includes(user.id) : true);
      if (where.OR) found = found.filter(user => where.OR.some(part => Object.entries(part).some(([field, match]) => String(user[field] ?? '').toLowerCase().includes(match.contains.toLowerCase()))));
      return take ? found.slice(0, take) : found;
    }, async updateMany(input) { writes.push(input); return { count: 1 }; } },
    platformBroadcast: {
      async findUnique({ where }) { return rows.find(row => where.id ? row.id === where.id : row.actor === where.actor_requestKey.actor && row.requestKey === where.actor_requestKey.requestKey) ?? null; },
      async create({ data }) { const row = { id: 'broadcast' + (rows.length + 1), createdAt: new Date(), ...data }; rows.push(row); return row; },
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
  installAccountReadFixtures(db);
  db.user.findMany = async () => { throw new Error('Broadcast recipients must be read from tenant accounts, not global users'); };
  const service = createPlatformBroadcasts(db, async input => { pushes.push(input); if (result instanceof Error) throw result; return result; }, () => ready, 'synthetic-preview-secret', includeInboxOnlyAccounts);
  const input = async () => { const p = await service.preview(actor, draft); return { draft, request_key: randomUUID(), preview_token: p.preview_token, expires_at: p.expires_at }; };
  const workerRow = (extra = {}) => { deliveries.push({ id: 'delivery1', broadcastId: 'broadcast1', recipientIds: ['u1', 'u2'], tokenHash: digest('same-device'), attempts: 0, broadcast: draft, ...extra }); };
  return { service, rows, deliveries, inbox, audit, pushes, writes, lookups, input, workerRow,
    recipients(value) { recipients = value; }, ready(value) { ready = value; }, result(value) { result = value; }, claimable(value) { claimable = value; } };
}
test('reach counts unique registered devices across organizations and omits empty tokens', () => {
  const audience = broadcastAudience([...users, { id: 'u4', tenantId: 'org4', deviceId: '   ' }, { id: 'u5', tenantId: 'org4', deviceId: null }]);
  assert.deepEqual(audience.reach, { devices: 2, accounts: 3, organizations: 3 });
  assert.deepEqual(audience.devices.get(digest('same-device')), ['u1', 'u2']);
});
test('audience reads active tenant accounts with active identities after identity normalization', async () => {
  const calls = [];
  const db = { tenantUser: { async findMany(input) {
    calls.push(input);
    assert.equal(input.where.isActive, true);
    assert.deepEqual(input.where.identity, { isActive: true });
    assert.deepEqual(input.where.tenant, { deletionStartedAt: null });
    assert.deepEqual(input.where.deviceId, { not: null });
    assert.equal(input.select.tenantId, true);
    assert.equal(input.select.deviceId, true);
    assert.equal(input.select.identity.select.isActive, true);
    const row = { id: 'tenant-account', tenantId: 'org1', userId: 'global-identity', isActive: true,
      deviceId: 'registered-device', identity: { id: 'global-identity', isActive: true } };
    return !input.where.id || input.where.id === row.id ? [row] : [];
  } } };
  const service = createPlatformBroadcasts(db, undefined, () => true, 'synthetic-preview-secret');
  assert.deepEqual(await service.reach(), { devices: 1, accounts: 1, organizations: 1, push_configured: true });
  const preview = await service.preview(actor, { ...draft, test_user_id: 'tenant-account' });
  assert.equal(preview.accounts, 1);
  assert.equal(calls.at(-1).where.id, 'tenant-account');
  await assert.rejects(service.preview(actor, { ...draft, test_user_id: 'global-identity' }), /no longer/);
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
  for (const change of ['token', 'draft', 'url', 'actor', 'expired']) {
    const f = fixture(), input = await f.input(); let who = actor;
    if (change === 'token') f.recipients([{ ...users[0], deviceId: 'changed-token' }]);
    if (change === 'draft') input.draft = { ...draft, title: 'A different title' };
    if (change === 'url') input.draft = { ...draft, url: 'https://example.test/changed' };
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
  for (const name of ['reach', 'searchUsers', 'preview', 'send', 'history', 'retry']) {
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
    assert.equal((await fetch(base + '/users?search=Ali')).status, 401);
    assert.equal((await fetch(base + '/users?search=A', { headers })).status, 400);
    assert.equal((await fetch(base + '/users?search=Ali', { headers })).status, 200);
    assert.deepEqual(calls.at(-1), { name: 'searchUsers', args: ['Ali'] });
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

test('user search is bounded, searches contact fields and exposes no device tokens', async () => {
  const f = fixture();
  f.recipients([{ ...users[0], name: 'Ali Hasan', email: 'ali@example.test', mobile: '01711111111', tenant: { name: 'Test fund' } },
    { ...users[1], name: 'Someone else', email: null, mobile: '01822222222', tenant: { name: 'Other fund' } }]);
  for (const search of ['ALI', 'example.test', '01711']) {
    const result = await f.service.searchUsers(search);
    assert.deepEqual(result.users.map(user => user.id), ['u1']);
    assert.equal(result.users[0].organization, 'Test fund');
    assert.doesNotMatch(JSON.stringify(result), /same-device|deviceId|tokenHash/);
    assert.equal(f.lookups.at(-1).take, 20);
  }
  await assert.rejects(f.service.searchUsers('a'));
  await assert.rejects(f.service.searchUsers('x'.repeat(101)));
});

test('a signed test queues only the selected account and device, including its poster and action', async () => {
  const f = fixture(), targeted = { ...draft, test_user_id: 'u1', image_url: 'https://cdn.test/poster.jpg', url: 'fundnesta://open?screen=home' };
  const p = await f.service.preview(actor, targeted);
  assert.equal(p.accounts, 1); assert.equal(p.devices, 1); assert.equal(p.organizations, 1);
  const input = { draft: targeted, request_key: randomUUID(), preview_token: p.preview_token, expires_at: p.expires_at };
  await f.service.send(actor, input);
  assert.deepEqual(f.inbox.map(row => row.recipientUserId), ['u1']);
  assert.deepEqual(f.deliveries.map(row => row.recipientIds), [['u1']]);
  assert.equal(f.inbox[0].imageUrl, targeted.image_url); assert.equal(f.inbox[0].actionUrl, targeted.url);
  assert.equal(f.audit[0].action, 'notification.test_queued'); assert.equal(f.audit[0].metadata.test_user_id, 'u1');
  await f.service.send(actor, input); assert.equal(f.rows.length, 1);
  await assert.rejects(f.service.send(actor, { ...input, draft }), /another message/);
  f.deliveries.length = 0; f.workerRow({ recipientIds: ['u1'], broadcast: f.rows[0] }); await f.service.deliver();
  assert.deepEqual(f.lookups.at(-1).where.id, { in: ['u1'] });
  assert.deepEqual(f.pushes[0].tokens, ['same-device']);
});

test('changing or removing a test recipient cannot reuse the signed preview to broadcast', async () => {
  for (const changed of [draft, { ...draft, test_user_id: 'u2' }]) {
    const f = fixture(), targeted = { ...draft, test_user_id: 'u1' }, p = await f.service.preview(actor, targeted);
    await assert.rejects(f.service.send(actor, { draft: changed, request_key: randomUUID(), preview_token: p.preview_token, expires_at: p.expires_at }), /review/i);
    assert.equal(f.rows.length, 0); assert.equal(f.inbox.length, 0);
  }
  for (const test_user_id of ['', ' ', '../u1']) assert.equal(broadcastDraftSchema.safeParse({ ...draft, test_user_id }).success, false);
});

test('missing and revoked test users fail without falling back to all accounts', async () => {
  const f = fixture(), targeted = { ...draft, test_user_id: 'u1' }, p = await f.service.preview(actor, targeted);
  f.recipients(users.slice(1));
  await assert.rejects(f.service.send(actor, { draft: targeted, request_key: randomUUID(), preview_token: p.preview_token, expires_at: p.expires_at }), /no longer/);
  await assert.rejects(f.service.preview(actor, { ...draft, test_user_id: 'missing' }), /no longer/);
  assert.equal(f.rows.length, 0); assert.equal(f.inbox.length, 0);
});

const testingUrl = 'https://play.google.com/apps/testing/com.fundnesta.appnesta.app';
test('notification links are optional and require a credential-free HTTPS URL', () => {
  assert.deepEqual(broadcastDraftSchema.parse(draft), draft);
  assert.equal(broadcastDraftSchema.parse({ ...draft, url: '  ' + testingUrl + '  ' }).url, testingUrl);
  for (const url of ['', 'http://example.test', 'javascript:alert(1)', 'https://user:secret@example.test', 'https://example.test/a\nb', 'https://example.test/hello world', 'https://example.test/\\evil', 'https://', 'https://example.test/' + 'a'.repeat(2048)]) {
    assert.equal(broadcastDraftSchema.safeParse({ ...draft, url }).success, false, url);
  }
});
test('reviewed links persist on the broadcast, private inbox copies, history and push metadata', async () => {
  const f = fixture(), linked = broadcastDraftSchema.parse({ ...draft, url: testingUrl });
  const preview = await f.service.preview(actor, linked);
  assert.equal(preview.draft.url, testingUrl); assert.equal(f.rows.length, 0);
  const input = { draft: linked, preview_token: preview.preview_token, expires_at: preview.expires_at, request_key: randomUUID() };
  const sent = await f.service.send(actor, input);
  assert.equal(sent.url, testingUrl); assert.equal(f.rows[0].actionUrl, testingUrl);
  assert.ok(f.inbox.every(row => row.actionUrl === testingUrl));
  assert.deepEqual(f.inbox.map(row => [row.tenantId, row.recipientUserId]), [['org1', 'u1'], ['org2', 'u2'], ['org3', 'u3']]);
  assert.equal((await f.service.history()).notifications[0].url, testingUrl);
  await assert.rejects(f.service.send(actor, { ...input, draft: { ...linked, url: 'https://example.test/changed' } }), /another message/);
  f.deliveries.length = 0; f.workerRow({ broadcast: f.rows[0] }); await f.service.deliver();
  assert.equal(f.pushes[0].data.url, testingUrl); assert.equal(f.pushes[0].data.project_id, undefined);
});

test('promotional poster and deep link persist through review, inbox, history and FCM delivery', async () => {
  const f = fixture(), linked = broadcastDraftSchema.parse({ ...draft, image_url: 'https://cdn.example.test/promotion.png', url: 'fundnesta://open?screen=support' });
  const preview = await f.service.preview(actor, linked);
  const input = { draft: linked, preview_token: preview.preview_token, expires_at: preview.expires_at, request_key: randomUUID() };
  const sent = await f.service.send(actor, input);
  assert.equal(sent.image_url, linked.image_url); assert.equal(sent.url, linked.url);
  assert.ok(f.inbox.every(row => row.imageUrl === linked.image_url && row.actionUrl === linked.url));
  assert.equal((await f.service.history()).notifications[0].image_url, linked.image_url);
  await assert.rejects(f.service.send(actor, { ...input, draft: { ...linked, image_url: 'https://cdn.example.test/other.png' } }), /another message/);
  f.deliveries.length = 0; f.workerRow({ broadcast: f.rows[0] }); await f.service.deliver();
  assert.equal(f.pushes[0].imageUrl, linked.image_url); assert.equal(f.pushes[0].data.image_url, linked.image_url); assert.equal(f.pushes[0].data.url, linked.url);
});
test('unsupported deep links and unsafe poster sources are rejected', () => {
  for (const url of ['fundnesta://open?screen=admin', 'fundnesta://user@open?screen=support', 'fundnesta://open/path?screen=billing', 'fundnesta://open?screen=support&redirect=https://evil.test']) assert.equal(broadcastDraftSchema.safeParse({ ...draft, url }).success, false);
  for (const image_url of ['http://cdn.test/promo.png', 'file:///private.png', 'data:image/png;base64,abc', 'fundnesta://open?screen=support', 'https://user:pass@cdn.test/promo.png']) assert.equal(broadcastDraftSchema.safeParse({ ...draft, image_url }).success, false);
  const f = fixture();
  assert.equal(broadcastDraftSchema.safeParse({ ...draft, body: '😀'.repeat(250), url: 'https://example.test/' + 'x'.repeat(1500), image_url: 'https://cdn.test/' + 'x'.repeat(1500) }).success, false, 'oversize FCM payloads fail before review');
});
test('changing only the poster invalidates the signed preview', async () => {
  const f = fixture(), input = await f.input();
  await assert.rejects(f.service.send(actor, { ...input, draft: { ...draft, image_url: 'https://cdn.test/promotion.png' } }), /review/i);
  assert.equal(f.rows.length, 0);
});


test('master announcements include inbox-only accounts and deduplicate registered devices', async () => {
  const f = fixture(true);
  f.recipients([...users, { id: 'web-only', tenantId: 'org4', deviceId: null }, { id: 'blank-device', tenantId: 'org4', deviceId: ' ' }]);
  const p = await f.service.preview(actor, draft);
  assert.equal(p.accounts, 5); assert.equal(p.devices, 2); assert.equal(p.organizations, 4);
  await f.service.send(actor, { draft, request_key: randomUUID(), preview_token: p.preview_token, expires_at: p.expires_at });
  assert.equal(f.inbox.length, 5); assert.equal(f.deliveries.length, 2);
  assert.ok(f.inbox.some(row => row.recipientUserId === 'web-only'));
  assert.equal(f.lookups[0].where.deviceId, undefined);
});
test('inbox-only announcements can be queued without Firebase, and recipient changes invalidate review', async () => {
  const f = fixture(true);
  f.recipients([{ id: 'web-only', tenantId: 'org1', deviceId: null }]); f.ready(false);
  const input = await f.input();
  await f.service.send(actor, input);
  assert.equal(f.inbox.length, 1); assert.equal(f.deliveries.length, 0);
  const g = fixture(true), p = await g.input();
  g.recipients([...users, { id: 'new-user', tenantId: 'org1', deviceId: null }]);
  await assert.rejects(g.service.send(actor, p), /review/i);
  assert.equal(g.inbox.length, 0);
});
test('master test mode still requires one registered device and never includes other inbox accounts', async () => {
  const f = fixture(true);
  f.recipients([...users, { id: 'web-only', tenantId: 'org1', deviceId: null }]);
  await assert.rejects(f.service.preview(actor, { ...draft, test_user_id: 'web-only' }), /no longer/);
  const targeted = { ...draft, test_user_id: 'u1' }, p = await f.service.preview(actor, targeted);
  await f.service.send(actor, { draft: targeted, request_key: randomUUID(), preview_token: p.preview_token, expires_at: p.expires_at });
  assert.deepEqual(f.inbox.map(row => row.recipientUserId), ['u1']);
  assert.deepEqual(f.deliveries.map(row => row.recipientIds), [['u1']]);
});
