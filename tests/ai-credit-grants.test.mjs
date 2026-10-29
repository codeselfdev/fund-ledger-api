import { fixtureTransactionClient, installAccountReadFixtures, installAccountRelationFixtures, installSubscriptionReadFixtures } from './helpers/normalized-fixtures.mjs';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
Object.assign(process.env, { DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test', JWT_SECRET: 'ai-grant-isolated-tests-only' });
const { prisma } = await import('../dist/core/prisma/client.js');
const { grantAiCredits, aiCreditGrantSchema, aiCreditTenants, aiCreditHistory } = await import('../dist/modules/internal/ai-credits.service.js');
const { featureLimit, allowancePeriod, hasAssistant, extraFeatureCredits } = await import('../dist/modules/assistant/assistant.policy.js');
const { reserveReply, assistantStatus } = await import('../dist/modules/assistant/assistant.service.js');
let tenants, audits, replies, queue, inbox, deliveries;
const contact = plan => ({ subscription: { package: plan, status: plan === 'free' ? 'trial' : 'active', trial_ends_at: '2099-01-01T00:00:00Z', current_period_end_at: plan === 'free' ? null : '2099-01-01T00:00:00Z' } });
const input = (extra = {}) => ({ request_key: randomUUID(), channel: 'ai_chat', credits: 25, reason: 'Customer extension approved', period_start: allowancePeriod(tenants.org.contact).start.toISOString(), ...extra });
beforeEach(() => {
 tenants = Object.fromEntries(['org', 'other'].map(id => [id, { id, name: id, createdAt: new Date('2026-10-01T00:00:00Z'), contact: contact('free'), deletionStartedAt: null }])); audits = []; replies = []; inbox = []; deliveries = []; queue = Promise.resolve();
 prisma.$transaction = callback => { const task = queue.then(async () => { const old = structuredClone({ tenants, audits, replies, inbox, deliveries }); try { return await callback(fixtureTransactionClient(prisma)); } catch (error) { ({ tenants, audits, replies, inbox, deliveries } = old); throw error; } }); queue = task.catch(() => {}); return task; };
 prisma.$queryRaw = async () => [];
 prisma.user.findFirst = async () => null; prisma.user.findMany = async () => [];
 prisma.tenant.findMany = async () => [];
 prisma.notification.create = async ({ data }) => { inbox.push(data); return data; };
 prisma.aiCreditDelivery.createMany = async ({ data }) => { deliveries.push(...data.map(row=>({...row,status:'pending',lastError:null}))); return { count:data.length }; };
 prisma.aiCreditDelivery.findMany = async ({ where }) => deliveries.filter(row=>row.tenantId===where.tenantId&&where.notificationId.in.includes(row.notificationId));
 prisma.tenant.findUnique = async ({ where }) => tenants[where.id] ?? null;
 prisma.tenant.findUniqueOrThrow = async ({ where }) => { if (!tenants[where.id]) throw Error('Missing tenant'); return tenants[where.id]; };
 prisma.tenant.update = async ({ where, data }) => tenants[where.id] = { ...tenants[where.id], ...data };
 prisma.internalAudit.findFirst = async ({ where }) => audits.find(row => row.tenantId === where.tenantId && row.action === where.action && row.metadata.request_key === where.metadata.equals);
 prisma.internalAudit.create = async ({ data }) => { const row = { id: String(audits.length), createdAt: new Date(), ...data }; audits.push(row); return row; };
 prisma.internalAudit.findMany = async ({ where, skip, take }) => audits.filter(row => row.tenantId === where.tenantId && row.action === where.action).reverse().slice(skip, skip + take);
 prisma.assistantReply.findUnique = async ({ where }) => replies.find(row => Object.entries(where.tenantId_channel_requestKey).every(([key, value]) => row[key] === value));
 prisma.assistantReply.count = async ({ where }) => replies.filter(row => row.tenantId === where.tenantId && row.channel === where.channel && row.periodStart.getTime() === where.periodStart.getTime() && row.status !== 'cancelled').length;
 prisma.assistantReply.create = async ({ data }) => { const row = { id: String(replies.length), ...data }; replies.push(row); return row; };
 prisma.assistantReply.groupBy = async () => [];
installAccountReadFixtures(prisma);
installSubscriptionReadFixtures(prisma);
installAccountRelationFixtures(prisma);
});
after(() => prisma.$disconnect());

test('grant increases only the selected tenant and channel, preserves contact and records the actor and reason', async () => {
 tenants.org.contact.company = { registration: 'preserved' };
 const grant = await grantAiCredits('org', input(), 'admin@example.test');
 assert.equal(grant.limit, 35); assert.equal(featureLimit('ai_chat', tenants.org.contact), 35); assert.equal(featureLimit('ai_chat', tenants.other.contact), 10);
 assert.equal(featureLimit('whatsapp_bot', tenants.org.contact), 0); assert.deepEqual(tenants.org.contact.company, { registration: 'preserved' });
 assert.equal(audits[0].actor, 'admin@example.test'); assert.equal(audits[0].metadata.reason, 'Customer extension approved'); assert.equal(audits[0].metadata.previous_limit, 10);
});
test('concurrent grants add up and retries are idempotent even after period rollover', async () => {
 const first = input();
 const results = await Promise.all([grantAiCredits('org', first, 'admin'), grantAiCredits('org', first, 'admin'), grantAiCredits('org', input({ credits: 7 }), 'admin')]);
 assert.equal(results[1].replayed, true); assert.equal(featureLimit('ai_chat', tenants.org.contact), 42); assert.equal(audits.length, 2);
 await assert.rejects(grantAiCredits('org', { ...first, credits: 99 }, 'admin'), /different data/);
 tenants.org.contact.subscription.quota_reset_at = new Date().toISOString();
 assert.equal((await grantAiCredits('org', first, 'admin')).replayed, true);
 assert.equal(extraFeatureCredits('ai_chat', tenants.org.contact), 0);
});
test('quota enforcement and customer status use extra credits across projects, without resetting usage', async () => {
 const base = { tenantId: 'org', projectId: 'p1', userId: 'user', channel: 'ai_chat', prompt: 'Test' };
 for (let i = 0; i < 10; i++) await reserveReply({ ...base, requestKey: String(i) });
 await assert.rejects(reserveReply({ ...base, requestKey: 'blocked' }), error => error.statusCode === 429);
 await grantAiCredits('org', input({ credits: 2 }), 'admin');
 prisma.assistantReply.groupBy = async () => [{ channel: 'ai_chat', _count: replies.length }];
 const status = await assistantStatus('org'); assert.equal(status.features.ai_chat.limit, 12); assert.equal(status.features.ai_chat.used, 10);
 await reserveReply({ ...base, projectId: 'p2', requestKey: 'extra-1' }); await reserveReply({ ...base, requestKey: 'extra-2' });
 await assert.rejects(reserveReply({ ...base, requestKey: 'blocked-again' }), error => error.statusCode === 429);
 assert.equal(replies.length, 12);
});
test('grants expire by month and package reset, with fixed limits for other periods', async () => {
 const now = new Date('2026-10-24T12:00:00Z'), c = { ...contact('starter'), ai_credit_extension: { period_start: '2026-10-01T00:00:00.000Z', ai_chat: 80, whatsapp_bot: 0 } };
 assert.equal(featureLimit('ai_chat', c, now), 180); assert.equal(featureLimit('ai_chat', c, new Date('2026-11-01T00:00:00Z')), 100);
 c.subscription.quota_reset_at = '2026-10-23T12:00:00Z'; assert.equal(featureLimit('ai_chat', c, now), 100);
 for (const value of [-1, 1.5, '100', Number.MAX_SAFE_INTEGER]) { c.ai_credit_extension = { period_start: allowancePeriod(c, now).start.toISOString(), ai_chat: value }; assert.equal(featureLimit('ai_chat', c, now), 100); }
});
test('invalid requests, missing/frozen tenants, stale periods and ineligible channels fail closed', async () => {
 for (const values of [{ credits: 0 }, { credits: -1 }, { credits: 1.5 }, { credits: 1000001 }, { credits: '10' }, { reason: '  ' }, { channel: 'telegram' }, { unexpected: true }]) assert.equal(aiCreditGrantSchema.safeParse(input(values)).success, false);
 await assert.rejects(grantAiCredits('missing', input(), 'admin'), /not found/);
 tenants.org.deletionStartedAt = new Date(); await assert.rejects(grantAiCredits('org', input(), 'admin'), /cleanup/); tenants.org.deletionStartedAt = null;
 await assert.rejects(grantAiCredits('org', input({ period_start: '2000-01-01T00:00:00.000Z' }), 'admin'), /period changed/);
 await assert.rejects(grantAiCredits('org', input({ channel: 'whatsapp_bot' }), 'admin'), /eligible plan/);
 tenants.org.contact.subscription.trial_ends_at = '2000-01-01T00:00:00Z'; await assert.rejects(grantAiCredits('org', input(), 'admin'), /eligible plan/);
 assert.equal(audits.length, 0);
});
test('custom active customers gain only explicitly granted channels; business channels remain independent', async () => {
 tenants.org.contact = contact('custom'); assert.equal(hasAssistant(tenants.org.contact), false);
 await grantAiCredits('org', input(), 'admin'); assert.equal(hasAssistant(tenants.org.contact), true); assert.equal(hasAssistant(tenants.org.contact, 'whatsapp_bot'), false);
 tenants.org.contact = contact('business'); await grantAiCredits('org', input({ channel: 'whatsapp_bot', credits: 20 }), 'admin');
 assert.equal(featureLimit('whatsapp_bot', tenants.org.contact), 1020); assert.equal(featureLimit('ai_chat', tenants.org.contact), 1000);
});
test('an audit write failure rolls the quota update back', async () => {
 prisma.internalAudit.create = async () => { throw Error('Audit unavailable'); };
 await assert.rejects(grantAiCredits('org', input(), 'admin'), /Audit unavailable/); assert.equal(featureLimit('ai_chat', tenants.org.contact), 10);
});
test('usage listing and extension history scope and paginate results', async () => {
 let query;
 prisma.tenant.findMany = async args => { query = args; return Array.from({ length: 101 }, (_, i) => ({ ...tenants.org, id: String(i), name: 'Tenant', slug: 'tenant', users: [{ name: 'Owner', email: 'owner@example.test' }] })); };
 const page = await aiCreditTenants(50, 'owner@example.test'); assert.equal(query.skip, undefined); assert.equal(query.take, undefined); assert.ok(query.where.OR[2].users.some.identity.OR[1].email); assert.equal(page.tenants.length, 50); assert.equal(page.next_offset, 100);
 for (let i = 0; i < 21; i++) await grantAiCredits('org', input(), 'admin');
 const history = await aiCreditHistory('org', 0); assert.equal(history.grants.length, 20); assert.equal(history.next_offset, 20); assert.equal(history.grants[0].actor, 'admin');
 assert.equal((await aiCreditHistory('other', 0)).grants.length, 0); await assert.rejects(aiCreditHistory('missing', 0), /not found/);
});


test('internal routes require an internal key and actor, validate grants, and expose scoped history', async () => {
 const { default: express } = await import('express');
 const { internalRouter } = await import('../dist/modules/internal/internal.routes.js');
 const { errorHandler } = await import('../dist/core/http/error-handler.js');
 const { env } = await import('../dist/config/env.js');
 const oldKey = env.internalApiKey; env.internalApiKey = 'synthetic-internal-credit-tests-1234567890';
 const app = express(); app.use(express.json()); app.use('/internal', internalRouter); app.use(errorHandler);
 const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
 const url = `http://127.0.0.1:${server.address().port}/internal/tenants/org/ai-credits`;
 const headers = { 'Content-Type': 'application/json', 'x-internal-api-key': env.internalApiKey, 'x-internal-actor': 'admin@example.test' };
 const grant = input();
 try {
  assert.equal((await fetch(url)).status, 401);
  const listUrl=url.replace('/tenants/org/ai-credits','/ai-credits');
  const sorted=await fetch(listUrl+'?sort=ai_chat&direction=asc',{headers});assert.equal(sorted.status,200);assert.equal((await sorted.json()).data.direction,'asc');
  assert.equal((await fetch(listUrl+'?sort=untrusted',{headers})).status,400);
  assert.equal((await fetch(listUrl+'?direction=untrusted',{headers})).status,400);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'x-internal-actor': '' }, body: JSON.stringify(grant) })).status, 400);
  const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify(grant) }); assert.equal(saved.status, 200); assert.equal((await saved.json()).data.limit, 35);
  const replay = await fetch(url, { method: 'POST', headers, body: JSON.stringify(grant) }); assert.equal((await replay.json()).data.replayed, true);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...grant, credits: -10 }) })).status, 400);
  const history = await fetch(url, { headers }); assert.equal(history.status, 200); assert.equal((await history.json()).data.grants[0].actor, 'admin@example.test');
 } finally { await new Promise(resolve => server.close(resolve)); env.internalApiKey = oldKey; }
});


test('one grant atomically queues its owner notification, and replay never grants or notifies twice',async()=>{
 prisma.user.findFirst=async({where})=>{assert.equal(where.tenantId,'org');assert.equal(where.memberships.some.role,'owner');return{id:'owner'};};
 installAccountReadFixtures(prisma);
 const grant=input(),first=await grantAiCredits('org',grant,'admin');await grantAiCredits('org',grant,'admin');
 assert.equal(inbox.length,1);assert.equal(deliveries.length,2);assert.equal(first.notification_id,inbox[0].id);assert.equal(audits.length,1);assert.equal(featureLimit('ai_chat',tenants.org.contact),35);
 assert.equal(inbox[0].recipientUserId,'owner');assert.doesNotMatch(inbox[0].body,/Customer extension approved/);
 const history=await aiCreditHistory('org',0);assert.equal(history.grants[0].delivery.push.status,'pending');assert.equal(history.grants[0].delivery.email.status,'pending');
 prisma.internalAudit.create=async()=>{throw Error('Audit unavailable');};await assert.rejects(grantAiCredits('org',input(),'admin'),/Audit unavailable/);assert.equal(inbox.length,1);assert.equal(deliveries.length,2);assert.equal(featureLimit('ai_chat',tenants.org.contact),35);
});
test('usage sorting is global, includes zero usage, and paginates in a stable order for every count column',async()=>{
 const rows=Array.from({length:103},(_,i)=>({...tenants.org,id:`t${String(i).padStart(3,'0')}`,slug:`tenant-${i}`}));
 prisma.tenant.findMany=async()=>rows.map(row=>({...row}));
 prisma.assistantReply.groupBy=async query=>{assert.equal(query.where.status.not,'cancelled');return query.by.includes('channel')?rows.filter((_,i)=>i>0).flatMap((row,i)=>[{tenantId:row.id,channel:'ai_chat',_count:i+1},{tenantId:row.id,channel:'whatsapp_bot',_count:103-i}]):rows.filter((_,i)=>i>0).map((row,i)=>({tenantId:row.id,_count:(i+1)*2}));};
 let page=await aiCreditTenants(0,undefined,'ai_chat','desc');assert.equal(page.tenants[0].id,'t102');assert.equal(page.tenants.length,50);assert.equal(page.next_offset,50);
 const second=await aiCreditTenants(50,undefined,'ai_chat','desc');assert.equal(second.tenants[0].id,'t052');assert.ok(!second.tenants.some(t=>page.tenants.some(first=>first.id===t.id)));
 page=await aiCreditTenants(0,undefined,'ai_chat','asc');assert.equal(page.tenants[0].id,'t000');assert.equal(page.tenants[1].id,'t001');
 page=await aiCreditTenants(0,undefined,'whatsapp_bot','desc');assert.equal(page.tenants[0].id,'t001');
 page=await aiCreditTenants(0,undefined,'lifetime_used','desc');assert.equal(page.tenants[0].id,'t102');
 page=await aiCreditTenants(0,undefined,'used','asc');assert.equal(page.tenants[0].id,'t000');assert.equal(page.tenants[1].id,'t102');
});
