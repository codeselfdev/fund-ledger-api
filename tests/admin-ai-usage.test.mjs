import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/no_database', JWT_SECRET: 'synthetic-ai-usage-test-secret' });
const { organizationAiUsage } = await import('../dist/modules/internal/ai-usage.service.js');
const contact = (plan, reset) => ({ subscription: { package: plan, status: 'active', ...(reset ? { quota_reset_at: reset } : {}) } });
test('AI reports use each organization allowance start and count all admitted statuses except cancelled', async () => {
  const calls = [], tenants = [{ id: 'starter', contact: contact('starter') }, { id: 'business', contact: contact('business', '2026-10-20T10:00:00Z') }, { id: 'unused', contact: contact('free') }];
  const db = { assistantReply: { async groupBy(query) {
    calls.push(query);
    return calls.length === 1 ? [{ tenantId: 'starter', channel: 'ai_chat', _count: 4 }, { tenantId: 'business', channel: 'ai_chat', _count: 7 }, { tenantId: 'business', channel: 'whatsapp_bot', _count: 2 }] : [{ tenantId: 'starter', _count: 33 }, { tenantId: 'business', _count: 99 }];
  } } };
  const result = await organizationAiUsage(tenants, db, new Date('2026-10-23T12:00:00Z'));
  assert.deepEqual(calls[0].where.OR, [{ tenantId: 'starter', periodStart: new Date('2026-10-01T00:00:00Z') }, { tenantId: 'business', periodStart: new Date('2026-10-20T10:00:00Z') }, { tenantId: 'unused', periodStart: new Date('2026-10-01T00:00:00Z') }]);
  assert.ok(calls.every(query => query.where.status.not === 'cancelled'));
  assert.deepEqual(calls[1].where.tenantId.in, ['starter', 'business', 'unused']);
  assert.equal(result.get('starter').used, 4); assert.equal(result.get('starter').lifetime_used, 33); assert.equal(result.get('starter').channels.ai_chat.limit, 100);
  assert.equal(result.get('business').used, 9); assert.equal(result.get('business').channels.whatsapp_bot.used, 2); assert.equal(result.get('business').resets_at, '2026-11-01T00:00:00.000Z');
  assert.equal(result.get('unused').used, 0); assert.equal(result.get('unused').lifetime_used, 0); assert.equal(result.get('unused').channels.ai_chat.limit, 10);
});
test('empty organization pages issue no usage queries', async () => {
  assert.equal((await organizationAiUsage([], { assistantReply: { groupBy() { assert.fail('No database query expected'); } } })).size, 0);
});
