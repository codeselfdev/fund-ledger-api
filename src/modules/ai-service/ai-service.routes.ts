import { assistantHistoryQuery, assistantHistoryWindow } from '../assistant/assistant-history.js';
import { retainChatAttachments, chatAttachmentSelection } from './chat-attachments.js';
import { bulkAssistantRouter } from './bulk.routes.js';
import { businessAssistantRouter } from './business.routes.js';
import { assistantEventScope, assistantEventTicket, publishAssistantPhase } from './assistant-events.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { validateAssistantImage, assistantUpload, assistantUploadError } from '../assistant/assistant-upload.js';
import { prisma } from '../../core/prisma/client.js';
import { authenticate, requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireActiveSubscription } from '../../core/security/subscription.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { ApiError, forbidden, conflict } from '../../core/http/api-error.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { projectDepositRoute } from '../../core/projects/project-settings.js';
import { hasBusinessAssistant, hasAssistant, assistantQuotaMessage, allowancePeriod, featureLimit } from '../assistant/assistant.policy.js';
import { assistantContext } from '../assistant/assistant.context.js';
import { aiServiceWhatsAppCredential } from '../../core/whatsapp/whatsapp.service.js';
import { startTelegramIdentityLink, confirmTelegramIdentityLink } from '../integrations/telegram-assistant.service.js';
import { telegramLinkStatus, telegramApi, TelegramGroupMigratedError } from '../integrations/telegram.service.js';
import { resolveTelegramConnection } from '../integrations/telegram-migration.service.js';
const router=Router();
const permitted=(roles:string[])=>roles.some(r=>['owner','admin','accountant'].includes(r));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const resolveSchema=z.object({waba_id:z.string().min(1).max(100),phone_number_id:z.string().min(1).max(100),group_id:z.string().min(1).max(300),sender:z.string().regex(/^\d{7,15}$/)}).strict();
router.post('/whatsapp/resolve',asyncHandler(async(req,res)=>{
  const expected=process.env.AI_SERVICE_SHARED_SECRET,actual=req.header('X-AI-Service-Key');
  if(!expected||expected.length<32||!actual||!timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(actual))))throw forbidden();
  const b=resolveSchema.parse(req.body);
  const connections=await prisma.whatsAppConnection.findMany({where:{wabaId:b.waba_id,phoneNumberId:b.phone_number_id,groupId:b.group_id,isActive:true},take:2});
  if(connections.length!==1)return ok(res,null);
  const c=connections[0]!;
  const tenant=await prisma.tenant.findUnique({where:{id:c.tenantId}});
  if(!tenant||tenant.deletionStartedAt||!hasBusinessAssistant(tenant.contact))return ok(res,null);
  const project=await prisma.project.findFirst({where:{id:c.projectId,tenantId:c.tenantId,isActive:true}});
  if(!project)return ok(res,null);
  const users=await prisma.user.findMany({where:{tenantId:c.tenantId,isActive:true,mobile:{in:[b.sender,`+${b.sender}`]},memberships:{some:{projectId:c.projectId,tenantId:c.tenantId,isActive:true}}},include:{memberships:{where:{projectId:c.projectId,tenantId:c.tenantId,isActive:true}}},take:2});
  const user=users.length===1?users[0]:null;
  return ok(res,{tenant_id:c.tenantId,project_id:c.projectId,user_id:user?.id??null,permitted:!!user&&permitted(user.memberships.map(m=>m.role)),connection:{graph_api_version:c.graphApiVersion,access_token:await aiServiceWhatsAppCredential(c.id)}});
}));
const telegramResolveSchema=z.object({chat_id:z.string().regex(/^-\d+$/).max(30),sender:z.string().regex(/^\d+$/).max(30)}).strict();
router.post('/telegram/resolve',asyncHandler(async(req,res)=>{
  const expected=process.env.AI_SERVICE_SHARED_SECRET,actual=req.header('X-AI-Service-Key');
  if(!expected||expected.length<32||!actual||!timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(actual))))throw forbidden();
  const b=telegramResolveSchema.parse(req.body);
  const connection=await resolveTelegramConnection(b.chat_id,b.sender,async old=>{
    try { const chat=await telegramApi<{id:number}>('getChat',{chat_id:old});return Number.isSafeInteger(chat.id)?String(chat.id):null; }
    catch(error) { if(error instanceof TelegramGroupMigratedError)return error.chatId;throw error; }
  });
  if(!connection||!process.env.TELEGRAM_BOT_TOKEN||!process.env.TELEGRAM_BOT_USERNAME)return ok(res,null);
  const tenant=await prisma.tenant.findUnique({where:{id:connection.tenantId}});
  const project=await prisma.project.findFirst({where:{id:connection.projectId,tenantId:connection.tenantId,isActive:true}});
  if(!tenant||tenant.deletionStartedAt||!hasAssistant(tenant.contact)||!project)return ok(res,null);
  const identity=await prisma.telegramBotIdentity.findUnique({where:{projectId_telegramUserId:{projectId:connection.projectId,telegramUserId:b.sender}}});
  const user=identity?.tenantId===connection.tenantId?await prisma.user.findFirst({where:{id:identity.userId,tenantId:connection.tenantId,isActive:true},include:{memberships:{where:{tenantId:connection.tenantId,projectId:connection.projectId,isActive:true}}}}):null;
  return ok(res,{tenant_id:connection.tenantId,project_id:connection.projectId,user_id:user?.id??null,permitted:!!user&&permitted(user.memberships.map(m=>m.role)),connection:{bot_token:process.env.TELEGRAM_BOT_TOKEN,bot_username:process.env.TELEGRAM_BOT_USERNAME.replace(/^@/,'')}});
}));
router.use(authenticate,requireProject,requireRoles('owner','admin','accountant'),requireActiveSubscription);
router.use(asyncHandler(async(req,_res,next)=>{const a=requireProjectContext(req);const t=await prisma.tenant.findUniqueOrThrow({where:{id:a.tenantId}});if(!hasAssistant(t.contact))throw new ApiError(403,'ASSISTANT_PLAN_REQUIRED','An active eligible plan is required for AI Chat.');next();}));

router.use('/bulk',bulkAssistantRouter);
router.use('/business',businessAssistantRouter);
router.get('/context',asyncHandler(async(req,res)=>{
  const a=requireProjectContext(req);
  const [user,progress,wa,deposit,tg,identity,project]=await Promise.all([
    prisma.user.findUniqueOrThrow({where:{id:a.userId},select:{mobile:true}}),
    prisma.onboardingProgress.findUnique({where:{tenantId:a.tenantId},select:{incomeApprovalFlow:true,expenseApprovalFlow:true}}),
    prisma.whatsAppConnection.findFirst({where:{tenantId:a.tenantId,projectId:a.projectId,isActive:true},select:{wabaId:true,phoneNumberId:true,groupId:true}}),
    projectDepositRoute(a.tenantId,a.projectId),
    prisma.telegramConnection.findFirst({where:{tenantId:a.tenantId,projectId:a.projectId}}),
    prisma.telegramBotIdentity.findUnique({where:{projectId_userId:{projectId:a.projectId,userId:a.userId}}}),
    prisma.project.findFirst({where:{id:a.projectId,tenantId:a.tenantId,isActive:true},select:{projectType:true}})
  ]);
  if(!project)throw forbidden('Your project access is no longer active.');
  return ok(res,{tenant_id:a.tenantId,project_id:a.projectId,project_type:project.projectType,user_id:a.userId,mobile:user.mobile,roles:a.roles,member_id:a.memberId,member_ids:a.memberIds,policy:{income:progress?.incomeApprovalFlow??'accountant_only',expense:progress?.expenseApprovalFlow??'accountant_and_approver',deposit,admin_deposit_finalize:true},whatsapp:wa?{waba_id:wa.wabaId,phone_number_id:wa.phoneNumberId,group_id:wa.groupId}:null,telegram:tg&&identity&&identity.tenantId===a.tenantId?{chat_id:tg.chatId,sender_id:identity.telegramUserId,bot_username:process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/,'')??null}:null});
}));
const usageSchema=z.object({request_key:z.string().min(1).max(200),channel:z.string().regex(/^(ai_chat|(?:whatsapp_bot|telegram_bot)(?::[^\s]{1,300})?)$/),prompt_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
router.post('/usage',rateLimit({windowMs:60000,limit:12,keyGenerator:req=>requireProjectContext(req).tenantId,standardHeaders:true,legacyHeaders:false}),asyncHandler(async(req,res)=>{
  const a=requireProjectContext(req),b=usageSchema.parse(req.body),channel=b.channel.startsWith('whatsapp_bot')?'whatsapp_bot':'ai_chat';
  const context=await assistantContext(a.tenantId,a.projectId,a.userId);
  const row=await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM tenants WHERE id=${a.tenantId} FOR NO KEY UPDATE`;
    const tenant=await tx.tenant.findUniqueOrThrow({where:{id:a.tenantId}});
    if(!hasAssistant(tenant.contact,channel))throw forbidden('An active eligible plan is required for this assistant channel.');
    const requestKey=`action:${b.request_key}`,period=allowancePeriod(tenant.contact);
    const old=await tx.assistantReply.findUnique({where:{tenantId_channel_requestKey:{tenantId:a.tenantId,channel,requestKey}}});
    if(old){if(old.userId!==a.userId||old.projectId!==a.projectId||old.promptHash!==b.prompt_hash||old.authorizationHash!==context.authorization_hash)throw conflict('This request key has already been used or your access changed.');return old;}
    const used=await tx.assistantReply.count({where:{tenantId:a.tenantId,channel,periodStart:period.start,status:{not:'cancelled'}}});
    if(used>=featureLimit(channel,tenant.contact))throw new ApiError(429,'ASSISTANT_QUOTA_EXCEEDED',assistantQuotaMessage(tenant.contact));
    return tx.assistantReply.create({data:{tenantId:a.tenantId,projectId:a.projectId,userId:a.userId,channel,requestKey,promptHash:b.prompt_hash,prompt:'Attachment/action request',reply:'Request processed by Fund Nesta AI service.',authorizationHash:context.authorization_hash,periodStart:period.start,status:'completed'}});
  });
  return ok(res,{request_id:row.id});
}));
async function serviceRequest(req:import('express').Request,path:string,body?:unknown,method=body===undefined?'GET':'POST',progress?:(phase:string)=>void) {
  const base=process.env.AI_SERVICE_URL;
  if(!base)throw new ApiError(503,'AI_SERVICE_NOT_CONFIGURED','Configure the separate Fund Nesta AI service.');
  const url=new URL(base);
  if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw new ApiError(503,'AI_SERVICE_NOT_CONFIGURED','The AI service requires HTTPS.');
  const a=requireProjectContext(req);
  const exchange=await fetch(new URL('/session',url),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:req.header('Authorization')!,'X-Project-Id':a.projectId}});
  const session=await exchange.json() as {token?:string;error?:{code?:string;message?:string}};
  if(!exchange.ok||!session.token)throw new ApiError(exchange.status,session.error?.code??'AI_SESSION_FAILED',session.error?.message??'Could not connect your AI session.');
  let retainSession=false;
  try {
    const response=await fetch(new URL(progress?`${path}?progress=1`:path,url),{method,redirect:'error',signal:AbortSignal.timeout(90000),headers:{Authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(progress&&response.ok&&response.headers.get('content-type')?.includes('application/x-ndjson')) {
      if(!response.body)throw new ApiError(503,'AI_SERVICE_FAILED','AI progress connection ended. Retry your question.');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',result:unknown,received=false;
      const consume=(line:string)=>{
        if(!line.trim())return;
        const event=JSON.parse(line);
        if(event.type==='progress'&&typeof event.phase==='string')progress(event.phase);
        if(event.type==='error')throw new ApiError(Number.isInteger(event.error?.status)&&event.error.status>=400&&event.error.status<=599?event.error.status:503,event.error?.code??'AI_SERVICE_FAILED',event.error?.message??'AI request failed.');
        if(event.type==='result'){result=event.result;received=true;}
      };
      try {
        while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>1000000)throw new ApiError(503,'AI_SERVICE_FAILED','AI response was too large.');let end;while((end=buffer.indexOf('\n'))>=0){consume(buffer.slice(0,end));buffer=buffer.slice(end+1);}}
        buffer+=decoder.decode();consume(buffer);
        if(!received)throw new ApiError(503,'AI_SERVICE_FAILED','AI connection ended before the reply arrived. Retry your question.');
        return result;
      }finally{await reader.cancel().catch(()=>{});}
    }
    const data=await response.json() as {error?:{code?:string;message?:string}};
    if(!response.ok)throw new ApiError(response.status,data.error?.code??'AI_SERVICE_FAILED',data.error?.message??'AI service request failed.');
    retainSession=['/whatsapp/link','/telegram/link'].includes(path);
    return data;
  }finally{
    // Only successful bot pairing retains the encrypted service session until expiry.
    if(!retainSession) await fetch(new URL('/session',url),{method:'DELETE',redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${session.token}`}}).catch(()=>{});
  }
}
const upload=assistantUpload;
const chatSchema=z.object({message:z.string().trim().min(1).max(2000),request_key:z.string().uuid(),reply_to_request_key:z.string().uuid().optional()}).strict();
router.post('/events-ticket',asyncHandler(async(req,res)=>{
  const b=z.object({request_key:z.string().uuid()}).strict().parse(req.body);
  return ok(res,assistantEventTicket(requireProjectContext(req),b.request_key));
}));
router.post('/chat',rateLimit({windowMs:60000,limit:12,keyGenerator:req=>requireProjectContext(req).tenantId,standardHeaders:true,legacyHeaders:false}),upload,asyncHandler(async(req,res)=>{
  const b=chatSchema.parse(req.body),a=requireProjectContext(req),files=(req.files??[]) as Express.Multer.File[];
  const images=files.map(f=>({name:f.originalname.slice(0,120),mime_type:validateAssistantImage(f.buffer),base64:f.buffer.toString('base64')}));
  const scope=assistantEventScope(a,b.request_key);publishAssistantPhase(scope,'connecting');
  try {
  const result=await serviceRequest(req,'/chat',{...b,images},'POST',phase=>publishAssistantPhase(scope,phase));
  const row=await prisma.assistantReply.findUniqueOrThrow({where:{tenantId_channel_requestKey:{tenantId:a.tenantId,channel:'ai_chat',requestKey:`action:${b.request_key}`}}});
  let attachments=await retainChatAttachments(a.tenantId,row.id,files);
  if(!attachments.length&&result&&typeof result==='object'&&'source_request_key' in result&&typeof result.source_request_key==='string'){
    const context=await assistantContext(a.tenantId,a.projectId,a.userId);
    const source=await prisma.assistantReply.findFirst({where:{tenantId:a.tenantId,projectId:a.projectId,userId:a.userId,channel:'ai_chat',requestKey:`action:${result.source_request_key}`,authorizationHash:context.authorization_hash},include:{attachments:{select:chatAttachmentSelection}}});
    attachments=source?.attachments.length?source.attachments:source?.reply?JSON.parse(source.reply)?.source_attachments??[]:[];
    (result as Record<string,unknown>).source_attachments=attachments;
  }
  const saved=await prisma.assistantReply.update({where:{id:row.id},data:{prompt:b.message,reply:JSON.stringify(result)}});
  publishAssistantPhase(scope,'completed');
  return ok(res,{id:saved.id,message:saved.prompt,reply:null,status:'completed',request_key:b.request_key,created_at:saved.createdAt,attachments,action_result:result});
  }catch(error){publishAssistantPhase(scope,'failed');throw error;}
}));
router.get('/messages',asyncHandler(async(req,res)=>{
  const a=requireProjectContext(req),context=await assistantContext(a.tenantId,a.projectId,a.userId);
  const {paged,...query}=await assistantHistoryQuery(prisma,{tenantId:a.tenantId,projectId:a.projectId,userId:a.userId,channel:'ai_chat',requestKey:{startsWith:'action:'},authorizationHash:context.authorization_hash,createdAt:{gt:new Date(Date.now()-90*86400000)}},req.query);
  const page=assistantHistoryWindow(await prisma.assistantReply.findMany({...query,include:{attachments:{select:chatAttachmentSelection}}}),paged);
  const entries=page.rows.map(row=>{let result:unknown=null;try{result=JSON.parse(row.reply??'null');}catch{}return{id:row.id,message:row.prompt,reply:result?null:row.reply,status:row.status,request_key:row.requestKey.slice(7),created_at:row.createdAt,attachments:row.attachments.length?row.attachments:(result as {source_attachments?:unknown[]}|null)?.source_attachments??[],action_result:result};});
  return ok(res,paged?{entries,next_cursor:page.next_cursor}:entries);
}));
router.post('/telegram/links',asyncHandler(async(req,res)=>ok(res,await startTelegramIdentityLink(requireProjectContext(req)))));
router.get('/telegram/links/:id',asyncHandler(async(req,res)=>ok(res,await telegramLinkStatus(requireProjectContext(req),String(req.params.id)))));
router.post('/telegram/links/:id/confirm',asyncHandler(async(req,res)=>{
  await confirmTelegramIdentityLink(requireProjectContext(req),String(req.params.id));
  return ok(res,await serviceRequest(req,'/telegram/link',{}));
}));
router.post('/telegram/link',asyncHandler(async(req,res)=>ok(res,await serviceRequest(req,'/telegram/link',{}))));
router.post('/whatsapp/link',asyncHandler(async(req,res)=>{const t=await prisma.tenant.findUniqueOrThrow({where:{id:requireProjectContext(req).tenantId}});if(!hasBusinessAssistant(t.contact))throw new ApiError(403,'BUSINESS_REQUIRED','WhatsApp Bot requires an active Business plan.');return ok(res,await serviceRequest(req,'/whatsapp/link',{}));}));
router.get('/drafts/:id',asyncHandler(async(req,res)=>ok(res,await serviceRequest(req,`/drafts/${encodeURIComponent(req.params.id!)}`))));
router.post('/drafts/:id/revise',asyncHandler(async(req,res)=>{
 const b=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),fields:z.record(z.unknown()).refine(fields=>!Object.hasOwn(fields,'rows')||z.object({rows:z.array(z.record(z.unknown())).min(1).max(50)}).strict().safeParse(fields).success,'Provide 1 to 50 valid rows.'),request_key:z.string().uuid()}).strict().parse(req.body);
 const draft=await serviceRequest(req,`/drafts/${encodeURIComponent(String(req.params.id))}/revise`,b) as {status:string;validation_message?:string};
 const a=requireProjectContext(req),result=draft.status==='editing'?{status:'needs_information',reply:draft.validation_message,editable_draft:draft}:{status:'confirmation_required',proposal:draft};
 await prisma.assistantReply.updateMany({where:{tenantId:a.tenantId,projectId:a.projectId,userId:a.userId,channel:'ai_chat',requestKey:{startsWith:'action:'},reply:{contains:String(req.params.id)}},data:{reply:JSON.stringify(result)}});
 return ok(res,draft);
}));
router.post('/drafts/:id/confirm',asyncHandler(async(req,res)=>{
  const b=z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),verified_source_records:z.literal(true)}).strict().parse(req.body);
  const result=await serviceRequest(req,`/drafts/${encodeURIComponent(req.params.id!)}/confirm`,b);
  const a=requireProjectContext(req);
  await prisma.assistantReply.updateMany({where:{tenantId:a.tenantId,projectId:a.projectId,userId:a.userId,channel:'ai_chat',requestKey:{startsWith:'action:'},reply:{contains:req.params.id!}},data:{reply:JSON.stringify({status:'completed',proposal:result})}});
  return ok(res,result);
}));
router.post('/drafts/:id/cancel',asyncHandler(async(req,res)=>{
  const result=await serviceRequest(req,`/drafts/${encodeURIComponent(req.params.id!)}/cancel`,{}),a=requireProjectContext(req);
  await prisma.assistantReply.updateMany({where:{tenantId:a.tenantId,projectId:a.projectId,userId:a.userId,channel:'ai_chat',requestKey:{startsWith:'action:'},reply:{contains:req.params.id!}},data:{reply:JSON.stringify({status:'cancelled',proposal:result})}});
  return ok(res,result);
}));
router.use(assistantUploadError);
export {router as aiServiceRouter};
