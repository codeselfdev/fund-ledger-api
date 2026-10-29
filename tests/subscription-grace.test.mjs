import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createOneMonthTrial,evaluateSubscription,renewTenantSubscription} from '../dist/core/subscription/subscription.service.js';
import {subscriptionReminder} from '../dist/core/subscription/reminder-policy.js';
import {requireActiveSubscription} from '../dist/core/security/subscription.middleware.js';
import {prisma} from '../dist/core/prisma/client.js';
import {hasAssistant} from '../dist/modules/assistant/assistant.policy.js';
const DAY=86400000, end=new Date('2027-02-01T12:00:00Z');
const trial={subscription:{...createOneMonthTrial(new Date('2027-01-01T12:00:00Z'))}};
const paid=()=>renewTenantSubscription({},new Date('2027-01-01T12:00:00Z'),{package:'starter',billing_cycle:'monthly'}).contact;
after(()=>prisma.$disconnect());
test('trial and paid organizations retain exactly five extra days then lose all project access',()=>{
 for(const contact of [trial,paid()]){
  const copy=structuredClone(contact);
  assert.equal(evaluateSubscription(contact,new Date(end.getTime()-1)).in_grace_period,false);
  let status=evaluateSubscription(contact,end);assert.equal(status.has_access,true);assert.equal(status.access_phase,'grace');assert.equal(status.grace_days_left,5);
  assert.equal(status.access_ends_at,'2027-02-06T12:00:00.000Z');
  status=evaluateSubscription(contact,new Date(end.getTime()+5*DAY-1));assert.equal(status.has_access,true);assert.equal(status.grace_days_left,1);
  status=evaluateSubscription(contact,new Date(end.getTime()+5*DAY));assert.equal(status.has_access,false);assert.equal(status.access_phase,'expired');
  assert.deepEqual(contact,copy);
 }
});
test('unknown, malformed and explicitly revoked subscriptions never receive a new grace period',()=>{
 for(const contact of [{},{subscription:{status:'expired',trial_ends_at:end.toISOString()}},{subscription:{status:'trial',trial_ends_at:'bad'}},{subscription:{status:'active',current_period_end_at:'bad'}}])assert.equal(evaluateSubscription(contact,end).has_access,false);
});
test('renewal during grace restores the current organization and preserves prepaid time before expiry',()=>{
 const graceNow=new Date(end.getTime()+2*DAY),contact=paid();
 assert.equal(evaluateSubscription(contact,graceNow).in_grace_period,true);
 const renewed=renewTenantSubscription(contact,graceNow,{package:'starter',billing_cycle:'monthly'});
 const status=evaluateSubscription(renewed.contact,graceNow);assert.equal(status.has_access,true);assert.equal(status.in_grace_period,false);assert.equal(status.days_left,28);
 const early=renewTenantSubscription(contact,new Date('2027-01-15'),{package:'starter',billing_cycle:'yearly'});
 assert.equal(early.subscription.current_period_end_at,'2028-02-01T12:00:00.000Z');
 assert.equal(hasAssistant(contact,'ai_chat',graceNow),true);assert.equal(hasAssistant(contact,'ai_chat',new Date(end.getTime()+5*DAY)),false);
});
test('subscription middleware blocks every role after grace and admits every role during grace',async()=>{
 const now=Date.now();
 for(const elapsed of [2,6]){
  prisma.tenant.findUnique=async()=>({deletionStartedAt:null,contact:{subscription:{status:'active',package:'starter',current_period_end_at:new Date(now-elapsed*DAY).toISOString()}}});
  for(const role of ['owner','admin','accountant','member','teacher','employee']){
   let error;await requireActiveSubscription({auth:{tenantId:'org',roles:[role]}},{},value=>{error=value;});
   if(elapsed===2)assert.equal(error,undefined,role);else{assert.equal(error.statusCode,402);assert.equal(error.code,'SUBSCRIPTION_EXPIRED');}
  }
 }
});
test('reminders are due 7, 3 and 1 days before expiry, during grace, and when access pauses',()=>{
 for(const remaining of [7,3,1])assert.equal(subscriptionReminder(trial,'Example',new Date(end.getTime()-remaining*DAY)).stage,`before_${remaining}`);
 for(const remaining of [30,8,6,4,2])assert.equal(subscriptionReminder(trial,'Example',new Date(end.getTime()-remaining*DAY)),null);
 assert.equal(subscriptionReminder(trial,'Example',end).stage,'grace_started');
 assert.equal(subscriptionReminder(trial,'Example',new Date(end.getTime()+4*DAY)).stage,'grace_last_day');
 assert.equal(subscriptionReminder(trial,'Example',new Date(end.getTime()+5*DAY)).stage,'access_paused');
 assert.equal(subscriptionReminder(trial,'Example',new Date(end.getTime()+7*DAY)),null);
 const renewed=renewTenantSubscription(trial,end,{package:'business',billing_cycle:'yearly'});
 assert.equal(subscriptionReminder(renewed.contact,'Example',end),null);
});
