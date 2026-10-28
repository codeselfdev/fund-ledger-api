import { createHash } from 'node:crypto';
import { z } from 'zod';
import { forbidden, notFound, badRequest, conflict } from '../../core/http/api-error.js';
import { prisma } from '../../core/prisma/client.js';
import { getMemberOutstanding } from '../dues/outstanding.service.js';
import { assertPromiseDate, compareDateOnly, dhakaToday, dateKey } from './followups.policy.js';
import { commitmentPayload } from './followups.service.js';

export const selfCommitmentSchema=z.object({member_id:z.string().min(1).max(100).optional(),request_key:z.string().uuid(),amount:z.number().int().positive().max(2147483647),promised_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),comment:z.string().trim().min(3).max(500),previous_commitment_id:z.string().min(1).max(100).nullable()}).strict();
type Auth={tenantId:string;projectId:string;userId:string;memberId:string|null;memberIds?:string[]};
function ownMember(auth:Auth,requested?:string){
 const id=requested??auth.memberId;
 if(!id||id!==auth.memberId&&!auth.memberIds?.includes(id))throw forbidden('Choose one of your own linked member records.');
 return id;
}
export async function memberCommitment(auth:Auth,requested?:string){
 const memberId=ownMember(auth,requested),scope={tenantId:auth.tenantId,projectId:auth.projectId,memberId};
 const member=await prisma.member.findFirst({where:{id:memberId,tenantId:auth.tenantId,projectId:auth.projectId,userId:auth.userId,status:'active'},select:{id:true,name:true}});
 if(!member)throw notFound('Your active member record was not found.');
 const [outstanding,active]=await Promise.all([getMemberOutstanding(auth.tenantId,auth.projectId,memberId),prisma.paymentCommitment.findFirst({where:{...scope,status:{in:['pending','broken']},supersededById:null,resolvedAt:null},orderBy:[{createdAt:'desc'},{id:'desc'}]})]);
 return {member,today:dateKey(dhakaToday()),outstanding,active_commitment:active?commitmentPayload(active):null};
}
export async function saveMemberCommitment(auth:Auth,body:z.infer<typeof selfCommitmentSchema>){
 const memberId=ownMember(auth,body.member_id),scope={tenantId:auth.tenantId,projectId:auth.projectId,memberId};
 const id='self_'+createHash('sha256').update(JSON.stringify([auth.tenantId,auth.projectId,auth.userId,memberId,body.request_key])).digest('hex');
 return prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM members WHERE id = ${memberId} AND tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} FOR UPDATE`;
  const member=await tx.member.findFirst({where:{id:memberId,tenantId:auth.tenantId,projectId:auth.projectId,userId:auth.userId,status:'active'},select:{id:true}});
  if(!member)throw notFound('Your active member record was not found.');
  const existing=await tx.paymentCommitment.findUnique({where:{id}});
  if(existing){
   if(existing.amount!==body.amount||dateKey(existing.promisedDate)!==body.promised_date||existing.summary!==body.comment)throw conflict('This request key belongs to another commitment.');
   return commitmentPayload(existing);
  }
  const promisedDate=assertPromiseDate(body.promised_date),outstanding=await getMemberOutstanding(auth.tenantId,auth.projectId,memberId,tx);
  if(outstanding<=0)throw badRequest('You have no outstanding dues.');
  if(body.amount>outstanding)throw badRequest('Commitment amount cannot exceed current outstanding dues.');
  const pending=await tx.paymentCommitment.findMany({where:{...scope,status:{in:['pending','broken']},supersededById:null,resolvedAt:null},orderBy:[{createdAt:'desc'},{id:'desc'}]});
  if((pending[0]?.id??null)!==body.previous_commitment_id)throw conflict('Your payment commitment changed. Refresh before choosing another date.');
  const current=pending.filter(item=>item.status==='pending');
  for(const item of current){
   const status=compareDateOnly(item.promisedDate,dhakaToday())<0?'broken':'rescheduled';
   await tx.paymentCommitment.update({where:{id:item.id},data:{status}});
   await tx.activity.create({data:{tenantId:auth.tenantId,projectId:auth.projectId,actorUserId:auth.userId,action:`commitment.${status}`,entityType:'payment_commitment',entityId:item.id}});
  }
  const saved=await tx.paymentCommitment.create({data:{id,...scope,amount:body.amount,promisedDate,summary:body.comment,outstandingAtCreate:outstanding,createdById:auth.userId}});
  const rescheduled=current.filter(item=>compareDateOnly(item.promisedDate,dhakaToday())>=0);
  if(rescheduled.length)await tx.paymentCommitment.updateMany({where:{id:{in:rescheduled.map(item=>item.id)}},data:{supersededById:saved.id}});
  await tx.activity.create({data:{tenantId:auth.tenantId,projectId:auth.projectId,actorUserId:auth.userId,action:'commitment.self_created',entityType:'payment_commitment',entityId:saved.id,after:{amount:body.amount,promised_date:body.promised_date,comment:body.comment}}});
  return commitmentPayload(saved);
 });
}
