import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/no_database', JWT_SECRET: 'synthetic-support-reply-test' });
const { queueSupportReply, createSupportReplyNotifier } = await import('../dist/modules/support/support-reply-notifications.service.js');
test('a team reply atomically targets the requester inbox and queues independent push/email deliveries', async () => {
  const writes = [], tx = { notification: { create: async value => writes.push(value) }, supportReplyDelivery: { createMany: async value => writes.push(value) } };
  await queueSupportReply(tx, { id: 'ticket', tenantId: 'org', requesterId: 'requester' }, { id: 'message', body: 'Your issue has been fixed.' });
  assert.equal(writes[0].data.recipientUserId, 'requester'); assert.equal(writes[0].data.tenantId, 'org');
  assert.equal(writes[0].data.type, 'support.replied'); assert.equal(writes[0].data.entityId, 'ticket');
  assert.deepEqual(writes[1].data.map(row => row.channel), ['push', 'email']);
});
test('support worker pushes a private thread destination to the requester and retries provider failure', async () => {
  const writes = [], pushes = [], row = { id: 'delivery', messageId: 'message', tenantId: 'org', channel: 'push', attempts: 0 };
  let fail = false;
  const db = {
    supportReplyDelivery: { async findMany() { return [row]; }, async updateMany(query) { writes.push(query); return { count: 1 }; } },
    supportMessage: { async findFirst(query) {
      assert.deepEqual(query.where, { id: 'message', tenantId: 'org', sender: 'team' });
      return { body: '', _count: { attachments: 1 }, ticket: { id: 'ticket', tenantId: 'org', requester: { tenantId: 'org', isActive: true, deviceId: 'requester-token' }, tenant: { deletionStartedAt: null } } };
    } }, user: { async updateMany() { assert.fail('No invalid token in this test'); } },
  };
  const service = createSupportReplyNotifier(db, { email: async () => true, push: async input => { pushes.push(input); if (fail) throw Error('Unavailable'); return { sent_count: 1, invalid_tokens: [] }; } });
  await service.deliver();
  assert.deepEqual(pushes[0].tokens, ['requester-token']); assert.match(pushes[0].body, /attachment/);
  assert.deepEqual(pushes[0].data, { type: 'support.replied', tenant_id: 'org', entity_type: 'support_ticket', entity_id: 'ticket' });
  assert.ok(writes.some(write => write.data.status === 'sent' && write.where.leaseToken));
  fail = true; await service.deliver();
  assert.ok(writes.some(write => write.data.status === 'pending' && write.data.lastError === 'provider_unavailable' && write.data.nextAttemptAt > new Date()));
});
