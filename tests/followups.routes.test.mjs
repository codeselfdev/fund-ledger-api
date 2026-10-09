import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../dist/core/prisma/client.js';
import { followupsRouter } from '../dist/modules/follow-ups/followups.routes.js';

let server, url, reminders = [], commitments = [], callLogs = [], dueAmount = 100;
let memberProfile = { photo_file_id: 'member-photo', father_name: 'Private profile field' };
const dhakaKey = () => {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const value = type => parts.find(part=>part.type===type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
};
const plusDays = days => {const date=new Date(`${dhakaKey()}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);};
before(async () => {
  prisma.member.findFirst = async ({where}) => where.id === 'member' ? {id:'member',tenantId:'tenant',projectId:'project',name:'Member One',mobile:'+8801',shares:1,status:'active'} : null;
  prisma.member.findMany = async ({ where, select }) => {
    assert.equal(where.tenantId, 'tenant'); assert.equal(where.projectId, 'project');
    assert.equal(select.profile, true);
    return [{id:'member',tenantId:'tenant',projectId:'project',name:'Member One',mobile:'+8801',shares:1,status:'active',profile:memberProfile}];
  };
  prisma.project.findFirst = async () => ({name:'Fund Nesta'});
  prisma.due.findMany = async ({where}) => dueAmount ? [{id:'due',memberId:where.memberId??'member',amount:dueAmount,paidAmount:0,waivedAmount:0,penaltyDue:0,penaltyPaid:0,dueDate:new Date(`${plusDays(5)}T00:00:00Z`),paidAt:null,allocations:[]}] : [];
  prisma.paymentCommitment.findMany = async ({where}) => commitments.filter(row => (!where.memberId || row.memberId===where.memberId) && (!where.status || (where.status.in ? where.status.in.includes(row.status) : row.status===where.status)));
  prisma.paymentCommitment.findFirst = async ({where}) => commitments.find(row => row.memberId===where.memberId && (where.status?.in ? where.status.in.includes(row.status) : row.status===where.status)) ?? null;
  prisma.paymentCommitment.create = async ({data}) => {const row={id:`c${commitments.length+1}`,status:'pending',createdAt:new Date(),updatedAt:new Date(),resolvedAt:null,resolveReason:null,resolvedById:null,resolvedDepositId:null,supersededById:null,...data};commitments.unshift(row);return row;};
  prisma.paymentCommitment.update = async ({where,data}) => Object.assign(commitments.find(row=>row.id===where.id),data);
  prisma.paymentCommitment.updateMany = async ({where,data}) => {const rows=commitments.filter(row=>where.id.in.includes(row.id));rows.forEach(row=>Object.assign(row,data));return {count:rows.length};};
  prisma.memberCallLog.findMany = async ({where}) => callLogs.filter(row => row.memberId === where.memberId).map(row => ({...row,createdBy:{name:'Staff User'},commitment:row.outcome==='committed'?{id:commitments.find(item=>item.callLogId===row.id)?.id}:null}));
  prisma.memberCallLog.create = async ({data}) => {const row={calledAt:new Date(),createdAt:new Date(),...data};callLogs.push(row);return row;};
  prisma.$queryRaw = async () => [];
  prisma.$transaction = async callback => callback(prisma);
  prisma.memberReminder.create = async ({data}) => {
    if (reminders.some(row => row.projectId===data.projectId && row.memberId===data.memberId && row.reminderDate.getTime()===data.reminderDate.getTime())) throw new Prisma.PrismaClientKnownRequestError('unique',{code:'P2002',clientVersion:'5.22.0'});
    await new Promise(resolve => setTimeout(resolve, 2));
    if (reminders.some(row => row.projectId===data.projectId && row.memberId===data.memberId && row.reminderDate.getTime()===data.reminderDate.getTime())) throw new Prisma.PrismaClientKnownRequestError('unique',{code:'P2002',clientVersion:'5.22.0'});
    const row={id:`r${reminders.length+1}`,sentAt:new Date(),...data}; reminders.push(row); return row;
  };
  prisma.memberReminder.findUnique = async () => reminders[0] ?? null;
  prisma.memberReminder.findMany = async () => reminders;
  prisma.memberReminder.update = async ({where,data}) => Object.assign(reminders.find(row=>row.id===where.id),data);
  prisma.projectMembership.findMany = async () => [];
  prisma.activity.create = async ({data}) => data;
  const app=express(); app.use(express.json()); app.use((req,_res,next)=>{req.auth={tenantId:'tenant',projectId:'project',userId:'admin',memberId:'admin-member',roles:[req.header('x-role')??'admin']};next();}); app.use('/v1',followupsRouter); app.use((error,_req,res,_next)=>res.status(error.statusCode??500).json({error:{code:error.code,message:error.message,fields:error.fields}}));
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); url=`http://127.0.0.1:${server.address().port}/v1`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
async function request(path,method='POST',body,role='admin'){const response=await fetch(url+path,{method,headers:{'content-type':'application/json','x-role':role},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};}

test('a reminder is recorded once and returns zero delivery for a member without an app account',async()=>{reminders=[];dueAmount=100;const first=await request('/members/member/reminders');assert.equal(first.status,200);assert.equal(first.body.data.delivered_count,0);const second=await request('/members/member/reminders');assert.equal(second.status,409);assert.equal(second.body.error.code,'REMINDER_ALREADY_SENT_TODAY');});
test('two parallel reminder taps produce exactly one success',async()=>{reminders=[];dueAmount=100;const results=await Promise.all([request('/members/member/reminders'),request('/members/member/reminders')]);assert.deepEqual(results.map(row=>row.status).sort(),[200,409]);assert.equal(reminders.length,1);});
test('reminders require outstanding dues',async()=>{reminders=[];dueAmount=0;const result=await request('/members/member/reminders');assert.equal(result.status,422);assert.equal(result.body.error.code,'NO_OUTSTANDING_DUE');});
test('members cannot access follow-up management and committed calls require details',async()=>{assert.equal((await request('/members/member/reminders','POST',undefined,'member')).status,403);const invalid=await request('/members/member/call-logs','POST',{outcome:'committed',summary:'Will pay'});assert.equal(invalid.status,400);});
test('a new commitment reschedules a current pending promise',async()=>{commitments=[{id:'old',tenantId:'tenant',projectId:'project',memberId:'member',amount:50,promisedDate:new Date(`${plusDays(5)}T00:00:00Z`),summary:'Old',status:'pending',outstandingAtCreate:100,createdById:'admin',createdAt:new Date(),updatedAt:new Date(),callLogId:null,resolvedAt:null,resolvedById:null,resolvedDepositId:null,resolveReason:null,supersededById:null}];callLogs=[];dueAmount=100;const result=await request('/members/member/call-logs','POST',{outcome:'committed',summary:'New date agreed',commitment:{promised_date:plusDays(6),amount:80}});assert.equal(result.status,201);assert.equal(commitments.find(row=>row.id==='old').status,'rescheduled');assert.equal(commitments.find(row=>row.id==='old').supersededById,result.body.data.commitment.id);});
test('a broken promise remains broken when a new promise is logged',async()=>{commitments=[{id:'old-broken',tenantId:'tenant',projectId:'project',memberId:'member',amount:50,promisedDate:new Date(`${plusDays(-5)}T00:00:00Z`),summary:'Old',status:'broken',outstandingAtCreate:100,createdById:'admin',createdAt:new Date(),updatedAt:new Date(),callLogId:null,resolvedAt:null,resolvedById:null,resolvedDepositId:null,resolveReason:null,supersededById:null}];callLogs=[];dueAmount=100;const result=await request('/members/member/call-logs','POST',{outcome:'committed',summary:'Another date',commitment:{promised_date:plusDays(7),amount:100}});assert.equal(result.status,201);assert.equal(commitments.find(row=>row.id==='old-broken').status,'broken');});
test('the need tab returns only the latest open commitment for a member',async()=>{const base={tenantId:'tenant',projectId:'project',memberId:'member',amount:100,outstandingAtCreate:100,createdById:'admin',updatedAt:new Date(),callLogId:null,resolvedById:null,resolvedDepositId:null,resolveReason:null,supersededById:null};commitments=[{...base,id:'open',promisedDate:new Date(`${dhakaKey()}T00:00:00Z`),summary:'Due today',status:'pending',createdAt:new Date(),resolvedAt:null},{...base,id:'settled',promisedDate:new Date(`${plusDays(-10)}T00:00:00Z`),summary:'Already paid',status:'kept',createdAt:new Date(Date.now()-86400000),resolvedAt:new Date()}];reminders=[];dueAmount=100;const result=await request('/follow-ups?tab=need','GET');assert.equal(result.status,200);assert.deepEqual(result.body.data.items.map(row=>row.commitment.id),['open']);assert.equal(result.body.data.items[0].commitment.effective_status,'due_today');});

test('accountants can read a real member follow-up and create a call log', async () => {
  commitments=[];callLogs=[];reminders=[];dueAmount=100;
  const before=await request('/members/member/follow-up','GET',undefined,'accountant');
  assert.equal(before.status,200);assert.equal(before.body.data.member.id,'member');assert.equal(before.body.data.outstanding,100);
  const saved=await request('/members/member/call-logs','POST',{outcome:'dispute',summary:'Member requested a review of the amount'},'accountant');
  assert.equal(saved.status,201);assert.equal(saved.body.data.call_log.outcome,'dispute');
  const after=await request('/members/member/follow-up','GET',undefined,'accountant');
  assert.equal(after.status,200);assert.equal(after.body.data.timeline[0].kind,'call_log');assert.equal(after.body.data.timeline[0].summary,'Member requested a review of the amount');
  const promised=await request('/members/member/call-logs','POST',{outcome:'committed',summary:'Will pay next week',commitment:{promised_date:plusDays(7),amount:100}},'accountant');
  assert.equal(promised.status,201);assert.equal(promised.body.data.active_commitment.amount,100);
  const timeline=await request('/members/member/follow-up','GET',undefined,'accountant');
  assert.equal(timeline.body.data.timeline.find(item=>item.kind==='commitment').created_by_name,'Staff User');
});
test('accountant log access does not allow reminders, resolution or ranking', async () => {
  assert.equal((await request('/members/member/reminders','POST',undefined,'accountant')).status,403);
  assert.equal((await request('/commitments/any/resolve','POST',{status:'kept',reason:'Payment received'},'accountant')).status,403);
  assert.equal((await request('/follow-ups/reliability','GET',undefined,'accountant')).status,403);
  assert.equal((await request('/members/member/follow-up','GET',undefined,'member')).status,403);
  assert.equal((await request('/members/member/call-logs','POST',{outcome:'no_answer'},'auditor')).status,403);
});

test('follow-up detail, queue and ranking include the member photo without private profile fields', async () => {
  commitments=[];callLogs=[];reminders=[];dueAmount=100;
  memberProfile={photo_file_id:'member-photo',father_name:'Private profile field'};
  const saved=await request('/members/member/call-logs','POST',{outcome:'committed',summary:'Will pay tomorrow',commitment:{promised_date:plusDays(1),amount:100}});
  assert.equal(saved.status,201);
  for (const path of ['/members/member/follow-up','/follow-ups?tab=upcoming','/follow-ups/reliability']) {
    const result=await request(path,'GET');
    assert.equal(result.status,200);
    const member=result.body.data.member??result.body.data.items[0].member;
    assert.deepEqual(member.profile,{photo_file_id:'member-photo'});
  }
});
test('missing or invalid member photo metadata returns null for the initials fallback', async () => {
  try {
    for (const profile of [null, {}, {photo_file_id:42}, ['invalid'], {photo_file_id:''}]) {
      memberProfile=profile;
      const result=await request('/members/member/follow-up','GET');
      assert.equal(result.status,200);
      assert.deepEqual(result.body.data.member.profile,{photo_file_id:null});
    }
  } finally {
    memberProfile={photo_file_id:'member-photo'};
  }
});
