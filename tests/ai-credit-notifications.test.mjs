import { installAccountReadFixtures } from './helpers/normalized-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/no_database',JWT_SECRET:'synthetic-credit-notification-test'});
const {queueAiCreditNotification,createAiCreditNotifier}=await import('../dist/modules/internal/ai-credit-notifications.service.js');

test('a credit extension queues one primary-owner inbox notification and independent push/email deliveries',async()=>{
 const writes=[];
 const tx={user:{findFirst:async query=>{assert.equal(query.where.tenantId,'org');assert.equal(query.where.isActive,true);assert.equal(query.where.memberships.some.role,'owner');assert.deepEqual(query.orderBy,[{createdAt:'asc'},{id:'asc'}]);return{id:'owner'};}},notification:{create:async query=>writes.push(query)},aiCreditDelivery:{createMany:async query=>writes.push(query)}};
 installAccountReadFixtures(tx);
 const result=await queueAiCreditNotification(tx,{id:'org',name:'Example organization'},{id:'grant',channel:'ai_chat',credits:25,limit:125,expires_at:'2026-11-01T00:00:00Z'});
 assert.equal(result.notification_id,'ai-credit:grant');assert.equal(writes[0].data.recipientUserId,'owner');assert.equal(writes[0].data.tenantId,'org');assert.match(writes[0].data.body,/25 extra AI chat credits/);assert.match(writes[0].data.body,/125/);assert.match(writes[0].data.body,/1 Nov 2026/);assert.deepEqual(writes[1].data.map(row=>row.channel),['push','email']);
 tx.tenantUser.findFirst=async()=>null;assert.deepEqual(await queueAiCreditNotification(tx,{id:'other',name:'No owner'},{id:'next',channel:'ai_chat',credits:1,limit:11,expires_at:'2026-11-01T00:00:00Z'}),{notification_id:null});assert.equal(writes.length,2);
});
function fixture({emailFails=false,pushFails=false,noDevice=false,noEmail=false,invalidToken=false,unavailable=false,attempts=0,claim=false}={}){
 const rows=['push','email'].map(channel=>({id:channel,channel,tenantId:'org',notificationId:'notice',status:'pending',attempts,nextAttemptAt:new Date(0),leaseUntil:null,leaseToken:null}));
 const pushes=[],emails=[],cleared=[],queries=[];
 const matches=(row,where)=>{
  for(const key of ['id','status','leaseToken'])if(where[key]!==undefined&&row[key]!==where[key])return false;
  if(where.attempts?.lt!==undefined&&row.attempts>=where.attempts.lt)return false;
  if(where.attempts?.gte!==undefined&&row.attempts<where.attempts.gte)return false;
  if(where.nextAttemptAt&&row.nextAttemptAt>where.nextAttemptAt.lte)return false;
  if(where.OR&&row.leaseUntil&&row.leaseUntil>=where.OR[1].leaseUntil.lt)return false;
  return true;
 };
 const db={aiCreditDelivery:{findMany:async({where})=>rows.filter(row=>matches(row,where)).map(row=>({...row})),updateMany:async({where,data})=>{
  if(claim&&data.leaseToken)return{count:0};let count=0;for(const row of rows.filter(row=>matches(row,where))){const attempts=row.attempts;Object.assign(row,data);if(typeof data.attempts==='object')row.attempts=attempts+data.attempts.increment;count++;}return{count};
 }},notification:{findFirst:async query=>{queries.push(query);return unavailable?null:{title:'Your AI credits have been extended',body:'Example: 25 extra credits added. Your quota is now 125.',entityId:'grant',recipient:{id:'owner',tenantId:'org',isActive:true,name:'Customer',email:noEmail?null:'owner@example.test',deviceId:noDevice?null:'owner-device'},tenant:{deletionStartedAt:null}};}},user:{updateMany:async query=>{cleared.push(query);return{count:1};}}};
 installAccountReadFixtures(db);
 const notifier=createAiCreditNotifier(db,{push:async input=>{pushes.push(input);if(pushFails)throw Error('FCM unavailable');return{sent_count:invalidToken?0:1,invalid_tokens:invalidToken?['owner-device']:[]};},email:async input=>{emails.push(input);return!emailFails;}});
 return{rows,pushes,emails,cleared,queries,notifier};
}
test('push and email send only to the selected owner and successful channels are not resent',async()=>{
 const f=fixture();await f.notifier.deliver();await f.notifier.deliver();assert.equal(f.pushes.length,1);assert.equal(f.emails.length,1);assert.deepEqual(f.pushes[0].tokens,['owner-device']);assert.equal(f.emails[0].to,'owner@example.test');assert.equal(f.pushes[0].data.tenant_id,'org');assert.equal(f.pushes[0].data.entity_type,'ai_credit_grant');assert.ok(f.rows.every(row=>row.status==='sent'&&row.sentAt&&row.leaseToken===null));
 for(const query of f.queries){assert.equal(query.where.tenantId,'org');assert.equal(query.where.recipient.tenantId,'org');assert.equal(query.where.recipient.memberships.some.role,'owner');}
});
test('email failure retries independently and never resends an accepted push or touches quota',async()=>{
 const f=fixture({emailFails:true});await f.notifier.deliver();assert.equal(f.rows[0].status,'sent');assert.equal(f.rows[1].status,'pending');assert.equal(f.rows[1].lastError,'provider_unavailable');assert.ok(f.rows[1].nextAttemptAt>new Date());
 f.rows[1].nextAttemptAt=new Date(0);await f.notifier.deliver();assert.equal(f.pushes.length,1);assert.equal(f.emails.length,2);assert.equal(f.rows[1].attempts,2);
});
test('push failure does not block email and missing contact details are skipped',async()=>{
 const f=fixture({pushFails:true});await f.notifier.deliver();assert.equal(f.rows[0].status,'pending');assert.equal(f.rows[1].status,'sent');
 const missing=fixture({noDevice:true,noEmail:true});await missing.notifier.deliver();assert.deepEqual(missing.rows.map(row=>row.lastError),['no_registered_device','no_email_address']);assert.equal(missing.pushes.length,0);assert.equal(missing.emails.length,0);
});
test('invalid device tokens are cleared only for that owner and unavailable recipients never send',async()=>{
 const f=fixture({invalidToken:true});await f.notifier.deliver();assert.equal(f.rows[0].lastError,'invalid_device_token');assert.deepEqual(f.cleared[0].where,{id:'owner',tenantId:'org',deviceId:'owner-device'});
 const gone=fixture({unavailable:true});await gone.notifier.deliver();assert.ok(gone.rows.every(row=>row.status==='skipped'&&row.lastError==='recipient_unavailable'));assert.equal(gone.pushes.length,0);assert.equal(gone.emails.length,0);
});
test('leases prevent duplicate claims and exhausted retries become terminal',async()=>{
 const claimed=fixture({claim:true});await claimed.notifier.deliver();assert.equal(claimed.pushes.length,0);assert.equal(claimed.emails.length,0);
 const exhausted=fixture({attempts:5});await exhausted.notifier.deliver();assert.ok(exhausted.rows.every(row=>row.status==='failed'&&row.lastError==='retry_limit_reached'));assert.equal(exhausted.pushes.length,0);
 const final=fixture({attempts:4,pushFails:true,emailFails:true});await final.notifier.deliver();assert.ok(final.rows.every(row=>row.status==='failed'));
});
