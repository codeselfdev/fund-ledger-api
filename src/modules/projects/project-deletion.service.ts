import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { env } from '../../config/env.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { purgeObject, projectObjectKeys } from '../../core/storage/object-storage.service.js';
type Scope = { tenantId: string; userId: string; sessionId: string; impersonation?: unknown };
type Db = Prisma.TransactionClient;
const scoped = (a: Scope, projectId: string) => ({ tenantId: a.tenantId, projectId });
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const sign = (v: string) => createHmac('sha256', env.jwtSecret).update('project-deletion:' + v).digest('hex');
const quote = (v: string) => Prisma.raw('"' + v.replace(/"/g,'""') + '"');
export function projectDeletionModels() {
  const models = Prisma.dmmf.datamodel.models.filter(m => m.name !== 'ProjectDeletionJob' && m.fields.some(f => f.name === 'projectId'));
  const pending = new Map(models.map(m => [m.name,m])), ordered: typeof models = [];
  while (pending.size) {
    const leaves = [...pending.values()].filter(p => ![...pending.values()].some(c => c.name !== p.name && c.fields.some(f => f.relationFromFields?.length && f.type === p.name)));
    if (!leaves.length) throw new Error('Schema deletion dependency cycle; cleanup stopped');
    for (const m of leaves) { ordered.push(m); pending.delete(m.name); }
  }
  return ordered;
}
function table(db: Db, name: string) { return (db as unknown as Record<string, { count(args: unknown): Promise<number>; deleteMany(args: unknown): Promise<unknown> }>)[name[0]!.toLowerCase()+name.slice(1)]!; }
async function admin(db: Db, a: Scope, projectId: string) {
  if (a.impersonation || !await db.projectMembership.findFirst({ where: { ...scoped(a,projectId), userId: a.userId, isActive: true, customRoleId: null, role: { in: ['owner','admin'] } } })) throw forbidden('Only a built-in project owner or admin can delete this project');
}
async function assertNoForeignReferences(db: Db, a: Scope, projectId: string) {
  const models = Prisma.dmmf.datamodel.models;
  for (const child of models) for (const rel of child.fields.filter(f => f.relationFromFields?.length)) {
    const parent = models.find(m => m.name === rel.type);
    if (!parent?.fields.some(f => f.name === 'projectId') || !child.fields.some(f => f.name === 'projectId')) continue;
    const join = Prisma.join(rel.relationFromFields!.map((field,i) => {
      const local = child.fields.find(f => f.name === field)!, target = parent.fields.find(f => f.name === rel.relationToFields![i])!;
      return Prisma.sql`c.${quote(local.dbName ?? local.name)}=p.${quote(target.dbName ?? target.name)}`;
    }), ' AND ');
    const rows = await db.$queryRaw<unknown[]>(Prisma.sql`SELECT 1 FROM ${quote(child.dbName ?? child.name)} c JOIN ${quote(parent.dbName ?? parent.name)} p ON ${join} WHERE p.tenant_id=${a.tenantId} AND p.project_id=${projectId} AND (c.project_id IS DISTINCT FROM ${projectId} OR c.tenant_id<>${a.tenantId}) LIMIT 1`);
    if (rows.length) throw conflict('Another project references these records. Resolve shared or transferred records before deletion.');
  }
  if (await db.fixedAsset.count({ where: { tenantId: a.tenantId, projectId: { not: projectId }, OR: [{ depreciationSourceId: projectId }, { accountId: { in: (await db.account.findMany({ where: scoped(a,projectId), select: { id: true } })).map(r=>r.id) } }] } })) throw conflict('Transferred assets still depend on this project. Resolve their history before deletion.');
}
async function snapshot(db: Db, a: Scope, projectId: string) {
  const project = await db.project.findFirst({ where: { id: projectId, tenantId: a.tenantId } });
  if (!project) throw notFound('Project not found');
  const counts: Record<string,number> = {};
  for (const m of projectDeletionModels()) counts[m.name] = await table(db,m.name).count({ where: scoped(a,projectId) });
  return { project, counts, hash: digest([project.id,project.name,project.projectType,project.updatedAt,counts]) };
}
export async function projectDeletionPreview(a: Scope, projectId: string) {
  const previous = await prisma.projectDeletionJob.findFirst({ where: { projectId,tenantId:a.tenantId } });
  if (previous && previous.userId === a.userId) return { job: publicJob(previous) };
  await admin(prisma,a,projectId);
  if (previous) return { job: publicJob(previous) };
  const s = await snapshot(prisma,a,projectId), blockers: string[] = [];
  try { await assertNoForeignReferences(prisma,a,projectId); } catch (e) { blockers.push((e as Error).message); }
  const content = Buffer.from(JSON.stringify({ projectId, tenantId: a.tenantId, sessionId: a.sessionId, hash: s.hash, expires: Date.now()+10*60000 })).toString('base64url');
  return { project_id: projectId, name: s.project.name, project_type: s.project.projectType, counts: s.counts, blockers, confirmation: `DELETE ${s.project.name}`, preview_token: content+'.'+sign(content),
    warning: 'Permanently removes this project, its records, documents and R2/local files. Organization accounts, other projects and a minimal deletion receipt remain.' };
}
export async function beginProjectDeletion(a: Scope, projectId: string, input: { confirmation: string; preview_token: string; reason: string }) {
  const [content,signature] = input.preview_token.split('.');
  if (!content || !signature || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(sign(content),'hex'))) throw badRequest('Invalid deletion review. Review this project again.');
  let p: { tenantId: string; projectId: string; sessionId: string; hash: string; expires: number };
  try { p=JSON.parse(Buffer.from(content,'base64url').toString()); } catch { throw badRequest('Invalid deletion review'); }
  if (p.tenantId !== a.tenantId || p.projectId !== projectId || p.sessionId !== a.sessionId || !Number.isFinite(p.expires) || p.expires < Date.now()) throw conflict('Deletion review expired or belongs to another session. Review again.');
  return prisma.$transaction(async tx => {
    // The exclusive lock waits for in-flight storage writes and database mutations.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))::text`;
    await admin(tx,a,projectId);
    const old=await tx.projectDeletionJob.findUnique({where:{projectId}}); if(old) return publicJob(old);
    const s=await snapshot(tx,a,projectId);
    if(input.confirmation !== `DELETE ${s.project.name}`) throw badRequest('Type the exact project deletion confirmation');
    if(p.hash !== s.hash) throw conflict('Project records changed. Review the deletion scope again.');
    await assertNoForeignReferences(tx,a,projectId);
    const scope=scoped(a,projectId);
    const [uploads,attachments,reports] = await Promise.all([
      tx.upload.findMany({where:scope,select:{storageKey:true}}),
      tx.assistantAttachment.findMany({where:{tenantId:a.tenantId,reply:{projectId}},select:{storageKey:true}}),
      tx.reportExport.findMany({where:scope,select:{files:true}})
    ]);
    const reportKeys=reports.flatMap(r=>Array.isArray(r.files)?r.files.flatMap(f=>f&&typeof f==='object'&&!Array.isArray(f)&&typeof f.storage_key==='string'?[f.storage_key]:[]):[]);
    const keys=[...new Set([...uploads.map(r=>r.storageKey),...attachments.map(r=>r.storageKey),...reportKeys])].sort();
    const prefix=`${a.tenantId}/${projectId}/`, legacyPrefix=`${a.tenantId}/assistant/`;
    if(keys.some(k=>!k.startsWith(prefix)&&!attachments.some(r=>r.storageKey===k&&k.startsWith(legacyPrefix)))) throw conflict('A document has a legacy or shared storage path. Migrate it before deleting this project.');
    // Stop queued work before setting the database write barrier.
    await tx.reportSchedule.updateMany({where:scope,data:{enabled:false}});
    await tx.recurringSchedule.updateMany({where:scope,data:{isActive:false}});
    await tx.assistantReply.updateMany({where:scope,data:{status:'failed',leaseUntil:null,errorCode:'PROJECT_DELETING'}});
    await tx.notificationDelivery.updateMany({where:{campaign:scope,status:{in:['pending','processing']}},data:{status:'failed',error:'Project deletion started'}});
    const remainingProject=await tx.project.findFirst({where:{tenantId:a.tenantId,id:{not:projectId},deletionStartedAt:null,isActive:true},orderBy:{createdAt:'asc'}});
    if(remainingProject)await tx.onboardingProgress.updateMany({where:scope,data:{projectId:remainingProject.id}});
    await tx.project.update({where:{id:projectId},data:{isActive:false,deletionStartedAt:new Date()}});
    const job=await tx.projectDeletionJob.create({data:{...scope,userId:a.userId,reason:input.reason,manifest:keys}});
    await tx.internalAudit.create({data:{tenantId:a.tenantId,actor:a.userId,action:'project.deletion_started',metadata:{job_id:job.id,project_id:projectId,project_type:s.project.projectType}}});
    return publicJob(job);
  },{timeout:30000});
}
export const publicJob = (j: { id: string; projectId: string; status: string; objectsDeleted: number; error: string|null; completedAt: Date|null; createdAt: Date }) => ({ id:j.id, project_id:j.projectId, status:j.status, objects_deleted:j.objectsDeleted, error:j.error, completed_at:j.completedAt, created_at:j.createdAt });
export async function deletionJob(a: Scope, id: string) {
  if(a.impersonation)throw forbidden('Support sessions cannot manage project deletion');
  const j=await prisma.projectDeletionJob.findFirst({where:{id,tenantId:a.tenantId}}); if(!j)throw notFound('Deletion job not found');
  if(j.userId!==a.userId)await admin(prisma,a,j.projectId);
  return publicJob(j);
}
/** Bounded, leased work; storage failure preserves the manifest and every database record. */
export async function runProjectDeletion(id: string, dependencies={ purgeObject, projectObjectKeys }) {
  const lease=new Date(Date.now()+120000);
  const claim=await prisma.projectDeletionJob.updateMany({where:{id,status:{in:['pending','running','failed']},OR:[{leaseUntil:null},{leaseUntil:{lt:new Date()}}]},data:{status:'running',leaseUntil:lease,error:null}});
  if(!claim.count)return;
  const job=await prisma.projectDeletionJob.findUniqueOrThrow({where:{id}});
  const owned={id,leaseUntil:lease};
  try {
    const project=await prisma.project.findFirst({where:{id:job.projectId,tenantId:job.tenantId,deletionStartedAt:{not:null},isActive:false}});
    if(!project)throw conflict('Project is not locked for deletion');
    const manifest=job.manifest as string[];
    const keys=job.cursor<manifest.length?manifest.slice(job.cursor,job.cursor+25):await dependencies.projectObjectKeys(job.tenantId,job.projectId,25);
    // Parallel groups of five keep the lease bounded even on provider timeouts.
    for(let i=0;i<keys.length;i+=5)await Promise.all(keys.slice(i,i+5).map(k=>dependencies.purgeObject(k)));
    if(keys.length){
      await prisma.projectDeletionJob.updateMany({where:owned,data:{status:'pending',leaseUntil:null,objectsDeleted:{increment:keys.length},cursor:Math.min(manifest.length,job.cursor+keys.length)}});return;
    }
    await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM project_deletion_jobs WHERE id=${id} FOR UPDATE`;
      if(!await tx.projectDeletionJob.findFirst({where:owned}))throw conflict('Deletion lease changed');
      const a={tenantId:job.tenantId,userId:job.userId,sessionId:''};
      await assertNoForeignReferences(tx,a,job.projectId);
      for(const m of projectDeletionModels())await table(tx,m.name).deleteMany({where:scoped(a,job.projectId)});
      await tx.session.updateMany({where:{tenantId:job.tenantId,activeProjectId:job.projectId},data:{activeProjectId:null}});
      await tx.project.delete({where:{id:job.projectId}});
      await tx.internalAudit.create({data:{tenantId:job.tenantId,actor:job.userId,action:'project.deletion_completed',metadata:{job_id:id,project_id:job.projectId,project_type:project.projectType}}});
      await tx.projectDeletionJob.update({where:{id},data:{status:'completed',leaseUntil:null,completedAt:new Date(),manifest:[],reason:''}});
    },{timeout:60000});
  } catch(error) {
    console.error('[project deletion] cleanup failed',id,error);
    await prisma.projectDeletionJob.updateMany({where:owned,data:{status:'failed',leaseUntil:null,error:'Cleanup did not finish. The project stays locked; retry is safe.'}});
  }
}
let timer: ReturnType<typeof setTimeout>|undefined, stopped=true;
export function startProjectDeletionWorker() {
  if(!stopped)return;stopped=false;
  const tick=async()=>{try{const jobs=await prisma.projectDeletionJob.findMany({where:{status:{in:['pending','running']},OR:[{leaseUntil:null},{leaseUntil:{lt:new Date()}}],createdAt:{lt:new Date(Date.now()-60000)}},take:4,orderBy:{createdAt:'asc'}});for(const j of jobs)await runProjectDeletion(j.id);}catch(e){console.error('[project deletion] worker failed',e);}finally{if(!stopped){timer=setTimeout(tick,5000);timer.unref();}}};void tick();
}
export function stopProjectDeletionWorker(){stopped=true;if(timer)clearTimeout(timer);}
export async function retryProjectDeletion(a:Scope,id:string){
  await deletionJob(a,id);
  await prisma.projectDeletionJob.updateMany({where:{id,tenantId:a.tenantId,status:'failed',leaseUntil:null},data:{status:'pending',error:null}});
  return deletionJob(a,id);
}
