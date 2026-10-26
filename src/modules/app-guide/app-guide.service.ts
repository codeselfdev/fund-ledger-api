import { createHash } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { ApiError, forbidden, conflict } from '../../core/http/api-error.js';
import { mergePermissions } from '../../core/security/menu-access.js';
import { effectiveProjectRoles } from '../../core/security/project-access.js';
import { authorizedArticles, GUIDE_LIMIT, guideConfigured, questionHash, validatePlan, type GuidePlan, type Language } from './app-guide.policy.js';
import { selectGuidePlan } from './app-guide.provider.js';
type Auth={tenantId:string;projectId:string;userId:string};
export async function guideScope(auth:Auth,language:Language) {
  const [user,project,memberships]=await Promise.all([
    prisma.user.findFirst({where:{id:auth.userId,tenantId:auth.tenantId,isActive:true},select:{id:true,identityRootId:true,identityRoot:{select:{isActive:true}}}}),
    prisma.project.findFirst({where:{id:auth.projectId,tenantId:auth.tenantId,isActive:true},select:{projectType:true}}),
    prisma.projectMembership.findMany({where:{tenantId:auth.tenantId,projectId:auth.projectId,userId:auth.userId,isActive:true},include:{customRole:true}}),
  ]);
  if(!user||!project||!memberships.length||user.identityRootId&&!user.identityRoot?.isActive)throw forbidden('Your project access is no longer active.');
  const roles=effectiveProjectRoles(memberships.filter(m=>!m.customRoleId).map(m=>m.role));
  const custom=memberships.flatMap(m=>m.customRole?.tenantId===auth.tenantId&&m.customRole.projectId===auth.projectId?[m.customRole]:[]);
  const permissions=memberships.some(m=>m.customRoleId)?mergePermissions(custom):undefined;
  const grants=Object.entries(permissions??{}).sort(([a],[b])=>a.localeCompare(b));
  const authorization=createHash('sha256').update(JSON.stringify([auth.tenantId,auth.projectId,auth.userId,project.projectType,[...roles].sort(),grants])).digest('hex');
  return {...auth,identity:user.identityRootId??user.id,authorization,articles:authorizedArticles(project.projectType,roles,permissions,language)};
}
export async function guideUsage(identity:string) {
  // Only abandoned reservations expire. Completed credits do not reset with projects, months or devices.
  await prisma.$executeRaw`DELETE FROM app_guide_requests WHERE identity_user_id=${identity} AND plan IS NULL AND created_at < NOW() - INTERVAL '2 minutes'`;
  const rows=await prisma.$queryRaw<{used:bigint}[]>`SELECT COUNT(*) AS used FROM app_guide_requests WHERE identity_user_id=${identity}`;
  const used=Number(rows[0]?.used??0);return {used,limit:GUIDE_LIMIT,remaining:Math.max(0,GUIDE_LIMIT-used)};
}
export async function appGuideStatus(auth:Auth,language:Language) {
  const scope=await guideScope(auth,language);
  return {configured:guideConfigured(),...await guideUsage(scope.identity),articles:scope.articles};
}
export async function askAppGuide(auth:Auth,input:{question:string;language:Language;request_key:string}) {
  if(!guideConfigured())throw new ApiError(503,'APP_GUIDE_UNAVAILABLE','AI guidance is unavailable. You can still search the app guide.');
  const scope=await guideScope(auth,input.language),hash=questionHash(input.question,input.language);
  const previous=await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM users WHERE id=${scope.identity} FOR UPDATE`;
    await tx.$executeRaw`DELETE FROM app_guide_requests WHERE identity_user_id=${scope.identity} AND plan IS NULL AND created_at < NOW() - INTERVAL '2 minutes'`;
    const saved=await tx.$queryRaw<{tenant_id:string;project_id:string;user_id:string;prompt_hash:string;authorization_hash:string;plan:unknown}[]>`SELECT tenant_id,project_id,user_id,prompt_hash,authorization_hash,plan FROM app_guide_requests WHERE identity_user_id=${scope.identity} AND request_key=${input.request_key}::uuid`;
    const row=saved[0];
    if(row){
      if(row.tenant_id!==auth.tenantId||row.project_id!==auth.projectId||row.user_id!==auth.userId||row.authorization_hash!==scope.authorization)throw forbidden('Your guide access changed. Start a new question.');
      if(row.prompt_hash!==hash)throw conflict('Start a new request for a different question.');
      if(!row.plan)throw new ApiError(409,'APP_GUIDE_BUSY','Your question is still being checked.');
      return validatePlan(row.plan,scope.articles);
    }
    const count=await tx.$queryRaw<{used:bigint}[]>`SELECT COUNT(*) AS used FROM app_guide_requests WHERE identity_user_id=${scope.identity}`;
    if(Number(count[0]?.used??0)>=GUIDE_LIMIT)throw new ApiError(429,'APP_GUIDE_QUOTA_EXCEEDED','You have used your 20 free App Guide AI credits. Contact support for more details.');
    await tx.$executeRaw`INSERT INTO app_guide_requests(identity_user_id,request_key,tenant_id,project_id,user_id,prompt_hash,authorization_hash) VALUES (${scope.identity},${input.request_key}::uuid,${auth.tenantId},${auth.projectId},${auth.userId},${hash},${scope.authorization})`;
    return null;
  });
  let plan:GuidePlan;
  if(previous)plan=previous;
  else try{
    plan=await selectGuidePlan(input.question,input.language,scope.articles);
    const fresh=await guideScope(auth,input.language);
    if(fresh.authorization!==scope.authorization)throw forbidden('Your project access changed. Start a new question.');
    const saved=await prisma.$executeRaw`UPDATE app_guide_requests SET plan=${JSON.stringify(plan)}::jsonb WHERE identity_user_id=${scope.identity} AND request_key=${input.request_key}::uuid AND plan IS NULL`;
    if(!saved)throw new ApiError(503,'APP_GUIDE_UNAVAILABLE','Please try your question again.');
  }catch(error){
    await prisma.$executeRaw`DELETE FROM app_guide_requests WHERE identity_user_id=${scope.identity} AND request_key=${input.request_key}::uuid AND plan IS NULL`;
    throw error;
  }
  return {kind:plan.kind,articles:plan.topic_ids.map(id=>scope.articles.find(a=>a.id===id)!),...await guideUsage(scope.identity)};
}
