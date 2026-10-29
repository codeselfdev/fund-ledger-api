import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=process.env.QUOTA_TEST_DATABASE_URL;
test('owner subscription reminder outbox against disposable PostgreSQL',{skip:!url},async t=>{
 process.env.DATABASE_URL=url;
 const {prisma}=await import('../dist/core/prisma/client.js');
 const {createSubscriptionReminderWorker}=await import('../dist/modules/subscription/subscription-reminders.service.js');
 const {createOneMonthTrial,renewTenantSubscription}=await import('../dist/core/subscription/subscription.service.js');
 const now=new Date('2027-01-01T10:00:00Z'),ids=[],delivered={push:[],email:[]};
 let pushFails=false;
 const worker=createSubscriptionReminderWorker(prisma,{push:async data=>{delivered.push.push(data);if(pushFails){pushFails=false;throw Error('retry');}return{sent_count:1,invalid_tokens:[]};},email:async data=>{delivered.email.push(data);return true;}});
 async function org(){
  const tenant=await prisma.tenant.create({data:{name:'Synthetic reminder organization',slug:'reminder-'+randomUUID(),contact:{subscription:{...createOneMonthTrial(now),trial_ends_at:'2027-01-08T10:00:00.000Z'}}}});ids.push(tenant.id);
  const project=await prisma.project.create({data:{tenantId:tenant.id,name:'Original project',totalShares:1}});
  const owner=await prisma.user.create({data:{tenantId:tenant.id,name:'Owner',mobile:randomUUID(),email:'owner@example.test',deviceId:'mock-'+tenant.id}});
  const member=await prisma.user.create({data:{tenantId:tenant.id,name:'Member',mobile:randomUUID(),email:'member@example.test',deviceId:'member-device'}});
  await prisma.projectMembership.createMany({data:[{tenantId:tenant.id,projectId:project.id,userId:owner.id,role:'owner'},{tenantId:tenant.id,projectId:project.id,userId:member.id,role:'member'}]});
  return{tenant,project,owner,member};
 }
 const data=await org();
 try{
  await t.test('concurrent scans create one owner inbox reminder and one delivery per channel, with no member charges or reminders',async()=>{
   await Promise.all([worker.queue(now),worker.queue(now)]);
   const rows=await prisma.notification.findMany({where:{tenantId:data.tenant.id,type:'subscription.payment_reminder'}});
   assert.equal(rows.length,1);assert.equal(rows[0].recipientUserId,data.owner.id);
   assert.equal(await prisma.subscriptionReminderDelivery.count({where:{tenantId:data.tenant.id}}),2);
   assert.equal(await prisma.notification.count({where:{recipientUserId:data.member.id}}),0);
  });
  await t.test('simultaneous delivery workers claim each channel only once and link to organization billing',async()=>{
   await Promise.all([worker.deliver(now),worker.deliver(now)]);
   assert.equal(delivered.push.length,1);assert.equal(delivered.email.length,1);
   assert.equal(delivered.push[0].data.project_id,data.project.id);assert.equal(delivered.push[0].data.app_screen,'billing');
   assert.equal(delivered.email[0].to,'owner@example.test');
   assert.equal(await prisma.subscriptionReminderDelivery.count({where:{tenantId:data.tenant.id,status:'sent'}}),2);
  });
  await t.test('renewal before delivery suppresses obsolete reminders',async()=>{
   const other=await org();await worker.queue(now);
   await prisma.tenant.update({where:{id:other.tenant.id},data:{contact:renewTenantSubscription(other.tenant.contact,now,{package:'starter',billing_cycle:'monthly'}).contact}});
   await worker.deliver(now);assert.equal(delivered.push.length,1);assert.equal(delivered.email.length,1);
   assert.equal(await prisma.subscriptionReminderDelivery.count({where:{tenantId:other.tenant.id,status:'skipped'}}),2);
  });
  await t.test('revoking ownership before delivery suppresses reminders to the old owner',async()=>{
   const other=await org();await worker.queue(now);
   await prisma.projectMembership.updateMany({where:{tenantId:other.tenant.id,userId:other.owner.id},data:{isActive:false}});
   await worker.deliver(now);assert.equal(delivered.push.length,1);assert.equal(delivered.email.length,1);
   assert.equal(await prisma.subscriptionReminderDelivery.count({where:{tenantId:other.tenant.id,status:'skipped'}}),2);
  });
  await t.test('failed channels retry independently without duplicating the successful email',async()=>{
   const other=await org();await worker.queue(now);pushFails=true;
   await worker.deliver(now);assert.equal(delivered.push.length,2);assert.equal(delivered.email.length,2);
   await worker.deliver(new Date(now.getTime()+1000));assert.equal(delivered.push.length,2);
   await worker.deliver(new Date(now.getTime()+60001));assert.equal(delivered.push.length,3);assert.equal(delivered.email.length,2);
   assert.equal(await prisma.subscriptionReminderDelivery.count({where:{tenantId:other.tenant.id,status:'sent'}}),2);
  });
 }finally{await prisma.tenant.deleteMany({where:{id:{in:ids}}});await prisma.$disconnect();}
});
