import { installAccountReadFixtures } from './helpers/normalized-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
Object.assign(process.env, { DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/no_database', JWT_SECRET: 'synthetic-master-alerts-secret' });
const { createMasterAlertNotifier, masterAlertIdentity, masterAlertLink } = await import('../dist/modules/internal/master-alerts.service.js');
const digest = value => createHash('sha256').update(value).digest('hex');
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR') return value.some(part => matches(row, part));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('lte' in value) return row[key] <= value.lte;
      if ('lt' in value) return row[key] < value.lt;
      if ('in' in value) return value.in.includes(row[key]);
    }
    return value instanceof Date ? row[key]?.getTime() === value.getTime() : row[key] === value;
  });
}
function fixture(kinds = ['support_message']) {
  const mail = [], pushes = [], lookups = [], changes = [];
  let users = [{ id: 'master', email: 'master@example.test', deviceId: 'master-device', isActive: true, verified: true }];
  let config = { email: 'master@example.test', userId: 'master', origin: 'https://fundnesta.appnesta.com' };
  let emailReady = true, pushReady = true, emailFailure = false, claimable = true;
  const pushFailures = new Set(), invalid = new Set();
  let onPush = () => {};
  const rows = kinds.flatMap((kind, index) => ['email', 'push'].map(channel => ({
    id: `${index}-${channel}`, tenantId: 'customer-org', alertId: `alert${index}`, channel, status: 'pending', attempts: 0,
    nextAttemptAt: new Date(0), leaseUntil: null, leaseToken: null, sentAt: null, lastError: null, acceptedPushHashes: [],
    alert: { id: `alert${index}`, tenantId: 'customer-org', kind, ticketId: kind === 'support_message' ? 'ticket-1' : null,
      eventKey: kind === 'support_message' ? 'support:message-1' : `${kind}:invoice-1:proof-1`, tenant: { name: 'Customer organization', deletionStartedAt: null } },
  })));
  const db = {
    masterAlertDelivery: {
      async findMany({ where }) { return structuredClone(rows.filter(row => matches(row, where))); },
      async updateMany({ where, data }) {
        changes.push(structuredClone({ where, data }));
        if (!claimable && data.leaseToken) return { count: 0 };
        const selected = rows.filter(row => matches(row, where));
        for (const row of selected) for (const [key, value] of Object.entries(data))
          row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment
            : value && typeof value === 'object' && 'push' in value ? [...row[key], value.push] : value;
        return { count: selected.length };
      },
    },
    user: {
      async findMany({ where }) {
        lookups.push(where);
        return users.filter(user => user.isActive && user.email.toLowerCase() === where.email.equals && (!where.id || user.id === where.id)
          && (!where.sessions || user.verified)).map(user => ({ id: user.id, deviceId: user.deviceId }));
      },
      async updateMany({ where, data }) { const selected = users.filter(user => matches(user, where)); selected.forEach(user => Object.assign(user, data)); return { count: selected.length }; },
    },
  };
  installAccountReadFixtures(db);
  const notifier = createMasterAlertNotifier(db, {
    email: async input => { if (emailFailure) throw Error('Synthetic email outage'); mail.push(input); return true; },
    push: async input => { pushes.push(input); onPush(input); const token = input.tokens[0]; return { sent_count: pushFailures.has(token) || invalid.has(token) ? 0 : 1, failed_count: 0, invalid_tokens: invalid.has(token) ? [token] : [], skipped: false }; },
  }, { email: () => emailReady, push: () => pushReady }, () => config);
  return { notifier, rows, mail, pushes, lookups, changes, pushFailures, invalid,
    users(value) { users = value; }, currentUsers: () => users, config(value) { config = value; },
    ready(email, push) { emailReady = email; pushReady = push; }, failEmail(value) { emailFailure = value; },
    claimable(value) { claimable = value; }, onPush(value) { onPush = value; },
    due() { rows.filter(row => row.status === 'pending').forEach(row => { row.nextAttemptAt = new Date(0); }); },
  };
}
test('every customer support message, plan request and payment submission sends independent master email and push', async () => {
  const f = fixture(['support_message', 'billing_upgrade', 'billing_payment']); await f.notifier.deliver();
  assert.equal(f.mail.length, 3); assert.equal(f.pushes.length, 3); assert.ok(f.rows.every(row => row.status === 'sent'));
  assert.ok(f.mail.every(row => row.to === 'master@example.test'));
  assert.ok(f.pushes.every(row => row.tokens[0] === 'master-device'));
  assert.match(f.mail[0].text, /support\/admin\?tab=support&ticket=ticket-1/);
  assert.match(f.mail[1].text, /tab=billing&organization=customer-org&invoice=invoice-1/);
  assert.match(f.mail[2].subject, /Payment awaiting review/);
  assert.doesNotMatch(JSON.stringify(f.pushes), /Customer organization|payment_reference|receipt|master@example/);
  assert.ok(f.pushes.every(row => !row.data.project_id && !row.data.tenant_id && row.data.type === 'master_admin.request'));
  await f.notifier.deliver(); assert.equal(f.mail.length, 3); assert.equal(f.pushes.length, 3);
});
test('email outage does not block push or resend a successful push during email recovery', async () => {
  const f = fixture(); f.failEmail(true); await f.notifier.deliver();
  assert.equal(f.mail.length, 0); assert.equal(f.pushes.length, 1); assert.equal(f.rows[0].status, 'pending');
  f.failEmail(false); f.due(); await f.notifier.deliver();
  assert.equal(f.mail.length, 1); assert.equal(f.pushes.length, 1); assert.ok(f.rows.every(row => row.status === 'sent'));
});
test('push outage does not block email or resend email during push recovery', async () => {
  const f = fixture(); f.pushFailures.add('master-device'); await f.notifier.deliver();
  assert.equal(f.mail.length, 1); assert.equal(f.rows[1].status, 'pending');
  f.pushFailures.clear(); f.due(); await f.notifier.deliver();
  assert.equal(f.mail.length, 1); assert.equal(f.pushes.length, 2); assert.ok(f.rows.every(row => row.status === 'sent'));
});
test('missing configuration waits durably without consuming attempts', async () => {
  const f = fixture(); f.config(null); await f.notifier.deliver();
  assert.ok(f.rows.every(row => row.status === 'pending' && row.attempts === 0 && row.lastError === 'master_not_configured'));
  assert.equal(f.mail.length, 0); assert.equal(f.pushes.length, 0);
  f.config({ email: 'master@example.test', userId: 'master', origin: 'https://fundnesta.appnesta.com' }); f.ready(false, false); f.due();
  await f.notifier.deliver(); assert.ok(f.rows.every(row => row.attempts === 0));
  f.ready(true, true); f.due(); await f.notifier.deliver(); assert.ok(f.rows.every(row => row.status === 'sent'));
});
test('missing registered device waits for registration while master email still succeeds', async () => {
  const f = fixture(); f.users([{ id: 'master', email: 'master@example.test', isActive: true, deviceId: null }]);
  await f.notifier.deliver(); assert.equal(f.mail.length, 1); assert.equal(f.pushes.length, 0);
  assert.equal(f.rows[1].lastError, 'no_registered_master_device'); assert.equal(f.rows[1].attempts, 0);
  f.currentUsers()[0].deviceId = 'new-registration'; f.due(); await f.notifier.deliver();
  assert.equal(f.mail.length, 1); assert.equal(f.pushes[0].tokens[0], 'new-registration');
});
test('pinned master user and current email are both required; ordinary customer devices receive nothing', async () => {
  const f = fixture(); f.users([
    { id: 'master', email: 'different@example.test', isActive: true, deviceId: 'wrong-email-device' },
    { id: 'other', email: 'master@example.test', isActive: true, verified: true, deviceId: 'wrong-id-device' },
    { id: 'customer', email: 'customer@example.test', isActive: true, deviceId: 'customer-device' },
  ]); await f.notifier.deliver(); assert.equal(f.pushes.length, 0);
  assert.equal(f.lookups[0].id, 'master'); assert.deepEqual(f.lookups[0].tenant, { deletionStartedAt: null });
});
test('unpinned email lookup requires verified email provenance and works without an active admin login or subscription', async () => {
  const f = fixture(); f.config({ email: 'master@example.test', origin: 'https://fundnesta.appnesta.com' });
  f.users([{ id: 'spoofed', email: 'master@example.test', isActive: true, verified: false, deviceId: 'spoofed-device' },
    { id: 'master', email: 'master@example.test', isActive: true, verified: true, deviceId: 'verified-device' }]);
  await f.notifier.deliver(); assert.deepEqual(f.pushes.map(row => row.tokens), [['verified-device']]);
  assert.deepEqual(f.lookups[0].sessions.some, { verifiedEmail: { equals: 'master@example.test', mode: 'insensitive' }, impersonatorSessionId: null });
  assert.equal(f.lookups[0].memberships, undefined); assert.equal(f.lookups[0].sessions.some.expiresAt, undefined);
});
test('shared master device tokens are deduplicated and raw tokens are never stored in the outbox', async () => {
  const f = fixture(); f.config({ email: 'master@example.test', origin: 'https://fundnesta.appnesta.com' });
  f.users(['a', 'b'].map(id => ({ id, email: 'master@example.test', isActive: true, verified: true, deviceId: 'shared-master-device' })));
  await f.notifier.deliver(); assert.equal(f.pushes.length, 1);
  assert.deepEqual(f.rows[1].acceptedPushHashes, [digest('shared-master-device')]);
  assert.doesNotMatch(JSON.stringify(f.rows), /shared-master-device/);
});
test('a failed device retries without repeating devices already accepted by the provider', async () => {
  const f = fixture(); f.config({ email: 'master@example.test', origin: 'https://fundnesta.appnesta.com' });
  f.users(['one', 'two'].map(id => ({ id, email: 'master@example.test', isActive: true, verified: true, deviceId: id })));
  f.pushFailures.add('one'); await f.notifier.deliver(); assert.equal(f.rows[1].status, 'pending');
  assert.deepEqual(f.rows[1].acceptedPushHashes, [digest('two')]);
  f.pushFailures.clear(); f.due(); await f.notifier.deliver();
  assert.deepEqual(f.pushes.map(row => row.tokens[0]), ['one', 'two', 'one']); assert.equal(f.mail.length, 1);
});
test('invalid registrations are cleared only on matched master accounts, then wait for a usable registration', async () => {
  const f = fixture(); f.users([{ id: 'master', email: 'master@example.test', isActive: true, deviceId: 'invalid-token' },
    { id: 'customer', email: 'other@example.test', isActive: true, deviceId: 'invalid-token' }]);
  f.invalid.add('invalid-token'); await f.notifier.deliver();
  assert.equal(f.currentUsers()[0].deviceId, null); assert.equal(f.currentUsers()[1].deviceId, 'invalid-token');
  assert.equal(f.rows[1].status, 'pending'); assert.equal(f.rows[1].sentAt, null);
});
test('long provider outages remain retryable beyond five attempts with bounded backoff', async () => {
  const f = fixture(); f.rows.forEach(row => { row.attempts = 20; }); f.failEmail(true); f.pushFailures.add('master-device');
  const before = Date.now(); await f.notifier.deliver();
  assert.ok(f.rows.every(row => row.status === 'pending' && row.attempts === 21));
  assert.ok(f.rows.every(row => row.nextAttemptAt.getTime() >= before + 3600000 && row.nextAttemptAt.getTime() <= Date.now() + 3600000));
});
test('another worker owns the lease and stale leases can be recovered', async () => {
  const f = fixture(); f.claimable(false); await f.notifier.deliver(); assert.equal(f.mail.length, 0); assert.equal(f.pushes.length, 0);
  f.claimable(true); f.rows.forEach(row => { row.leaseUntil = new Date(Date.now() - 1); }); await f.notifier.deliver();
  assert.ok(f.rows.every(row => row.status === 'sent' && row.leaseToken === null));
});
test('unrelated events and organizations undergoing cleanup never notify the master', async () => {
  const f = fixture(['signup', 'account_deletion', 'support_message']); f.rows.filter(row => row.alert.kind === 'support_message').forEach(row => { row.alert.tenant.deletionStartedAt = new Date(); });
  await f.notifier.deliver(); assert.equal(f.mail.length, 0); assert.equal(f.pushes.length, 0); assert.ok(f.rows.every(row => row.status === 'skipped'));
});
test('recipient policy rotation stops subsequent sends to devices resolved under the old policy', async () => {
  const f = fixture(); f.config({ email: 'master@example.test', origin: 'https://fundnesta.appnesta.com' });
  f.users(['one', 'two'].map(id => ({ id, email: 'master@example.test', isActive: true, verified: true, deviceId: id })));
  f.onPush(() => f.config({ email: 'new-master@example.test', origin: 'https://fundnesta.appnesta.com' }));
  await f.notifier.deliver(); assert.equal(f.pushes.length, 1); assert.equal(f.rows[1].status, 'pending');
});
test('master identity uses the existing email alias, ID pin and exact trusted web origin', () => {
  const names = ['MASTER_USER_EMAIL', 'Master_user_email', 'MASTER_USER_ID', 'MASTER_WEB_ORIGIN', 'NODE_ENV'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.MASTER_USER_EMAIL = ''; process.env.Master_user_email = ' MASTER@example.test '; process.env.MASTER_USER_ID = 'pinned'; process.env.MASTER_WEB_ORIGIN = 'https://fundnesta.appnesta.com';
    assert.deepEqual(masterAlertIdentity(), { email: 'master@example.test', userId: 'pinned', origin: 'https://fundnesta.appnesta.com' });
    process.env.MASTER_USER_EMAIL = 'configured@example.test'; assert.equal(masterAlertIdentity().email, 'configured@example.test');
    for (const origin of ['https://user:pass@example.test', 'https://example.test/path', 'https://example.test?token=secret', 'http://example.test']) {
      process.env.MASTER_WEB_ORIGIN = origin; assert.equal(masterAlertIdentity(), null);
    }
  } finally { for (const name of names) if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; }
});
test('request links contain only the request destination and no secrets', () => {
  const link = masterAlertLink({ kind: 'billing_payment', ticketId: null, tenantId: 'org', eventKey: 'billing_payment:invoice:proof' }, 'https://fundnesta.appnesta.com');
  assert.equal(link, 'https://fundnesta.appnesta.com/support/admin?tab=billing&organization=org&invoice=invoice');
  assert.doesNotMatch(link, /code|grant|token|proof/);
});
test('migration queues both channels atomically only for new support and billing alerts', () => {
  const sql = readFileSync(new URL('../prisma/migrations/20261025130000_master_request_alerts/migration.sql', import.meta.url), 'utf8');
  assert.match(sql, /AFTER INSERT ON "platform_alerts"/); assert.match(sql, /'support_message', 'billing_upgrade', 'billing_payment'/);
  assert.match(sql, /VALUES \('email'\), \('push'\)/); assert.match(sql, /ON CONFLICT \(alert_id, channel\) DO NOTHING/);
  assert.doesNotMatch(sql, /INSERT INTO master_alert_deliveries[^;]+FROM platform_alerts/s);
});
