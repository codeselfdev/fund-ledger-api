import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
const database = process.env.DELETION_ADMIN_TEST_DATABASE_URL;
test('deletion requests reach the control room and durable Telegram action alerts', { skip: !database }, async t => {
  const url = new URL(database);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/fundtest');
  Object.assign(process.env, { DATABASE_URL: database, JWT_SECRET: 'isolated-deletion-test-secret', NODE_ENV: 'production',
    INTERNAL_API_KEY: 'isolated-deletion-admin-key-0123456789', PLATFORM_ALERT_TELEGRAM_CHAT_ID: '-100-isolated-test', TELEGRAM_BOT_TOKEN: 'synthetic', ADMIN_WEB_URL: 'https://admin.example.test',
    PLATFORM_ALERT_EMAILS: 'admin@example.test', SMTP_USER: 'synthetic', SMTP_PASS: 'synthetic', WHATSAPP_ENABLED: 'false' });
  const mail = [], telegram = []; let failEmail = true;
  nodemailer.createTransport = () => ({ sendMail: async value => { if (failEmail) throw Error('Test mail outage'); mail.push(value); } });
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { createApp } = await import('../dist/app.js');
  const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');
  const { deliverPlatformAlerts } = await import('../dist/modules/internal/alerts.service.js');
  const { executeAccountDeletion, deletionPreview } = await import('../dist/modules/internal/account-deletion.service.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.telegram.org/')) { telegram.push(JSON.parse(options.body)); return Response.json({ ok: true }); }
    assert.ok(String(url).startsWith('http://127.0.0.1:'), 'Unexpected external network call');
    return originalFetch(url, options);
  };
  const tenant = await prisma.tenant.create({ data: { name: 'Deletion test fund', slug: 'deletion-' + randomUUID() } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Synthetic requester', mobile: '+16505550174', email: 'requester@example.test' } });
  const sessionId = randomUUID(), token = signAccessToken({ userId: user.id, tenantId: tenant.id, sessionId });
  await prisma.session.create({ data: { id: sessionId, tenantId: tenant.id, userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60000) } });
  const app = createApp(), server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const own = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const internal = { 'x-internal-api-key': process.env.INTERNAL_API_KEY, 'x-internal-actor': 'reviewer@example.test', 'content-type': 'application/json' };
  const api = async (path, headers = internal, body) => { const response = await fetch(base + path, { headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json() }; };
  let id;
  try {
    await t.test('retries keep one request, one alert and the original deadline', async () => {
      const first = await api('/v1/auth/account-deletion-requests', own, {}); assert.equal(first.status, 200); id = first.body.data.id;
      const retry = await api('/v1/auth/account-deletion-requests', own, {}); assert.deepEqual(retry.body.data, first.body.data);
      assert.equal(await prisma.platformAlert.count({ where: { eventKey: 'account_deletion:' + id } }), 1);
      const row = await prisma.accountDeletionRequest.findUniqueOrThrow({ where: { id } }); assert.equal(row.dueAt - row.requestedAt, 30 * 86400000);
    });
    await t.test('rollback cannot create a phantom deletion alert', async () => {
      const other = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Rollback', mobile: 'rollback' } });
      await assert.rejects(prisma.$transaction(async tx => { await tx.accountDeletionRequest.create({ data: { tenantId: tenant.id, userId: other.id, dueAt: new Date() } }); throw Error('rollback'); }));
      assert.equal(await prisma.platformAlert.count({ where: { userId: other.id, kind: 'account_deletion' } }), 0);
    });
    await t.test('queue and review require internal credentials and mutation actor', async () => {
      assert.equal((await api('/v1/internal/account-deletion-requests', own)).status, 401);
      assert.equal((await api(`/v1/internal/account-deletion-requests/${id}/review`, own, { status: 'in_review', expected_status: 'pending', note: 'Verified request' })).status, 401);
      const listed = await api('/v1/internal/account-deletion-requests'); assert.equal(listed.status, 200);
      assert.equal(listed.body.data.requests.find(row => row.id === id).customer.email, user.email);
      const { ['x-internal-actor']: _, ...noActor } = internal;
      assert.equal((await api(`/v1/internal/account-deletion-requests/${id}/review`, noActor, { status: 'in_review', expected_status: 'pending', note: 'Checked identity' })).status, 400);
    });
    await t.test('review transitions are audited and stale concurrent actions are rejected', async () => {
      const body = { status: 'in_review', expected_status: 'pending', note: 'Verified account ownership through support.' };
      const results = await Promise.all([api(`/v1/internal/account-deletion-requests/${id}/review`, internal, body), api(`/v1/internal/account-deletion-requests/${id}/review`, internal, body)]);
      assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
      const details = await api('/v1/internal/account-deletion-requests/' + id);
      assert.equal(details.body.data.request.status, 'in_review'); assert.equal(details.body.data.history.length, 1); assert.equal(details.body.data.history[0].actor, internal['x-internal-actor']);
      assert.equal((await api(`/v1/internal/account-deletion-requests/${id}/review`, internal, { ...body, status: 'completed' })).status, 400);
    });
    await t.test('Telegram gets a distinct text, deadline and authenticated-panel action button once', async () => {
      await deliverPlatformAlerts();
      const alerts = telegram.filter(value => value.text.includes('Account deletion requested')); assert.equal(alerts.length, 1);
      assert.match(alerts[0].text, new RegExp(id)); assert.match(alerts[0].text, /Due:/);
      assert.equal(alerts[0].reply_markup.inline_keyboard[0][0].text, 'Review deletion request');
      assert.equal(alerts[0].reply_markup.inline_keyboard[0][0].url, `https://admin.example.test/?view=deletions&request=${id}`);
      assert.equal(mail.length, 0);
      failEmail = false; await prisma.platformAlert.updateMany({ where: { tenantId: tenant.id }, data: { nextAttemptAt: new Date(0) } });
      await deliverPlatformAlerts(); assert.equal(telegram.filter(value => value.text.includes('Account deletion requested')).length, 1); assert.equal(mail.filter(value => value.subject.includes('Account deletion requested')).length, 1);
      const feed = await api('/v1/internal/alerts?kind=account_deletion'); assert.equal(feed.body.data.alerts.find(a => a.eventKey === 'account_deletion:' + id).deletion_request_id, id);
    });
    await t.test('deletion requires review, requester verification and exact confirmation', async () => {
      const path = `/v1/internal/account-deletion-requests/${id}/delete`;
      assert.equal((await api(path, own, { identity_verified:true, confirmation:'DELETE ' + id, retention_note:'Retain only shared financial records for the stated retention period.' })).status,401);
      assert.equal((await api(path, internal, { identity_verified:false, confirmation:'DELETE ' + id, retention_note:'Retain only shared financial records for the stated retention period.' })).status,400);
      assert.equal((await api(path, internal, { identity_verified:true, confirmation:'DELETE another-request', retention_note:'Retain only shared financial records for the stated retention period.' })).status,400);
      assert.equal(await prisma.user.count({where:{id:user.id}}),1);
    });
    await t.test('partial file failure remains retryable; deletion preserves ledger and unrelated member data', async () => {
      const scope={tenantId:tenant.id};
      const project=await prisma.project.create({data:{...scope,name:'Financial history',totalShares:2}});scope.projectId=project.id;
      const member=await prisma.member.create({data:{...scope,userId:user.id,name:user.name,mobile:user.mobile,email:user.email,address:'Personal address',profile:{occupation:'Private'},shares:1}});
      const independent=await prisma.member.create({data:{...scope,name:'Independent record',mobile:user.mobile,shares:1}});
      const account=await prisma.account.create({data:{...scope,name:'Cash',type:'cash',balance:700}});
      const transaction=await prisma.accountTransaction.create({data:{...scope,accountId:account.id,direction:'money_in',amount:700,balanceAfter:700,createdById:user.id}});
      await prisma.projectMembership.create({data:{...scope,userId:user.id,role:'member',memberId:member.id}});
      const objects=Array.from({length:26},(_,i)=>({id:'personal-'+randomUUID(),storageKey:`${tenant.id}/${project.id}/member_document/${i}.png`}));
      for(const object of objects)await prisma.upload.create({data:{...scope,...object,userId:user.id,fileName:'private.png',mimeType:'image/png',size:10,purpose:`member_document:${member.id}:identity`}});
      const financial=await prisma.upload.create({data:{...scope,userId:user.id,fileName:'receipt.png',mimeType:'image/png',size:10,storageKey:`${tenant.id}/${project.id}/payment_proof/receipt.png`,purpose:'payment_proof'}});
      const input={identity_verified:true,confirmation:'DELETE '+id,retention_note:'Shared transaction records and receipt proof remain for the organization accounting retention period; notify the verified requester after completion.'};
      let providerCalls=0,fail=true;const purged=[];
      const dependencies={purgeObject:async key=>{if(fail){fail=false;throw Error('Synthetic storage outage');}purged.push(key);},deleteFirebaseIdentity:async()=>{providerCalls++;}};
      assert.equal((await deletionPreview(id)).personal_files,26);
      await assert.rejects(executeAccountDeletion(id,input,'operator',dependencies),/remains open/);
      let state=await prisma.accountDeletionRequest.findUniqueOrThrow({where:{id}});assert.equal(state.status,'processing_failed');assert.equal(state.completedAt,null);assert.equal(providerCalls,0);
      assert.equal((await prisma.user.findUniqueOrThrow({where:{id:user.id}})).isActive,false);
      assert.equal((await api('/v1/auth/account-deletion-requests/current',own)).status,401);
      const batch=await executeAccountDeletion(id,input,'operator',dependencies);assert.equal(batch.status,'processing');assert.equal(providerCalls,0);assert.equal((await deletionPreview(id)).personal_files,1);
      const result=await executeAccountDeletion(id,input,'operator',dependencies);assert.equal(result.status,'completed');assert.ok(result.completedAt);assert.equal(providerCalls,1);
      assert.deepEqual(new Set(purged),new Set(objects.map(o=>o.storageKey)));assert.equal(await prisma.user.count({where:{id:user.id}}),0);
      assert.equal(await prisma.session.count({where:{userId:user.id}}),0);assert.equal(await prisma.projectMembership.count({where:{userId:user.id}}),0);
      const redacted=await prisma.member.findUniqueOrThrow({where:{id:member.id}});assert.equal(redacted.name,'Deleted member');assert.equal(redacted.email,null);assert.equal(redacted.profile,null);assert.equal(redacted.userId,null);assert.equal(redacted.shares,1);
      assert.deepEqual(await prisma.member.findUniqueOrThrow({where:{id:independent.id}}),independent);
      assert.deepEqual(await prisma.account.findUniqueOrThrow({where:{id:account.id}}),account);assert.deepEqual(await prisma.accountTransaction.findUniqueOrThrow({where:{id:transaction.id}}),transaction);
      assert.deepEqual(await prisma.upload.findUniqueOrThrow({where:{id:financial.id}}),financial);
      const repeated=await executeAccountDeletion(id,input,'operator',dependencies);assert.equal(repeated.status,'completed');assert.equal(providerCalls,1);
      assert.equal(await prisma.internalAudit.count({where:{action:'account_deletion.completed',tenantId:tenant.id}}),1);
    });
    await t.test('concurrent execution is rejected and provider failure cannot falsely complete deletion', async () => {
      const target=await prisma.user.create({data:{tenantId:tenant.id,name:'Provider failure test',mobile:'+447700900999'}});
      const project=await prisma.project.create({data:{tenantId:tenant.id,name:'Retry fixture',totalShares:1}});
      const member=await prisma.member.create({data:{tenantId:tenant.id,projectId:project.id,userId:target.id,name:target.name,mobile:target.mobile,shares:1}});
      await prisma.upload.create({data:{tenantId:tenant.id,projectId:project.id,userId:target.id,fileName:'photo.png',mimeType:'image/png',size:10,storageKey:`${tenant.id}/${project.id}/photo.png`,purpose:`member_photo:${member.id}`}});
      const request=await prisma.accountDeletionRequest.create({data:{tenantId:tenant.id,userId:target.id,status:'in_review',dueAt:new Date()}});
      const input={identity_verified:true,confirmation:'DELETE '+request.id,retention_note:'Retain required shared financial records and notify the verified requester.'};
      let release,ready;const started=new Promise(resolve=>{ready=resolve;});
      const first=executeAccountDeletion(request.id,input,'operator',{purgeObject:async()=>{ready();await new Promise(resolve=>{release=resolve;});},deleteFirebaseIdentity:async()=>{throw Error('Synthetic provider outage');}});
      const failure=assert.rejects(first,/Authentication provider cleanup/);
      await started;await assert.rejects(executeAccountDeletion(request.id,input,'operator'),/already running/);release();await failure;
      const failed=await prisma.accountDeletionRequest.findUniqueOrThrow({where:{id:request.id}});assert.equal(failed.status,'processing_failed');assert.equal(failed.completedAt,null);
      assert.equal(await prisma.user.count({where:{id:target.id}}),1);
      const result=await executeAccountDeletion(request.id,input,'operator',{purgeObject:async()=>{},deleteFirebaseIdentity:async()=>{}});assert.equal(result.status,'completed');
    });
    await t.test('last owner cannot be deleted and another organization login prevents provider cleanup', async () => {
      const project=await prisma.project.findFirstOrThrow({where:{tenantId:tenant.id}});
      const owner=await prisma.user.create({data:{tenantId:tenant.id,name:'Last owner',mobile:'owner'}});
      await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:project.id,userId:owner.id,role:'owner'}});
      const ownerRequest=await prisma.accountDeletionRequest.create({data:{tenantId:tenant.id,userId:owner.id,status:'in_review',dueAt:new Date()}});
      const input={identity_verified:true,confirmation:'DELETE '+ownerRequest.id,retention_note:'Only shared accounting records are retained for the stated period.'};
      assert.match((await deletionPreview(ownerRequest.id)).blockers.join(' '),/Transfer ownership/);
      const dependencies={purgeObject:async()=>{throw Error('Should not purge');},deleteFirebaseIdentity:async()=>{throw Error('Shared provider identity must remain');}};
      await assert.rejects(executeAccountDeletion(ownerRequest.id,input,'operator',dependencies),/Transfer ownership/);assert.equal((await prisma.user.findUniqueOrThrow({where:{id:owner.id}})).isActive,true);
      const requester=await prisma.user.create({data:{tenantId:tenant.id,name:'Another account',mobile:'+447700900123',email:'shared@example.test'}});
      const sibling=await prisma.tenant.create({data:{name:'Other organization',slug:'other-'+randomUUID()}});
      try{
        const other=await prisma.user.create({data:{tenantId:sibling.id,name:'Keep active',mobile:requester.mobile,email:requester.email}});
        const linked=await prisma.user.create({data:{tenantId:sibling.id,name:'Linked identity',mobile:'linked-root-test',identityRootId:owner.id}});
        assert.match((await deletionPreview(ownerRequest.id)).blockers.join(' '),/login root/);
        await prisma.user.delete({where:{id:linked.id}});
        const request=await prisma.accountDeletionRequest.create({data:{tenantId:tenant.id,userId:requester.id,status:'in_review',dueAt:new Date()}});
        const result=await executeAccountDeletion(request.id,{...input,confirmation:'DELETE '+request.id},'operator',dependencies);assert.equal(result.status,'completed');
        assert.deepEqual(await prisma.user.findUniqueOrThrow({where:{id:other.id}}),other);
      }finally{await prisma.tenant.delete({where:{id:sibling.id}});}
    });
  } finally {
    globalThis.fetch = originalFetch; await new Promise(resolve => server.close(resolve));
    await prisma.accountDeletionRequest.deleteMany({ where: { tenantId: tenant.id } }); await prisma.internalAudit.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } }); await prisma.$disconnect();
  }
});
