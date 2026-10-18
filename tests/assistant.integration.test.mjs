import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
const url = process.env.QUOTA_TEST_DATABASE_URL;
test('Business AI Chat and WhatsApp Bot integration', { skip: !url }, async t => {
  Object.assign(process.env, { DATABASE_URL: url, NODE_ENV: 'production', JWT_SECRET: 'assistant-isolated-secret', AI_CHAT_ENABLED: 'true', OPENAI_API_KEY: 'test-key-never-sent', OPENAI_CHAT_MODEL: 'test-model', WHATSAPP_ENABLED: 'true', WHATSAPP_APP_SECRET: 'test-meta-secret', WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify' });
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { createThreeMonthTrial, renewTenantSubscription } = await import('../dist/core/subscription/subscription.service.js');
  const { assistantStatus, reserveReply } = await import('../dist/modules/assistant/assistant.service.js');
  const { assistantContext } = await import('../dist/modules/assistant/assistant.context.js');
  const { monthlyPeriod } = await import('../dist/modules/assistant/assistant.policy.js');
  const { assistantRouter } = await import('../dist/modules/assistant/assistant.routes.js');
  const { whatsappBotWebhookRouter } = await import('../dist/modules/assistant/whatsapp-bot.routes.js');
  const { runAssistantJobs } = await import('../dist/modules/assistant/assistant.worker.js');
  const { connectWhatsApp } = await import('../dist/core/whatsapp/whatsapp.service.js');
  const { errorHandler } = await import('../dist/core/http/error-handler.js');
  const originalFetch = globalThis.fetch;
  const providerInputs = [], delivered = [];
  let providerFails = false;
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(options.body); providerInputs.push(body);
      if (providerFails) return Response.json({ error: 'provider unavailable' }, { status: 503 });
      return Response.json({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'Your authorized project balance is available in the ledger.' }] }] });
    }
    if (String(url).startsWith('https://graph.facebook.com/')) {
      if (options.method === 'POST') { delivered.push(JSON.parse(options.body)); return Response.json({ messages: [{ id: 'sent-test' }] }); }
      return Response.json({ display_phone_number: 'Test business', verified_name: 'Test' });
    }
    return originalFetch(url, options);
  };
  const prefix = `assistant-test-${randomUUID()}`, orgs = [];
  async function org(plan = 'business', paid = true) {
    const trial = { subscription: createThreeMonthTrial() };
    const contact = paid ? renewTenantSubscription(trial, new Date(), { package: plan, billing_cycle: 'yearly' }).contact : { subscription: { ...trial.subscription, package: plan } };
    const tenant = await prisma.tenant.create({ data: { name: prefix, slug: `${prefix}-${orgs.length}`, contact } }); orgs.push(tenant.id);
    const project = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Authorized project', totalShares: 1 } });
    const user = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Owner', mobile: '+8801712345678' } });
    await prisma.projectMembership.create({ data: { tenantId: tenant.id, projectId: project.id, userId: user.id, role: 'owner' } });
    return { tenant, project, user };
  }
  let server;
  try {
    await t.test('only active paid Business unlocks allowances; caps are separate and reset monthly', async () => {
      for (const [plan, paid, enabled] of [['free', false, false], ['starter', true, false], ['business', false, false], ['business', true, true]]) {
        const a = await org(plan, paid), status = await assistantStatus(a.tenant.id);
        assert.equal(status.features.ai_chat.enabled, enabled); assert.equal(status.features.whatsapp_bot.enabled, enabled);
        assert.equal(status.features.ai_chat.limit, 1000); assert.equal(status.features.whatsapp_bot.limit, 1000);
        if (!enabled) await assert.rejects(reserveReply({ tenantId: a.tenant.id, projectId: a.project.id, userId: a.user.id, channel: 'ai_chat', requestKey: randomUUID(), prompt: 'Hello' }), /active paid Business/);
      }
      const a = await org(), month = monthlyPeriod();
      await prisma.assistantReply.createMany({ data: Array.from({ length: 999 }, (_, i) => ({ tenantId: a.tenant.id, projectId: a.project.id, userId: a.user.id, channel: 'ai_chat', requestKey: `old-${i}`, promptHash: 'test', prompt: 'Test', reply: 'Test', status: 'completed', periodStart: month.start })) });
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => reserveReply({ tenantId: a.tenant.id, projectId: a.project.id, userId: a.user.id, channel: 'ai_chat', requestKey: randomUUID(), prompt: 'Test' })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const status = await assistantStatus(a.tenant.id); assert.equal(status.features.ai_chat.used, 1000); assert.equal(status.features.whatsapp_bot.used, 0);
      assert.equal((await assistantStatus(a.tenant.id, month.end)).features.ai_chat.used, 0);
    });
    await t.test('context never crosses a project and denies member bot access', async () => {
      const a = await org(), foreign = await prisma.project.create({ data: { tenantId: a.tenant.id, name: 'Private foreign project', totalShares: 1 } });
      await prisma.account.create({ data: { tenantId: a.tenant.id, projectId: a.project.id, name: 'Cash', type: 'cash', balance: 42 } });
      await prisma.account.create({ data: { tenantId: a.tenant.id, projectId: foreign.id, name: 'Secret', type: 'cash', balance: 999999 } });
      const member = await prisma.user.create({ data: { tenantId: a.tenant.id, name: 'Member', mobile: '+8801712000000' } });
      await prisma.projectMembership.create({ data: { tenantId: a.tenant.id, projectId: a.project.id, userId: member.id, role: 'member' } });
      assert.equal((await assistantContext(a.tenant.id, a.project.id, a.user.id)).account_balance, 42);
      await assert.rejects(assistantContext(a.tenant.id, a.project.id, member.id), /not permitted to query/);
      await assert.rejects(assistantContext(a.tenant.id, foreign.id, member.id), /access is no longer active/);
    });
    const a = await org();
    const app = express(); app.use('/webhook', express.raw({ type: 'application/json' }), whatsappBotWebhookRouter); app.use(express.json());
    app.use((req, _res, next) => { req.auth = { tenantId: a.tenant.id, projectId: a.project.id, userId: req.header('x-user') ?? a.user.id, roles: ['owner'], memberId: null }; next(); });
    app.use('/assistant', assistantRouter); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await t.test('chat answers are idempotent, history is caller scoped, and failed provider calls release allowance', async () => {
      const key = randomUUID(), send = (message, requestKey = key, extra = {}) => fetch(base + '/assistant/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify({ message, request_key: requestKey }) });
      const before = providerInputs.length;
      let response = await send('What is our balance?'); assert.equal(response.status, 200); const saved = (await response.json()).data; assert.equal(saved.status, 'completed'); assert.ok(saved.reply);
      response = await send('What is our balance?'); assert.equal(response.status, 200); assert.equal(providerInputs.length, before + 1);
      assert.equal(providerInputs.at(-1).store, false); assert.equal(providerInputs.at(-1).model, 'test-model');
      response = await send('Different prompt', key); assert.equal(response.status, 409);
      response = await fetch(base + '/assistant/messages', { headers: { 'x-user': 'foreign-user' } }); assert.equal(response.status, 403);
      const other = await prisma.user.create({ data: { tenantId: a.tenant.id, name: 'Other', mobile: 'other' } });
      await prisma.projectMembership.create({ data: { tenantId: a.tenant.id, projectId: a.project.id, userId: other.id, role: 'member' } });
      response = await fetch(base + '/assistant/messages', { headers: { 'x-user': other.id } }); assert.equal(response.status, 403);
      await prisma.projectMembership.updateMany({ where: { tenantId: a.tenant.id, projectId: a.project.id, userId: a.user.id }, data: { role: 'member' } });
      response = await fetch(base + '/assistant/messages'); assert.equal(response.status, 403);
      response = await send('What is our balance?'); assert.equal(response.status, 403);
      await prisma.projectMembership.updateMany({ where: { tenantId: a.tenant.id, projectId: a.project.id, userId: a.user.id }, data: { role: 'owner' } });
      providerFails = true; const failedKey = randomUUID(); response = await send('Retry me', failedKey); assert.equal(response.status, 503); assert.equal((await assistantStatus(a.tenant.id)).features.ai_chat.used, 1);
      providerFails = false; response = await send('Retry me', failedKey); assert.equal(response.status, 200); assert.equal((await assistantStatus(a.tenant.id)).features.ai_chat.used, 2);
    });
    await t.test('signed webhook queues one private reply and duplicate deliveries never resend or consume twice', async () => {
      await connectWhatsApp({ tenantId: a.tenant.id, projectId: a.project.id, actorUserId: a.user.id, wabaId: 'test-waba', phoneNumberId: 'test-phone', accessToken: 'test-permanent-token-only', graphApiVersion: 'v22.0' });
      let response = await fetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123'); assert.equal(await response.text(), '123');
      response = await fetch(base + '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123'); assert.equal(response.status, 403);
      const payload = from => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'test-waba', changes: [{ value: { metadata: { phone_number_id: 'test-phone' }, messages: [{ id: 'wamid.test-once', from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Summarize my project' } }] } }] }] });
      const post = (body, signature) => fetch(base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? `sha256=${createHmac('sha256', 'test-meta-secret').update(body).digest('hex')}` }, body });
      response = await post(payload('8801712345678'), 'sha256=bad'); assert.equal(response.status, 403);
      response = await post(payload('8801999999999')); assert.equal(response.status, 200); assert.equal((await assistantStatus(a.tenant.id)).features.whatsapp_bot.used, 0);
      const before = providerInputs.length;
      response = await post(payload('8801712345678')); assert.equal(response.status, 200); assert.equal(providerInputs.length, before);
      await runAssistantJobs(); assert.equal(delivered.length, 1); assert.equal(delivered[0].to, '8801712345678'); assert.equal(delivered[0].recipient_type, 'individual');
      await post(payload('8801712345678')); await runAssistantJobs(); assert.equal(delivered.length, 1); assert.equal((await assistantStatus(a.tenant.id)).features.whatsapp_bot.used, 1);
      const { processReply } = await import('../dist/modules/assistant/assistant.service.js');
      const queued = await reserveReply({ tenantId: a.tenant.id, projectId: a.project.id, userId: a.user.id, channel: 'whatsapp_bot', requestKey: 'wamid.access-change', prompt: 'Summarize our balances', recipient: '8801712345678', connectionId: (await prisma.whatsAppConnection.findFirstOrThrow({ where: { tenantId: a.tenant.id } })).id });
      await processReply(queued.id);
      await prisma.projectMembership.updateMany({ where: { tenantId: a.tenant.id, projectId: a.project.id, userId: a.user.id }, data: { role: 'member' } });
      await runAssistantJobs(); assert.equal(delivered.length, 1);
      const cancelled = await prisma.assistantReply.findUniqueOrThrow({ where: { id: queued.id } }); assert.equal(cancelled.status, 'failed'); assert.equal(cancelled.reply, null);

    });
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise(resolve => server.close(resolve));
    await prisma.tenant.deleteMany({ where: { id: { in: orgs } } }); await prisma.$disconnect();
  }
});
