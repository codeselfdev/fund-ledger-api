import type { Prisma } from '@prisma/client';
import { badRequest, conflict, forbidden } from '../../core/http/api-error.js';
import { tenantAccounts } from '../../core/identity/tenant-accounts.js';
import { assertPersonCapacity } from '../../core/subscription/quota.service.js';
import { businessPhoneIdentity } from '../business-setup/contract.js';
type Db=Prisma.TransactionClient;
type Auth={tenantId:string;projectId:string;userId:string};
type MemberRow={name:string;mobile:string;shares:number;email?:string;address?:string};
/** Previews are create-only and retain the member snapshot so confirmation can detect changes. */
export async function memberBatchPlan(db:Db,a:Auth,rows:MemberRow[]){
 const project=await db.project.findFirstOrThrow({where:{id:a.projectId,tenantId:a.tenantId,isActive:true}});
 if(project.projectType!=='fund_shares')throw forbidden('Add members in a Fund / Shares project.');
 const members=await db.member.findMany({where:{tenantId:a.tenantId,projectId:a.projectId},orderBy:{id:'asc'},select:{id:true,name:true,mobile:true,email:true,shares:true,status:true,updatedAt:true}});
 const seen=new Set<string>();
 let shares=members.filter(member=>member.status==='active').reduce((sum,member)=>sum+member.shares,0);
 const entries=rows.map((row,index)=>{
  const phone=businessPhoneIdentity(row.mobile);
  if(seen.has(phone))throw conflict(`Row ${index+1}: mobile: This mobile number is repeated in the member list.`);
  if(members.some(member=>businessPhoneIdentity(member.mobile)===phone))throw conflict(`Row ${index+1}: mobile: This mobile number belongs to an existing member. Review that member instead of creating a duplicate.`);
  seen.add(phone);shares+=row.shares;
  if(!Number.isSafeInteger(shares)||shares>project.totalShares)throw badRequest(`Row ${index+1}: shares: Total member shares exceed the project's limit of ${project.totalShares}.`);
  return{row:index+1,...row,mobile:phone,status:'create'};
 });
 return{entries,total_shares:project.totalShares,assigned_shares:shares,members_snapshot:members.map(member=>[member.id,member.updatedAt instanceof Date?member.updatedAt.toISOString():member.updatedAt,member.status,member.shares])};
}
export async function saveBatchMember(db:Db,a:Auth,row:MemberRow){
 await assertPersonCapacity(a.tenantId,row,db);
 let account=await tenantAccounts(db).findFirst({where:{tenantId:a.tenantId,mobile:row.mobile}});
 if(account&&!account.isActive)throw conflict('This member account is suspended. Ask an administrator to review it.');
 if(!account)account=await tenantAccounts(db).create({data:{tenantId:a.tenantId,name:row.name,mobile:row.mobile,email:row.email}});
 const member=await db.member.create({data:{tenantId:a.tenantId,projectId:a.projectId,userId:account.id,name:row.name,mobile:row.mobile,email:row.email,address:row.address,shares:row.shares}});
 await db.projectMembership.upsert({where:{projectId_userId_role:{projectId:a.projectId,userId:account.id,role:'member'}},update:{isActive:true},create:{tenantId:a.tenantId,projectId:a.projectId,userId:account.id,memberId:member.id,role:'member'}});
 await db.activity.create({data:{tenantId:a.tenantId,projectId:a.projectId,actorUserId:a.userId,action:'member.created',entityType:'member',entityId:member.id,after:{name:member.name,mobile:member.mobile,shares:member.shares}}});
 return member;
}
