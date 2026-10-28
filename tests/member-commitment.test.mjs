import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../dist/core/prisma/client.js';
import { memberCommitment,saveMemberCommitment,selfCommitmentSchema } from '../dist/modules/follow-ups/member-commitment.js';
import { dhakaDateKey,addDateDays,dateKey } from '../dist/modules/follow-ups/followups.policy.js';
const auth={tenantId:'tenant',projectId:'project',userId:'user',memberId:'mine',memberIds:['mine','mine-2']};
let records=[],activities=[],outstanding=500,reads=[];
function reset(){records=[];activities=[];reads=[];outstanding=500;}
const same=(row,where)=>row.tenantId===where.tenantId&&row.projectId===where.projectId&&row.memberId===where.memberId;
prisma.member.findFirst=async({where})=>{reads.push(where);return where.tenantId==='tenant'&&where.projectId==='project'&&where.userId==='user'&&auth.memberIds.includes(where.id)?{id:where.id,name:'My name'}:null;};
prisma.due.findMany=async()=>outstanding?[{amount:outstanding,paidAmount:0,waivedAmount:0,penaltyDue:0,penaltyPaid:0}]:[];
prisma.paymentCommitment.findMany=async({where})=>records.filter(row=>same(row,where)&&where.status.in.includes(row.status)&&!row.supersededById&&!row.resolvedAt).sort((a,b)=>b.createdAt-a.createdAt);
prisma.paymentCommitment.findFirst=async args=>(await prisma.paymentCommitment.findMany(args))[0]??null;
prisma.paymentCommitment.findUnique=async({where})=>records.find(row=>row.id===where.id)??null;
prisma.paymentCommitment.create=async({data})=>{const row={...data,status:'pending',createdAt:new Date(Date.now()+records.length),updatedAt:new Date(),resolvedAt:null,supersededById:null};records.push(row);return row;};
prisma.paymentCommitment.update=async({where,data})=>Object.assign(records.find(row=>row.id===where.id),data);
prisma.paymentCommitment.updateMany=async({where,data})=>{records.filter(row=>where.id.in.includes(row.id)).forEach(row=>Object.assign(row,data));return{count:where.id.in.length};};
prisma.activity.create=async({data})=>{activities.push(data);return data;};
prisma.$queryRaw=async()=>[];
let queue=Promise.resolve();prisma.$transaction=fn=>{const result=queue.then(()=>fn(prisma));queue=result.catch(()=>{});return result;};
const body=(extra={})=>({request_key:randomUUID(),amount:500,promised_date:dateKey(addDateDays(dhakaDateKey(),7)),comment:'I will pay next week.',previous_commitment_id:null,...extra});
test('members see only their own current dues and commitment without staff call logs or reliability data',async()=>{
 reset();const response=await memberCommitment(auth);assert.equal(response.outstanding,500);assert.equal(response.member.id,'mine');assert.equal(response.active_commitment,null);assert.equal(response.timeline,undefined);assert.equal(response.reliability,undefined);assert.equal(reads[0].userId,'user');
 await assert.rejects(memberCommitment(auth,'someone-else'));await assert.rejects(memberCommitment({...auth,tenantId:'other'}));await assert.rejects(memberCommitment({...auth,projectId:'other'}));
 assert.equal((await memberCommitment(auth,'mine-2')).member.id,'mine-2');
});
test('self commitments retain comment/date/amount, are auditable and retry exactly once without creating a call log',async()=>{
 reset();const input=body(),[a,b]=await Promise.all([saveMemberCommitment(auth,input),saveMemberCommitment(auth,input)]);assert.equal(a.id,b.id);assert.equal(records.length,1);assert.equal(records[0].summary,input.comment);assert.equal(records[0].createdById,'user');assert.equal(records[0].callLogId,undefined);assert.equal(activities.filter(row=>row.action==='commitment.self_created').length,1);
 await assert.rejects(saveMemberCommitment(auth,{...input,comment:'Different comment'}));assert.equal(records.length,1);
});
test('stale reschedules, overpayments, no-dues, invalid dates and another member are rejected',async()=>{
 reset();const saved=await saveMemberCommitment(auth,body());await assert.rejects(saveMemberCommitment(auth,body()),/changed/);
 await assert.rejects(saveMemberCommitment(auth,body({previous_commitment_id:saved.id,amount:501})),/exceed/);
 for(const date of ['2026-02-30',dateKey(addDateDays(dhakaDateKey(),-1)),dateKey(addDateDays(dhakaDateKey(),91))])await assert.rejects(saveMemberCommitment(auth,body({previous_commitment_id:saved.id,promised_date:date})));
 await assert.rejects(saveMemberCommitment(auth,body({member_id:'another'})));outstanding=0;await assert.rejects(saveMemberCommitment(auth,body({previous_commitment_id:saved.id})),/no outstanding/);
 assert.equal(records.length,1);assert.equal(selfCommitmentSchema.safeParse(body({comment:' '})).success,false);
});
test('a member can reschedule a current promise, while a missed promise remains recorded',async()=>{
 reset();const first=await saveMemberCommitment(auth,body());const second=await saveMemberCommitment(auth,body({previous_commitment_id:first.id,amount:300,comment:'A partial payment first.'}));assert.equal(records[0].status,'rescheduled');assert.equal(records[0].supersededById,second.id);
 records[1].promisedDate=addDateDays(dhakaDateKey(),-2);const third=await saveMemberCommitment(auth,body({previous_commitment_id:second.id}));assert.equal(records[1].status,'broken');assert.equal(third.status,'pending');assert.equal(records[1].supersededById,null);
});
