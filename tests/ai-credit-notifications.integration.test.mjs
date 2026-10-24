import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('isolated PostgreSQL: sorted usage and one owner push/email pair per credit extension',
 {skip:process.env.RUN_AI_CREDIT_INTEGRATION!=='true'},async()=>{
 const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/fundnesta_credit_notify_verify','Only the disposable verification database is allowed');
 const {prisma}=await import('../dist/core/prisma/client.js');
 const {grantAiCredits,aiCreditTenants,aiCreditHistory}=await import('../dist/modules/internal/ai-credits.service.js');
 const {allowancePeriod}=await import('../dist/modules/assistant/assistant.policy.js');
 const {createAiCreditNotifier}=await import('../dist/modules/internal/ai-credit-notifications.service.js');
 const ids=[],prefix=`credit-verify-${randomUUID()}`;
 try{
  const records=[];
  for(const [index,used] of [2,9,0].entries()){
   const tenant=await prisma.tenant.create({data:{name:`Credit verify ${index}`,slug:`${prefix}-${index}`,contact:{subscription:{package:'free',status:'trial',trial_ends_at:'2099-01-01T00:00:00Z'}}}});ids.push(tenant.id);
   const project=await prisma.project.create({data:{tenantId:tenant.id,name:'Synthetic project',totalShares:1}});
   const owner=await prisma.user.create({data:{tenantId:tenant.id,name:'Synthetic owner',mobile:`+88017000000${index}`,email:`owner-${index}@example.test`,deviceId:`synthetic-device-${index}`}});
   const accountant=await prisma.user.create({data:{tenantId:tenant.id,name:'Unrelated accountant',mobile:`+88018000000${index}`,email:`staff-${index}@example.test`,deviceId:`staff-device-${index}`}});
   await prisma.projectMembership.createMany({data:[{tenantId:tenant.id,projectId:project.id,userId:owner.id,role:'owner'},{tenantId:tenant.id,projectId:project.id,userId:accountant.id,role:'accountant'}]});
   const base={tenantId:tenant.id,projectId:project.id,userId:owner.id,channel:'ai_chat',promptHash:'synthetic',prompt:'Synthetic test',periodStart:allowancePeriod(tenant.contact).start,status:'completed'};
   await prisma.assistantReply.createMany({data:[...Array.from({length:used},()=>({...base,requestKey:randomUUID()})),{...base,requestKey:randomUUID(),status:'cancelled'}]});
   records.push({tenant,owner});
  }
  let page=await aiCreditTenants(0,prefix,'used','desc');assert.deepEqual(page.tenants.map(t=>t.id),[ids[1],ids[0],ids[2]]);assert.equal(page.tenants[0].ai_usage.used,9);
  page=await aiCreditTenants(0,prefix,'ai_chat','asc');assert.deepEqual(page.tenants.map(t=>t.id),[ids[2],ids[0],ids[1]]);
  const input={request_key:randomUUID(),channel:'ai_chat',credits:25,reason:'Internal approval reference - not customer content',period_start:allowancePeriod(records[0].tenant.contact).start.toISOString()};
  const result=await Promise.all([grantAiCredits(ids[0],input,'synthetic-admin'),grantAiCredits(ids[0],input,'synthetic-admin')]);assert.equal(result.filter(value=>value.replayed).length,1);
  const notices=await prisma.notification.findMany({where:{tenantId:ids[0]}});assert.equal(notices.length,1);assert.equal(notices[0].recipientUserId,records[0].owner.id);assert.doesNotMatch(notices[0].body,/Internal approval/);
  assert.equal(await prisma.aiCreditDelivery.count({where:{tenantId:ids[0]}}),2);assert.equal(await prisma.internalAudit.count({where:{tenantId:ids[0],action:'assistant.credits_extended'}}),1);
  let emailFails=true;const pushes=[],emails=[];
  const notifier=createAiCreditNotifier(prisma,{push:async input=>{pushes.push(input);return{sent_count:1,failed_count:0,invalid_tokens:[],skipped:false};},email:async input=>{emails.push(input);return!emailFails;}});
  await notifier.deliver();assert.deepEqual(pushes[0].tokens,['synthetic-device-0']);assert.equal(emails[0].to,'owner-0@example.test');
  let history=await aiCreditHistory(ids[0],0);assert.equal(history.grants[0].delivery.push.status,'sent');assert.equal(history.grants[0].delivery.email.status,'pending');
  emailFails=false;await prisma.aiCreditDelivery.updateMany({where:{tenantId:ids[0],status:'pending'},data:{nextAttemptAt:new Date(0)}});await notifier.deliver();
  assert.equal(pushes.length,1);assert.equal(emails.length,2);history=await aiCreditHistory(ids[0],0);assert.equal(history.grants[0].delivery.email.status,'sent');
  await prisma.notification.delete({where:{id:notices[0].id}});assert.equal(await prisma.aiCreditDelivery.count({where:{tenantId:ids[0]}}),0,'Inbox deletion cascades to delivery records');
 }finally{
  await prisma.internalAudit.deleteMany({where:{tenantId:{in:ids}}});await prisma.tenant.deleteMany({where:{id:{in:ids}}});await prisma.$disconnect();
 }
});
