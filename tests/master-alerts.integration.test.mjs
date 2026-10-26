import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const database = process.env.MASTER_ALERT_TEST_DATABASE_URL;
test('PostgreSQL request triggers atomically enqueue both master channels and durable delivery survives retries', { skip: !database }, async t => {
  const url = new URL(database);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname, '/fundnesta_master_alerts_test', 'Use only the dedicated disposable test database');
  const schema = 'master_alerts_' + randomUUID().replaceAll('-', '');
  url.searchParams.set('schema', schema);
  Object.assign(process.env, { DATABASE_URL: url.toString(), JWT_SECRET: 'synthetic-master-alert-integration', NODE_ENV: 'test' });
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  t.after(async () => { await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await db.$disconnect(); });
  function statements(sql) {
    sql = sql.replace(/^\s*--.*$/gm, '');
    const result = []; let dollar = false, start = 0;
    for (let i = 0; i < sql.length; i++) {
      if (sql.slice(i, i + 2) === '$$') { dollar = !dollar; i++; }
      else if (sql[i] === ';' && !dollar) { const statement = sql.slice(start, i).trim(); if (statement) result.push(statement); start = i + 1; }
    }
    return result;
  }
  const prior = readFileSync(new URL('../prisma/migrations/20261016160000_platform_alerts_and_ai_images/migration.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../prisma/migrations/20261025130000_master_request_alerts/migration.sql', import.meta.url), 'utf8');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    await tx.$executeRawUnsafe('CREATE TABLE tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL, deletion_started_at TIMESTAMP(3))');
    for (const sql of statements(prior.slice(prior.indexOf('CREATE TABLE "platform_alerts"'), prior.indexOf('-- Events commit')))) await tx.$executeRawUnsafe(sql);
    await tx.$executeRawUnsafe("INSERT INTO tenants(id,name) VALUES ('customer-org','Synthetic customer')");
    await tx.$executeRawUnsafe("INSERT INTO platform_alerts(id,tenant_id,kind,event_key) VALUES ('old','customer-org','billing_upgrade','billing_upgrade:old')");
    for (const sql of statements(migration)) await tx.$executeRawUnsafe(sql);
    assert.equal((await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM master_alert_deliveries'))[0].count, 0, 'No historical notification flood');
    await tx.$executeRawUnsafe('CREATE TABLE support_tickets(id TEXT PRIMARY KEY, requester_id TEXT NOT NULL)');
    await tx.$executeRawUnsafe('CREATE TABLE support_messages(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,ticket_id TEXT NOT NULL,sender TEXT NOT NULL,request_key TEXT NOT NULL, UNIQUE(ticket_id,request_key))');
    for (const sql of statements(prior.slice(prior.indexOf('CREATE FUNCTION platform_support_alert')))) await tx.$executeRawUnsafe(sql);
    await tx.$executeRawUnsafe("INSERT INTO support_tickets VALUES ('ticket-1','customer-user')");
    for (let i = 0; i < 2; i++) await tx.$executeRawUnsafe("INSERT INTO support_messages VALUES ('message-1','customer-org','ticket-1','user','same-key') ON CONFLICT DO NOTHING");
    for (const kind of ['billing_upgrade', 'billing_payment']) for (let i = 0; i < 2; i++) await tx.$executeRawUnsafe(`INSERT INTO platform_alerts(id,tenant_id,kind,event_key) VALUES ('${kind}','customer-org','${kind}','${kind}:invoice-1') ON CONFLICT(event_key) DO UPDATE SET kind=excluded.kind`);
    await tx.$executeRawUnsafe("INSERT INTO support_messages VALUES ('team-message','customer-org','ticket-1','team','team-key')");
    assert.equal((await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM master_alert_deliveries'))[0].count, 6);
    await tx.$executeRawUnsafe('SAVEPOINT rollback_request');
    await tx.$executeRawUnsafe("INSERT INTO support_messages VALUES ('rolled-back','customer-org','ticket-1','user','rollback-key')");
    assert.equal((await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM master_alert_deliveries'))[0].count, 8);
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rollback_request');
    assert.equal((await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM master_alert_deliveries'))[0].count, 6);
  }, { timeout: 30000 });
  const { createMasterAlertNotifier } = await import('../dist/modules/internal/master-alerts.service.js');
  const messages = [];
  const notifier = createMasterAlertNotifier(db, { email: async message => { messages.push(message); return true; }, push: async () => assert.fail('No external push in this test') },
    { email: () => true, push: () => false }, () => ({ email: 'master@example.test', userId: 'master', origin: 'https://fundnesta.appnesta.com' }));
  await notifier.deliver(); await notifier.deliver();
  assert.equal(messages.length, 3); assert.ok(messages.every(message => message.to === 'master@example.test'));
  assert.equal(await db.masterAlertDelivery.count({ where: { channel: 'email', status: 'sent' } }), 3);
  assert.equal(await db.masterAlertDelivery.count({ where: { channel: 'push', status: 'pending', attempts: 0 } }), 3);
  assert.ok(messages.some(message => message.text.includes('tab=support&ticket=ticket-1')));
  assert.ok(messages.some(message => message.text.includes('tab=billing&organization=customer-org&invoice=invoice-1')));
});
