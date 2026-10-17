import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('isolated PostgreSQL: customer support reply inbox, push, email and retries',
  { skip: process.env.RUN_SUPPORT_REPLY_INTEGRATION !== 'true' }, async t => {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/fundnesta_support_reply_verify', 'Only the disposable database is allowed');
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { createApp } = await import('../dist/app.js');
  const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');
  const { createSupportReplyNotifier, queueSupportReply } = await import('../dist/modules/support/support-reply-notifications.service.js');
  const { tenantDeletionOrder } = await import('../dist/modules/internal/cleanup.service.js');
  const tenant = await prisma.tenant.create({ data: { name: 'Synthetic support organization', slug: `reply-${randomUUID()}`,
    contact: { subscription: { status: 'expired', package: 'business', billing_cycle: 'monthly', current_period_end_at: '2025-01-01T00:00:00.000Z' } } } });
  async function customer(name, mobile, extra = {}) {
    const user = await prisma.user.create({ data: { tenantId: tenant.id, name, mobile, ...extra } });
    const id = randomUUID(), token = signAccessToken({ tenantId: tenant.id, userId: user.id, sessionId: id });
    await prisma.session.create({ data: { id, tenantId: tenant.id, userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 86400000) } });
    return { user, headers: { Authorization: `Bearer ${token}` } };
  }
  const requester = await customer('Synthetic requester', '+8801700000011', { email: 'customer@example.test', deviceId: 'synthetic-device-token' });
  const other = await customer('Synthetic other customer', '+8801700000012', { email: 'other@example.test', deviceId: 'other-synthetic-device-token' });
  const internal = { 'x-internal-api-key': process.env.INTERNAL_API_KEY, 'x-internal-actor': 'synthetic-support-agent' };
  const server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  async function message(path, headers, fields, screenshot = false) {
    const form = new FormData(); for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (screenshot) form.append('files', new Blob([png], { type: 'image/png' }), 'synthetic.png');
    const response = await fetch(base + path, { method: 'POST', headers, body: form });
    return { status: response.status, ...await response.json() };
  }
  async function api(path, headers = requester.headers, method = 'GET') {
    const response = await fetch(base + path, { method, headers }); return { status: response.status, ...await response.json() };
  }
  async function newTicket(who = requester) {
    const result = await message('/support/tickets', who.headers, { request_key: randomUUID(), subject: 'Synthetic support question', body: 'Please help' });
    assert.equal(result.status, 201, JSON.stringify(result)); return result.data.ticket.id;
  }
  async function reply(ticket, body = 'Your issue has been fixed.', screenshot = false, request_key = randomUUID()) {
    const result = await message(`/internal/support/tickets/${ticket}/messages`, internal, { request_key, body }, screenshot);
    assert.equal(result.status, 201, JSON.stringify(result)); return result.data;
  }
  const push = [], email = []; let failEmail = true, failPush = false;
  const notifier = createSupportReplyNotifier(prisma, {
    push: async input => { if (failPush) throw Error('Synthetic push outage'); push.push(input); return { sent_count: 1, failed_count: 0, skipped: false, invalid_tokens: [] }; },
    email: async input => { if (failEmail) throw Error('Synthetic mail outage'); email.push(input); return true; },
  });
  const pending = () => prisma.supportReplyDelivery.updateMany({ where: { tenantId: tenant.id, status: 'pending' }, data: { nextAttemptAt: new Date(0) } });
  const deliveries = messageId => prisma.supportReplyDelivery.findMany({ where: { messageId }, orderBy: { channel: 'asc' } });
  let ticket, first;
  try {
    await t.test('team reply atomically queues one customer inbox item and two channels; customer messages and request replays do not duplicate them', async () => {
      ticket = await newTicket();
      assert.equal(await prisma.notification.count({ where: { tenantId: tenant.id } }), 0);
      assert.equal(await prisma.supportReplyDelivery.count({ where: { tenantId: tenant.id } }), 0);
      const key = randomUUID(); first = await reply(ticket, 'Your issue has been fixed.', false, key);
      const replay = await reply(ticket, 'Your issue has been fixed.', false, key); assert.equal(replay.replayed, true);
      assert.equal(first.message.id, replay.message.id);
      const inbox = await prisma.notification.findMany({ where: { tenantId: tenant.id } });
      assert.equal(inbox.length, 1); assert.equal(inbox[0].recipientUserId, requester.user.id);
      assert.equal(inbox[0].projectId, null); assert.equal(inbox[0].type, 'support.replied'); assert.equal(inbox[0].entityId, ticket);
      assert.deepEqual((await deliveries(first.message.id)).map(row => row.channel), ['email', 'push']);
      const followup = await message(`/support/tickets/${ticket}/messages`, requester.headers, { request_key: randomUUID(), body: 'Thank you' }); assert.equal(followup.status, 201);
      assert.equal(await prisma.notification.count({ where: { tenantId: tenant.id } }), 1);
      assert.equal(await prisma.supportReplyDelivery.count({ where: { tenantId: tenant.id } }), 2);
    });
    await t.test('push succeeds during email outage; a later email retry never resends the successful push', async () => {
      await notifier.deliver(); assert.equal(push.length, 1); assert.equal(email.length, 0);
      assert.deepEqual(push[0].tokens, ['synthetic-device-token']);
      assert.deepEqual(push[0].data, { type: 'support.replied', tenant_id: tenant.id, entity_type: 'support_ticket', entity_id: ticket });
      let rows = await deliveries(first.message.id);
      assert.equal(rows.find(r => r.channel === 'push').status, 'sent'); assert.equal(rows.find(r => r.channel === 'email').status, 'pending');
      failEmail = false; await pending(); await notifier.deliver(); await notifier.deliver();
      assert.equal(push.length, 1); assert.equal(email.length, 1); assert.equal(email[0].to, 'customer@example.test');
      assert.match(email[0].text, /Your issue has been fixed/); assert.match(email[0].text, /fundnesta:\/\/support\?ticket_id=/);
      assert.ok(!email[0].attachments); assert.ok((await deliveries(first.message.id)).every(r => r.status === 'sent'));
    });
    await t.test('expired customers without a project can read inbox replies and register push tokens; only the requester can read/acknowledge the thread', async () => {
      let result = await api('/notifications'); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.length, 1);
      assert.equal((await api('/notifications', other.headers)).data.length, 0);
      assert.equal((await api(`/support/tickets/${ticket}`, other.headers)).status, 404);
      assert.equal((await api(`/notifications/${result.data[0].id}/read`, other.headers, 'PATCH')).status, 404);
      assert.equal((await api(`/support/tickets/${ticket}/read`, requester.headers, 'POST')).status, 200);
      result = await api('/notifications'); assert.ok(result.data[0].readAt);
      const registered = await fetch(base + '/notifications/device-token', { method: 'POST', headers: { ...requester.headers, 'content-type': 'application/json' }, body: JSON.stringify({ fcm_token: 'synthetic-device-token-renewed' }) });
      assert.equal(registered.status, 200);
      assert.equal((await api('/accounts', requester.headers)).status, 402, 'Financial subscription restrictions must remain in place');
    });
    await t.test('attachment-only replies notify the customer and concurrent workers claim each channel once', async () => {
      const sent = await reply(ticket, '', true), beforePush = push.length, beforeEmail = email.length;
      await Promise.all([notifier.deliver(), notifier.deliver()]);
      assert.equal(push.length, beforePush + 1); assert.equal(email.length, beforeEmail + 1);
      assert.match(push.at(-1).body, /attachment/); assert.match(email.at(-1).text, /1 screenshot/);
      assert.doesNotMatch(email.at(-1).text, /storage|\.png|https?:\/\//);
      assert.ok((await deliveries(sent.message.id)).every(r => r.status === 'sent'));
    });
    await t.test('missing email/device skips only those channels and still creates the in-app notification', async () => {
      const offline = await customer('Synthetic offline customer', '+8801700000013');
      const thread = await newTicket(offline), sent = await reply(thread), beforePush = push.length, beforeEmail = email.length;
      await notifier.deliver();
      assert.equal(push.length, beforePush); assert.equal(email.length, beforeEmail);
      assert.deepEqual((await deliveries(sent.message.id)).map(r => [r.channel, r.status, r.lastError]), [['email', 'skipped', 'no_email_address'], ['push', 'skipped', 'no_registered_device']]);
      assert.equal((await api('/notifications', offline.headers)).data[0].entityId, thread);
    });
    await t.test('provider failures retry independently with a five-attempt cap while preserving the inbox item', async () => {
      const sent = await reply(ticket, 'Retryable support reply'); failEmail = true; failPush = true;
      for (let i = 0; i < 5; i++) { await pending(); await notifier.deliver(); }
      const rows = await deliveries(sent.message.id); assert.ok(rows.every(row => row.status === 'failed' && row.attempts === 5 && row.lastError === 'provider_unavailable'));
      await pending(); await notifier.deliver(); assert.ok((await deliveries(sent.message.id)).every(row => row.attempts === 5));
      assert.equal(await prisma.notification.count({ where: { id: `support-reply:${sent.message.id}` } }), 1);
      failEmail = false; failPush = false;
    });
    await t.test('unexpired worker leases block duplicates; expired leases recover after a worker crash', async () => {
      const sent = await reply(ticket), before = push.length;
      await prisma.supportReplyDelivery.updateMany({ where: { messageId: sent.message.id, channel: 'push' }, data: { leaseUntil: new Date(Date.now() + 60000), leaseToken: 'crashed-worker' } });
      await notifier.deliver(); assert.equal(push.length, before);
      await prisma.supportReplyDelivery.updateMany({ where: { messageId: sent.message.id, channel: 'push' }, data: { leaseUntil: new Date(0) } });
      await notifier.deliver(); assert.equal(push.length, before + 1);
      assert.ok((await deliveries(sent.message.id)).every(row => row.status === 'sent' && !row.leaseToken));
    });
    await t.test('transaction rollback leaves no phantom message, inbox entry or outbound delivery', async () => {
      let id;
      await assert.rejects(prisma.$transaction(async tx => {
        const message = await tx.supportMessage.create({ data: { tenantId: tenant.id, ticketId: ticket, requestKey: randomUUID(), payloadHash: 'synthetic', sender: 'team', author: 'Team', body: 'Must roll back' } }); id = message.id;
        await queueSupportReply(tx, { id: ticket, tenantId: tenant.id, requesterId: requester.user.id }, message); throw Error('Synthetic rollback');
      }), /Synthetic rollback/);
      assert.equal(await prisma.supportMessage.count({ where: { id } }), 0);
      assert.equal(await prisma.notification.count({ where: { id: `support-reply:${id}` } }), 0);
      assert.equal(await prisma.supportReplyDelivery.count({ where: { messageId: id } }), 0);
    });
    await t.test('a crash on the final attempt is reported as failed instead of leaving a permanently pending delivery', async () => {
      const sent = await reply(ticket), beforePush = push.length, beforeEmail = email.length;
      await prisma.supportReplyDelivery.updateMany({ where: { messageId: sent.message.id }, data: { attempts: 5, leaseUntil: new Date(0), leaseToken: 'crashed-final-attempt' } });
      await notifier.deliver();
      assert.equal(push.length, beforePush); assert.equal(email.length, beforeEmail);
      assert.ok((await deliveries(sent.message.id)).every(row => row.status === 'failed' && row.lastError === 'retry_limit_reached' && !row.leaseToken));
    });
    await t.test('invalid old tokens do not erase a newer registration; cleanup includes the outbox and stops customer delivery', async () => {
      const sent = await reply(ticket), old = (await prisma.user.findUnique({ where: { id: requester.user.id } })).deviceId;
      const invalid = createSupportReplyNotifier(prisma, { email: async () => true, push: async () => {
        await prisma.user.update({ where: { id: requester.user.id }, data: { deviceId: 'newer-synthetic-device-token' } });
        return { sent_count: 0, failed_count: 1, skipped: false, invalid_tokens: [old] };
      } });
      await invalid.deliver();
      assert.equal((await prisma.user.findUnique({ where: { id: requester.user.id } })).deviceId, 'newer-synthetic-device-token');
      assert.equal((await deliveries(sent.message.id)).find(r => r.channel === 'push').lastError, 'invalid_device_token');
      const queued = await reply(ticket), beforePush = push.length, beforeEmail = email.length;
      await prisma.tenant.update({ where: { id: tenant.id }, data: { deletionStartedAt: new Date() } });
      await notifier.deliver(); assert.equal(push.length, beforePush); assert.equal(email.length, beforeEmail);
      assert.ok((await deliveries(queued.message.id)).every(row => row.status === 'skipped' && row.lastError === 'recipient_unavailable'));
      const order = tenantDeletionOrder(); assert.ok(order.includes('SupportReplyDelivery')); assert.ok(order.indexOf('SupportReplyDelivery') < order.indexOf('SupportMessage'));
    });
  } finally {
    await new Promise(resolve => server.close(resolve)); await prisma.$disconnect();
  }
});
