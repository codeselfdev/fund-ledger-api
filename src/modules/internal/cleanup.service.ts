import {subscriptionContext} from "../../core/subscription/subscription.repository.js";
import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { env } from "../../config/env.js";
import { ApiError, badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { addCalendarMonths } from "../../core/subscription/packages.js";
import { evaluateSubscription, getStoredSubscription } from "../../core/subscription/subscription.service.js";
import { purgeObject, tenantObjectKeys } from "../../core/storage/object-storage.service.js";

export function cleanupEligibility(contact: unknown, now = new Date()) {
  const subscription = getStoredSubscription(contact), access = evaluateSubscription(contact, now);
  const raw = subscription?.current_period_end_at;
  const base = raw ? new Date(raw) : null;
  const at = base && !Number.isNaN(base.getTime()) ? addCalendarMonths(base,3) : null;
  return { basis: "paid_expiry", eligible_at: at?.toISOString() ?? null, eligible: !!at && at <= now && !access.has_access,
    reason: !at ? "No paid subscription expiry is recorded" : access.has_access ? "Organization still has an active subscription or trial" : at > now ? "Three calendar months have not elapsed" : "Retention period elapsed" };
}
type CleanupDb = Prisma.TransactionClient;
async function eligibilityFor(db: CleanupDb, tenant: { id: string; contact: unknown; subscription: import("@prisma/client").TenantSubscription | null }) {
  return cleanupEligibility(subscriptionContext(tenant));
}
const tokenData = (tenant: {id:string;updatedAt:Date}, eligibility: unknown) => createHash("sha256").update(JSON.stringify([tenant.id,tenant.updatedAt,eligibility])).digest("hex");
function sign(value: string) { return createHmac("sha256",env.internalApiKey!).update(value).digest("hex"); }
function deletionModels() {
  const models = Prisma.dmmf.datamodel.models.filter(m=>m.name!=="InternalAudit"&&m.name!=="TenantDeletionJob"&&m.name!=="SubscriptionHistory"&&m.fields.some(f=>f.name==="tenantId"));
  const remaining = new Map(models.map(m=>[m.name,m])), ordered: typeof models = [];
  while(remaining.size) {
    const leaves = [...remaining.values()].filter(parent=>![...remaining.values()].some(child=>child.name!==parent.name&&child.fields.some(f=>f.relationFromFields?.length&&f.type===parent.name)));
    if(!leaves.length) throw new Error("Schema contains a deletion dependency cycle; cleanup stopped");
    for(const leaf of leaves) { ordered.push(leaf);remaining.delete(leaf.name); }
  }
  return ordered;
}
export const tenantDeletionOrder = () => deletionModels().map(m=>m.name);
async function assertNoForeignReferences(tx:CleanupDb,tenantId:string) {
  const models=Prisma.dmmf.datamodel.models,quote=(name:string)=>Prisma.raw(`"${name.replace(/"/g,'""')}"`);
  for(const child of models.filter(m=>m.fields.some(f=>f.name==="tenantId")))for(const relation of child.fields.filter(f=>f.relationFromFields?.length)) {
    const parent=models.find(m=>m.name===relation.type);
    if(!parent?.fields.some(f=>f.name==="tenantId")||parent.name==="Tenant")continue;
    const join=Prisma.join(relation.relationFromFields!.map((field,i)=>{
      const local=child.fields.find(f=>f.name===field)!,target=parent.fields.find(f=>f.name===relation.relationToFields![i])!;
      return Prisma.sql`c.${quote(local.dbName??local.name)}=p.${quote(target.dbName??target.name)}`;
    })," AND ");
    const rows=await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT 1 FROM ${quote(child.dbName??child.name)} c JOIN ${quote(parent.dbName??parent.name)} p ON ${join} WHERE c.tenant_id<>${tenantId} AND p.tenant_id=${tenantId} LIMIT 1`);
    if(rows.length)throw conflict("Records in another organization reference this organization. Resolve those links before cleanup.");
  }
}
export async function cleanupPreview(tenantId: string) {
  const tenant=await prisma.tenant.findUnique({ include: { subscription: true }, where:{id:tenantId}});if(!tenant)throw notFound("Organization not found");
  const eligibility=await eligibilityFor(prisma,tenant);
  const counts: Record<string,number> = {};
  for(const model of deletionModels()) {
    const table=(prisma as unknown as Record<string,{count(args:unknown):Promise<number>}>)[model.name[0]!.toLowerCase()+model.name.slice(1)]!;
    counts[model.name]=await table.count({where:{tenantId}});
  }
  const content=Buffer.from(JSON.stringify({snapshot:tokenData(tenant,eligibility),expires:Date.now()+15*60000})).toString("base64url");
  return { tenant_id:tenant.id,slug:tenant.slug,eligibility,counts,confirmation:`DELETE ${tenant.slug}`,preview_token:`${content}.${sign(content)}`,warning:"Permanent deletion includes all organization records and its R2/local storage prefix. This preview does not delete data." };
}
export async function beginCleanup(tenantId:string, token:string, confirmation:string, actor:string) {
  const [content,signature]=token.split(".");
  if(!content||!signature||!/^[a-f0-9]{64}$/.test(signature)||!timingSafeEqual(Buffer.from(signature,"hex"),Buffer.from(sign(content),"hex")))throw badRequest("Invalid cleanup preview token");
  let parsed:{snapshot:string;expires:number};try{parsed=JSON.parse(Buffer.from(content,"base64url").toString());}catch{throw badRequest("Invalid cleanup preview token");}
  if(!Number.isFinite(parsed.expires)||parsed.expires<Date.now())throw conflict("Cleanup preview expired. Review it again.");
  return prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM tenants WHERE id=${tenantId} FOR NO KEY UPDATE`;
    const tenant=await tx.tenant.findUnique({ include: { subscription: true }, where:{id:tenantId}});if(!tenant)throw notFound("Organization not found");
    if(confirmation!==`DELETE ${tenant.slug}`)throw badRequest("Organization deletion confirmation does not match");
    const previous=await tx.tenantDeletionJob.findUnique({where:{tenantId}});if(previous)return previous;
    const eligibility=await eligibilityFor(tx,tenant);
    if(!eligibility.eligible)throw conflict(eligibility.reason);
    if(parsed.snapshot!==tokenData(tenant,eligibility))throw conflict("Organization or payment changed. Review cleanup again.");
    const users=await tenantAccounts(tx).findMany({where:{tenantId},select:{id:true}});
    await assertNoForeignReferences(tx,tenantId);
    const [uploads,attachments,reports,aiImages]=await Promise.all([tx.upload.findMany({where:{tenantId},select:{storageKey:true}}),tx.supportAttachment.findMany({where:{tenantId},select:{storageKey:true}}),tx.reportExport.findMany({where:{tenantId},select:{files:true}}),tx.assistantAttachment.findMany({where:{tenantId},select:{storageKey:true}})]);
    const reportKeys=reports.flatMap(r=>Array.isArray(r.files)?r.files.flatMap(f=>f&&typeof f==="object"&&!Array.isArray(f)&&typeof f.storage_key==="string"?[f.storage_key]:[]):[]);
    if([...uploads.map(u=>u.storageKey),...attachments.map(u=>u.storageKey),...aiImages.map(u=>u.storageKey),...reportKeys].some(key=>!key.startsWith(`${tenantId}/`)))throw conflict("Legacy storage keys are outside this organization's prefix. Migrate them before cleanup.");
    deletionModels();
    await tx.tenant.update({ include: { subscription: true }, where:{id:tenantId},data:{deletionStartedAt:new Date()}});
    await tenantAccounts(tx).updateMany({where:{tenantId},data:{isActive:false}});
    await tx.project.updateMany({where:{tenantId},data:{isActive:false}});
    await tx.session.updateMany({where:{tenantId},data:{revokedAt:new Date()}});
    await tx.reportSchedule.updateMany({where:{tenantId},data:{enabled:false}});
    await tx.recurringSchedule.updateMany({where:{tenantId},data:{isActive:false}});
    await tx.notificationDelivery.updateMany({where:{campaign:{tenantId},status:{in:["pending","processing"]}},data:{status:"failed",error:"Organization cleanup started"}});
    await tx.assistantReply.updateMany({where:{tenantId,status:{notIn:["completed","sent","failed"]}},data:{status:"failed",errorCode:"ORGANIZATION_DELETING",leaseUntil:null}});
    const job=await tx.tenantDeletionJob.create({data:{tenantId,actor}});
    await tx.internalAudit.create({data:{tenantId,actor,action:"tenant.cleanup_started",metadata:{job_id:job.id,basis:eligibility.basis}}});
    return job;
  },{timeout:30000});
}
/** An explicit bounded call drains storage first. A storage failure leaves all DB metadata for retry. */
export async function runCleanup(jobId:string,actor:string) {
  const before=await prisma.tenantDeletionJob.findUnique({where:{id:jobId}});if(!before)throw notFound("Cleanup job not found");
  if(before.status==="completed")return before;
  const runAfter=new Date(before.createdAt.getTime()+300000);
  if(runAfter>new Date())return{...before,run_after_at:runAfter};
  const lease=new Date(Date.now()+300000);
  const claimed=await prisma.tenantDeletionJob.updateMany({where:{id:jobId,status:{not:"completed"},OR:[{leaseUntil:null},{leaseUntil:{lt:new Date()}}]},data:{status:"running",leaseUntil:lease,error:null}});
  const job=await prisma.tenantDeletionJob.findUnique({where:{id:jobId}});if(!job)throw notFound("Cleanup job not found");
  if(!claimed.count){if(job.status==="completed")return job;throw conflict("Cleanup is already running");}
  try{
    const current=await prisma.tenant.findUnique({ include: { subscription: true }, where:{id:job.tenantId}});
    if(current&&(!current.deletionStartedAt||!(await eligibilityFor(prisma,current)).eligible))throw conflict("Organization is not eligible for cleanup");
    const keys=await tenantObjectKeys(job.tenantId,25);
    for(const key of keys){await purgeObject(key);const owned=await prisma.tenantDeletionJob.updateMany({where:{id:jobId,leaseUntil:lease},data:{objectsDeleted:{increment:1}}});if(!owned.count)throw conflict("Cleanup lease expired. Retry from the current job state.");}
    if(keys.length){await prisma.tenantDeletionJob.updateMany({where:{id:jobId,leaseUntil:lease},data:{status:"pending",leaseUntil:null}});return await prisma.tenantDeletionJob.findUniqueOrThrow({where:{id:jobId}});}
    return await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM tenant_deletion_jobs WHERE id=${jobId} FOR UPDATE`;
      const owned=await tx.tenantDeletionJob.findFirst({where:{id:jobId,leaseUntil:lease}});if(!owned)throw conflict("Cleanup lease expired");
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${job.tenantId} FOR NO KEY UPDATE`;
      const tenant=await tx.tenant.findUnique({ include: { subscription: true }, where:{id:job.tenantId}});
      if(tenant){
        if(!tenant.deletionStartedAt)throw conflict("Organization is not frozen for cleanup");
        const eligible=await eligibilityFor(tx,tenant);if(!eligible.eligible)throw conflict("Subscription changed; cleanup stopped");
        const identities=await tx.tenantUser.findMany({where:{tenantId:job.tenantId},select:{userId:true}});
        for(const model of deletionModels()){
          const table=(tx as unknown as Record<string,{deleteMany(args:unknown):Promise<unknown>}>)[model.name[0]!.toLowerCase()+model.name.slice(1)]!;
          await table.deleteMany({where:{tenantId:job.tenantId}});
        }
        await tx.tenant.delete({where:{id:job.tenantId}});
        await tx.user.deleteMany({where:{id:{in:identities.map(row=>row.userId)},tenantMemberships:{none:{}}}});
      }
      await tx.internalAudit.create({data:{tenantId:job.tenantId,actor,action:"tenant.cleanup_completed",metadata:{job_id:jobId}}});
      return tx.tenantDeletionJob.update({where:{id:jobId},data:{status:"completed",leaseUntil:null,completedAt:new Date(),error:null}});
    },{timeout:60000});
  }catch(error){await prisma.tenantDeletionJob.updateMany({where:{id:jobId,leaseUntil:lease},data:{status:"failed",leaseUntil:null,error:"Cleanup failed; inspect server logs and retry"}});throw error;}
}
