import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { createHash } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { ApiError, forbidden, conflict } from '../../core/http/api-error.js';
import { mergePermissions } from '../../core/security/menu-access.js';
import { effectiveProjectRoles } from '../../core/security/project-access.js';
import { authorizedArticles, GUIDE_LIMIT, guideConfigured, questionHash, validatePlan, type GuideInput, type GuidePlan, type Language } from './app-guide.policy.js';
import { selectGuidePlan, type GuideUsage } from './app-guide.provider.js';
type Auth={tenantId:string;projectId:string;userId:string};
export async function guideScope(auth:Auth,language:Language) {
  const [user,project,memberships]=await Promise.all([
    tenantAccounts(prisma).findFirst({where:{id:auth.userId,tenantId:auth.tenantId,isActive:true},select:{id:true,userId:true}}),
    prisma.project.findFirst({where:{id:auth.projectId,tenantId:auth.tenantId,isActive:true},select:{projectType:true}}),
    prisma.projectMembership.findMany({where:{tenantId:auth.tenantId,projectId:auth.projectId,userId:auth.userId,isActive:true},include:{customRole:true}}),
  ]);
  if(!user||!project||!memberships.length||!user.isActive)throw forbidden('Your project access is no longer active.');
  const roles=effectiveProjectRoles(memberships.filter(m=>!m.customRoleId).map(m=>m.role));
  const custom=memberships.flatMap(m=>m.customRole?.tenantId===auth.tenantId&&m.customRole.projectId===auth.projectId?[m.customRole]:[]);
  const permissions=memberships.some(m=>m.customRoleId)?mergePermissions(custom):undefined;
  const grants=Object.entries(permissions??{}).sort(([a],[b])=>a.localeCompare(b));
  const authorization=createHash('sha256').update(JSON.stringify([auth.tenantId,auth.projectId,auth.userId,project.projectType,[...roles].sort(),grants])).digest('hex');
  const articles=authorizedArticles(project.projectType,roles,permissions,language);
  // The model always reads the compact English catalogue (same IDs); Bangla text costs several times more tokens.
  const catalog=()=>language==='en'?articles:authorizedArticles(project.projectType,roles,permissions,'en');
  return {...auth,identity:user.userId??user.id,authorization,articles,catalog};
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
export async function askAppGuide(auth:Auth,input:GuideInput) {
  if(!guideConfigured())throw new ApiError(503,'APP_GUIDE_UNAVAILABLE','AI guidance is unavailable. You can still search the app guide.');
  const channel=input.channel==='voice'?'voice':'text';
  const scope=await guideScope(auth,input.language),allowed=new Set(scope.articles.map(a=>a.id));
  // Permissions may change between voice turns; unknown or revoked previous topics are dropped, never sent.
  const followUps=channel==='voice'?[...new Set(input.follow_up_ids??[])].filter(id=>allowed.has(id)).slice(0,4):[];
  const hash=questionHash(input.question,input.language,followUps);
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
    await tx.$executeRaw`INSERT INTO app_guide_requests(identity_user_id,request_key,tenant_id,project_id,user_id,prompt_hash,authorization_hash,channel,speech_ms) VALUES (${scope.identity},${input.request_key}::uuid,${auth.tenantId},${auth.projectId},${auth.userId},${hash},${scope.authorization},${channel},${channel==='voice'?input.speech_ms??null:null})`;
    return null;
  });
  let plan:GuidePlan,usage:GuideUsage|null=null;
  if(previous)plan=previous;
  else try{
    ({plan,usage}=await selectGuidePlan(input.question,input.language,scope.articles,{catalog:scope.catalog(),previousTopics:followUps}));
    const fresh=await guideScope(auth,input.language);
    if(fresh.authorization!==scope.authorization)throw forbidden('Your project access changed. Start a new question.');
    const saved=await prisma.$executeRaw`UPDATE app_guide_requests SET plan=${JSON.stringify(plan)}::jsonb WHERE identity_user_id=${scope.identity} AND request_key=${input.request_key}::uuid AND plan IS NULL`;
    if(!saved)throw new ApiError(503,'APP_GUIDE_UNAVAILABLE','Please try your question again.');
    if(usage)await recordGuideUsage(scope.identity,input.request_key,usage);
  }catch(error){
    await prisma.$executeRaw`DELETE FROM app_guide_requests WHERE identity_user_id=${scope.identity} AND request_key=${input.request_key}::uuid AND plan IS NULL`;
    throw error;
  }
  return {kind:plan.kind,articles:plan.topic_ids.map(id=>scope.articles.find(a=>a.id===id)!),...await guideUsage(scope.identity)};
}

/** Best effort: usage logging must never fail or re-charge an answered question. */
async function recordGuideUsage(identity:string,requestKey:string,usage:GuideUsage) {
  try{await prisma.$executeRaw`UPDATE app_guide_requests SET usage_model=${usage.model},input_tokens=${usage.input_tokens},cached_tokens=${usage.cached_tokens},output_tokens=${usage.output_tokens},reasoning_tokens=${usage.reasoning_tokens} WHERE identity_user_id=${identity} AND request_key=${requestKey}::uuid`;}
  catch(error){console.warn('[app-guide] usage not recorded',(error as {code?:string})?.code??'unknown');}
}
/** Internal cost report: credits are per question, tokens are tracked to size package allowances. */
export async function appGuideTokenUsage(days=30) {
  const since=new Date(Date.now()-Math.min(366,Math.max(1,days))*86400000);
  const rows=await prisma.$queryRaw<{channel:string;model:string|null;questions:bigint;input_tokens:bigint|null;cached_tokens:bigint|null;output_tokens:bigint|null;reasoning_tokens:bigint|null;speech_ms:bigint|null;max_input:number|null;max_output:number|null}[]>`
    SELECT channel, usage_model AS model, COUNT(*) AS questions, SUM(input_tokens) AS input_tokens, SUM(cached_tokens) AS cached_tokens, SUM(output_tokens) AS output_tokens, SUM(reasoning_tokens) AS reasoning_tokens, SUM(speech_ms) AS speech_ms, MAX(input_tokens) AS max_input, MAX(output_tokens) AS max_output
    FROM app_guide_requests WHERE plan IS NOT NULL AND created_at >= ${since} GROUP BY channel, usage_model ORDER BY channel, usage_model`;
  const n=(v:bigint|number|null)=>Number(v??0);
  return {since:since.toISOString(),rows:rows.map(r=>({channel:r.channel,model:r.model,questions:n(r.questions),input_tokens:n(r.input_tokens),cached_tokens:n(r.cached_tokens),output_tokens:n(r.output_tokens),reasoning_tokens:n(r.reasoning_tokens),speech_seconds:Math.round(n(r.speech_ms)/1000),avg_input_tokens:n(r.questions)?Math.round(n(r.input_tokens)/n(r.questions)):0,avg_output_tokens:n(r.questions)?Math.round(n(r.output_tokens)/n(r.questions)):0,max_input_tokens:n(r.max_input),max_output_tokens:n(r.max_output)}))};
}
