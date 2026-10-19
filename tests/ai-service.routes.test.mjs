import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { createCipheriv,createHash,randomBytes } from 'node:crypto';
import express from 'express';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'ai-service-isolated-session-secret',AI_SERVICE_SHARED_SECRET:'test-shared-secret-at-least-32-characters',WHATSAPP_CREDENTIALS_KEY:'test-whatsapp-key',AI_SERVICE_URL:'http://127.0.0.1:4010'});
const {prisma}=await import('../dist/core/prisma/client.js');
const {signAccessToken,hashToken}=await import('../dist/core/security/jwt.js');
const {aiServiceRouter}=await import('../dist/modules/ai-service/ai-service.routes.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
const {renewTenantSubscription,createThreeMonthTrial}=await import('../dist/core/subscription/subscription.service.js');
let server,base,roles,active,revoked,records,contact,connection,userMatches;
const token=signAccessToken({sessionId:'session',userId:'user',tenantId:'tenant'});
const activeContact=()=>renewTenantSubscription({subscription:createThreeMonthTrial()},new Date(),{package:'business',billing_cycle:'yearly'}).contact;
function encrypt(text){const iv=randomBytes(12),key=createHash('sha256').update(process.env.WHATSAPP_CREDENTIALS_KEY).digest(),cipher=createCipheriv('aes-256-gcm',key,iv);const b=Buffer.concat([cipher.update(text),cipher.final()]);return[iv,cipher.getAuthTag(),b].map(x=>x.toString('base64')).join('.');}
before(async()=>{
 prisma.session.findFirst=async({where})=>revoked||where.tokenHash!==hashToken(token)?null:{id:'session',userId:'user',tenantId:'tenant',activeProjectId:'project',user:{id:'user',isActive:active,lastActiveAt:new Date()}};
 prisma.projectMembership.findMany=async()=>active?roles.map(role=>({role,memberId:role==='member'?'member':null})):[];
 prisma.projectMembership.findFirst=async()=>roles.includes('accountant')?{role:'accountant'}:null;
 prisma.project.findFirst=async()=>({name:'Project',projectType:'fund_shares'});
 prisma.project.findFirstOrThrow=async()=>({portalSettings:{deposit_review:'automatic'}});
 prisma.user.findFirst=async()=>active?{id:'user',memberships:roles.map(role=>({role}))}:null;
 prisma.telegramConnection.findFirst=async()=>({tenantId:'tenant',projectId:'project',chatId:'-100'});
 prisma.telegramConnection.findUnique=async({where})=>where.chatId==='-100'?{tenantId:'tenant',projectId:'project',chatId:'-100'}:null;
 prisma.telegramBotIdentity.findUnique=async({where})=>where.projectId_userId||where.projectId_telegramUserId?.telegramUserId==='123'?{tenantId:'tenant',projectId:'project',userId:'user',telegramUserId:'123'}:null;
 prisma.user.findUniqueOrThrow=async()=>({id:'user',mobile:'+8801700000000'});
 prisma.user.findMany=async()=>userMatches;
 prisma.tenant.findUnique=async()=>({id:'tenant',name:'Test',currency:'BDT',contact,deletionStartedAt:null});
 prisma.tenant.findUniqueOrThrow=async()=>({id:'tenant',name:'Test',currency:'BDT',contact});
 prisma.onboardingProgress.findUnique=async()=>({incomeApprovalFlow:'accountant_only',expenseApprovalFlow:'accountant_and_approver'});
 prisma.whatsAppConnection.findFirst=async()=>connection;
 prisma.whatsAppConnection.findFirstOrThrow=async()=>connection;
 prisma.whatsAppConnection.findMany=async({where})=>connection&&where.groupId===connection.groupId?[connection]:[];
 prisma.member.findMany=async()=>[];
 prisma.due.aggregate=async()=>({_sum:{}});
 prisma.account.aggregate=async()=>({_sum:{balance:0}});
 prisma.member.count=async()=>0;
 prisma.expense.groupBy=async()=>[];
 prisma.$transaction=async fn=>fn(prisma);
 prisma.$queryRaw=async()=>[];
 prisma.assistantReply.findUnique=async({where})=>records.find(r=>r.requestKey===where.tenantId_channel_requestKey.requestKey)??null;
 prisma.assistantReply.count=async()=>records.length;
 prisma.assistantReply.create=async({data})=>{const r={id:'request-'+records.length,...data};records.push(r);return r;};
 const app=express();app.use(express.json());app.use('/v1/ai-service',aiServiceRouter);app.use(errorHandler);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(()=>{roles=['accountant'];active=true;revoked=false;records=[];contact=activeContact();connection={id:'connection',tenantId:'tenant',projectId:'project',wabaId:'waba',phoneNumberId:'phone',groupId:'group',graphApiVersion:'v23.0',encryptedAccessToken:encrypt('provider-secret')};userMatches=[{id:'user',memberships:[{role:'accountant'}]}];});
after(async()=>{await new Promise(r=>server.close(r));await prisma.$disconnect();});
const request=(path,body,headers={})=>fetch(base+'/v1/ai-service'+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'X-Project-Id':'project','Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
test('context uses a live scoped session, project roles and current approval rules',async()=>{const r=await request('/context');assert.equal(r.status,200);const c=(await r.json()).data;assert.equal(c.user_id,'user');assert.equal(c.project_id,'project');assert.deepEqual(c.roles,['accountant']);assert.equal(c.policy.income,'accountant_only');assert.equal(c.policy.admin_deposit_finalize,true);assert.equal(c.whatsapp.group_id,'group');assert.equal(c.whatsapp.access_token,undefined);});
test('all other roles, revoked sessions and inactive memberships are rejected',async()=>{for(const role of ['member','cashier','approver','auditor']){roles=[role];assert.equal((await request('/context')).status,403);}roles=['accountant'];revoked=true;assert.equal((await request('/context')).status,401);revoked=false;active=false;assert.equal((await request('/context')).status,401);});
test('shared-key WhatsApp resolver is exact-group scoped, never public, and returns no permission for ambiguous phone matches',async()=>{const b={waba_id:'waba',phone_number_id:'phone',group_id:'group',sender:'8801700000000'};assert.equal((await request('/whatsapp/resolve',b)).status,403);let r=await request('/whatsapp/resolve',b,{'X-AI-Service-Key':process.env.AI_SERVICE_SHARED_SECRET});let data=(await r.json()).data;assert.equal(data.permitted,true);assert.equal(data.connection.access_token,'provider-secret');r=await request('/whatsapp/resolve',{...b,group_id:'other'},{'X-AI-Service-Key':process.env.AI_SERVICE_SHARED_SECRET});assert.equal((await r.json()).data,null);userMatches=[{id:'one',memberships:[{role:'admin'}]},{id:'two',memberships:[{role:'admin'}]}];r=await request('/whatsapp/resolve',b,{'X-AI-Service-Key':process.env.AI_SERVICE_SHARED_SECRET});data=(await r.json()).data;assert.equal(data.permitted,false);assert.equal(data.user_id,null);});
test('Business entitlement is required by context and WhatsApp resolver',async()=>{contact={subscription:createThreeMonthTrial()};assert.equal((await request('/context')).status,403);const r=await request('/whatsapp/resolve',{waba_id:'waba',phone_number_id:'phone',group_id:'group',sender:'8801700000000'},{'X-AI-Service-Key':process.env.AI_SERVICE_SHARED_SECRET});assert.equal((await r.json()).data,null);});
test('quota reservations reuse request keys, reject changed input and are already completed so the legacy worker cannot execute them',async()=>{const b={request_key:'request-key',channel:'ai_chat',prompt_hash:'a'.repeat(64)};assert.equal((await request('/usage',b)).status,200);assert.equal((await request('/usage',b)).status,200);assert.equal(records.length,1);assert.equal(records[0].status,'completed');assert.equal((await request('/usage',{...b,prompt_hash:'b'.repeat(64)})).status,409);});

test('Telegram resolver requires the bridge key, exact project group and verified Telegram identity',async()=>{
 process.env.TELEGRAM_BOT_TOKEN='test-telegram-token';process.env.TELEGRAM_BOT_USERNAME='FundNestaBot';
 const b={chat_id:'-100',sender:'123'},headers={'X-AI-Service-Key':process.env.AI_SERVICE_SHARED_SECRET};
 assert.equal((await request('/telegram/resolve',b)).status,403);
 let r=await request('/telegram/resolve',b,headers),d=(await r.json()).data;assert.equal(d.permitted,true);assert.equal(d.project_id,'project');
 r=await request('/telegram/resolve',{...b,chat_id:'-200'},headers);assert.equal((await r.json()).data,null);
 r=await request('/telegram/resolve',{...b,sender:'999'},headers);d=(await r.json()).data;assert.equal(d.user_id,null);assert.equal(d.permitted,false);
 roles=['member'];r=await request('/telegram/resolve',b,headers);assert.equal((await r.json()).data.permitted,false);
});
test('Telegram usage shares AI Chat quota and keeps Telegram requests idempotent',async()=>{
 const b={request_key:'tg:123',channel:'telegram_bot:-100',prompt_hash:'a'.repeat(64)};
 assert.equal((await request('/usage',b)).status,200);assert.equal((await request('/usage',b)).status,200);assert.equal(records.length,1);assert.equal(records[0].channel,'ai_chat');
});


test('app chat forwards real service progress, saves the final result and propagates provider billing failures',async t=>{
 const {attachAssistantEvents}=await import('../dist/modules/ai-service/assistant-events.js');
 const {default:WebSocket}=await import('ws');const {once}=await import('node:events');
 const stop=attachAssistantEvents(server);t.after(stop);
 const requestKey='123e4567-e89b-42d3-a456-426614174000';
 const ticketResponse=await request('/events-ticket',{request_key:requestKey});assert.equal(ticketResponse.status,200);
 const {ticket}= (await ticketResponse.json()).data;
 const ws=new WebSocket(base.replace('http:','ws:')+'/v1/ai-service/events');await once(ws,'open');
 const ready=once(ws,'message');ws.send(JSON.stringify({ticket}));assert.equal(JSON.parse((await ready)[0]).type,'ready');
 const phases=[];ws.on('message',raw=>phases.push(JSON.parse(raw).phase));
 const originalFetch=global.fetch;let mode='success';
 prisma.assistantReply.findUniqueOrThrow=async()=>({id:'chat',prompt:'balances',createdAt:new Date()});
 prisma.assistantReply.update=async({data})=>({id:'chat',createdAt:new Date(),...data});
 global.fetch=async(input,options)=>{
   const url=new URL(input);
   if(url.origin!=='http://127.0.0.1:4010')return originalFetch(input,options);
   if(url.pathname==='/session')return Response.json(options?.method==='DELETE'?{}:{token:'test-service-session'});
   assert.equal(url.pathname,'/chat');assert.equal(url.searchParams.get('progress'),'1');
   if(mode==='legacy')return Response.json({status:'completed',reply:'Old service response'});
   const events=[{type:'progress',phase:'checking_access'},{type:'progress',phase:'reading_records'},mode==='success'?{type:'result',result:{status:'completed',reply:'Your balances'}}:{type:'error',error:{code:'AI_BILLING_REQUIRED',message:'AI provider has no remaining credit.'}}];
   return new Response(events.map(event=>JSON.stringify(event)).join('\n')+'\n',{headers:{'Content-Type':'application/x-ndjson'}});
 };
 try {
   const r=await request('/chat',{message:'balances',request_key:requestKey});assert.equal(r.status,200);assert.equal((await r.json()).data.action_result.reply,'Your balances');
   // WebSocket delivery can arrive just after the HTTP reply.
   if(!phases.includes('completed'))await once(ws,'message');
   assert.deepEqual(phases,['connecting','checking_access','reading_records','completed']);
   mode='billing';const failed=await request('/chat',{message:'balances',request_key:requestKey});assert.equal(failed.status,503);assert.equal((await failed.json()).error.code,'AI_BILLING_REQUIRED');
   if(!phases.includes('failed'))await once(ws,'message');assert.equal(phases.at(-1),'failed');
   mode='legacy';const legacy=await request('/chat',{message:'balances',request_key:requestKey});assert.equal((await legacy.json()).data.action_result.reply,'Old service response');
   roles=['member'];assert.equal((await request('/events-ticket',{request_key:requestKey})).status,403);
   roles=['accountant'];revoked=true;assert.equal((await request('/events-ticket',{request_key:requestKey})).status,401);
 }finally{global.fetch=originalFetch;ws.close();await once(ws,'close');}
});

test('Telegram resolver repairs a missed migration only from a Telegram-proven old group',async()=>{
 process.env.TELEGRAM_BOT_TOKEN='test-telegram-token';process.env.TELEGRAM_BOT_USERNAME='FundNestaBot';process.env.TELEGRAM_WEBHOOK_SECRET='test-secret';
 const from='-100',to='-1000000000100',c={id:'migration-connection',tenantId:'tenant',projectId:'project',chatId:from};
 const saved={findUnique:prisma.telegramConnection.findUnique,findMany:prisma.telegramConnection.findMany,updateMany:prisma.telegramConnection.updateMany,identities:prisma.telegramBotIdentity.findMany,links:prisma.telegramLink.updateMany,fetch:globalThis.fetch};
 prisma.telegramConnection.findUnique=async({where})=>where.chatId===c.chatId?c:null;
 prisma.telegramConnection.findMany=async()=>[c];prisma.telegramBotIdentity.findMany=async()=>[{tenantId:'tenant',projectId:'project'}];
 prisma.telegramConnection.updateMany=async({data})=>{Object.assign(c,data);return{count:1};};prisma.telegramLink.updateMany=async()=>({count:0});
 let destination='-1000000000999',probes=0;
 globalThis.fetch=async(input,options)=>{
  if(String(input).startsWith('https://api.telegram.org/')){probes++;assert.equal(JSON.parse(options.body).chat_id,from);return Response.json({ok:false,parameters:{migrate_to_chat_id:Number(destination)}},{status:400});}
  return saved.fetch(input,options);
 };
 try {
  const headers={'X-AI-Service-Key':process.env.AI_SERVICE_SHARED_SECRET};
  let response=await request('/telegram/resolve',{chat_id:to,sender:'123'},headers);assert.equal((await response.json()).data,null);assert.equal(c.chatId,from);
  destination=to;response=await request('/telegram/resolve',{chat_id:to,sender:'123'},headers);assert.equal(response.status,200);const data=(await response.json()).data;assert.equal(data.project_id,'project');assert.equal(data.permitted,true);assert.equal(c.chatId,to);assert.equal(probes,2);
 }finally{
  globalThis.fetch=saved.fetch;prisma.telegramConnection.findUnique=saved.findUnique;prisma.telegramConnection.findMany=saved.findMany;prisma.telegramConnection.updateMany=saved.updateMany;prisma.telegramBotIdentity.findMany=saved.identities;prisma.telegramLink.updateMany=saved.links;
 }
});
