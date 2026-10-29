import { installSubscriptionReadFixtures } from './helpers/normalized-fixtures.mjs';
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import { Prisma } from '@prisma/client';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET='managed-whatsapp-test-secret';
process.env.WHATSAPP_ENABLED='true';
process.env.WHATSAPP_GROUPS_ENABLED='true';
process.env.WHATSAPP_WABA_ID='platform-waba';
process.env.WHATSAPP_PHONE_NUMBER_ID='platform-phone';
process.env.WHATSAPP_ACCESS_TOKEN='platform-secret-token-for-tests';
process.env.WHATSAPP_CREDENTIALS_KEY='platform-encryption-test-key';
process.env.WHATSAPP_APP_SECRET='meta-test-secret';
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN='verify-test';
process.env.AI_SERVICE_URL='http://127.0.0.1:4010';
process.env.AI_SERVICE_SHARED_SECRET='shared-test-secret-more-than-thirty-two';
const {prisma}=await import('../dist/core/prisma/client.js');
const {managedWhatsAppSetup,createManagedWhatsAppGroup,receiveManagedGroupLifecycle,safeInviteLink}=await import('../dist/core/whatsapp/managed-whatsapp.service.js');
const {whatsappRouter}=await import('../dist/modules/integrations/whatsapp.routes.js');
const {whatsappBotWebhookRouter}=await import('../dist/modules/assistant/whatsapp-bot.routes.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
const {renewTenantSubscription}=await import('../dist/core/subscription/subscription.service.js');
const scope={tenantId:'tenant',projectId:'project',userId:'admin'},rows=new Map(),inbox=new Map();
const originalFetch=globalThis.fetch;
let paid=true,calls=[],responseStatus=200,early=false,interrupt=false,providerError=null;
const event=(request='request-1',changes={})=>({object:'whatsapp_business_account',entry:[{id:'platform-waba',changes:[{field:'group_lifecycle_update',value:{metadata:{phone_number_id:'platform-phone'},groups:[{type:'group_create',request_id:request,group_id:'group-1',invite_link:'https://chat.whatsapp.com/Invite123',...changes}]}}]}]});
function matches(row,where){return Object.entries(where).every(([key,value])=>value&&typeof value==='object'&&'in'in value?value.in.includes(row[key]):value instanceof Date?row[key]?.getTime()===value.getTime():row[key]===value);}
beforeEach(()=>{
 rows.clear();inbox.clear();paid=true;calls=[];responseStatus=200;early=false;interrupt=false;providerError=null;
 process.env.WHATSAPP_GROUPS_ENABLED='true';
 prisma.tenant.findUnique=async()=>({id:'tenant',contact:paid?renewTenantSubscription({},new Date(),{package:'business',billing_cycle:'yearly'}).contact:{}});
 prisma.project.findFirst=async({where})=>({id:where.id,name:'Project',tenantId:where.tenantId});
 prisma.whatsAppConnection.findFirst=async({where})=>[...rows.values()].find(row=>matches(row,where))??null;
 prisma.whatsAppConnection.create=async({data})=>{
  if(rows.has(data.projectId))throw new Prisma.PrismaClientKnownRequestError('unique',{code:'P2002',clientVersion:'test'});
  const row={id:`connection-${rows.size}`,...data,updatedAt:new Date()};rows.set(data.projectId,row);return{...row};
 };
 prisma.whatsAppConnection.update=async({where,data})=>{const row=[...rows.values()].find(r=>r.id===where.id);Object.assign(row,data,{updatedAt:new Date()});return{...row};};
 prisma.whatsAppConnection.updateMany=async({where,data})=>{let count=0;for(const row of rows.values())if(matches(row,where)){Object.assign(row,data,{updatedAt:new Date()});count++;}return{count};};
 prisma.whatsAppGroupCreationEvent.upsert=async({create})=>{const key=JSON.stringify([create.wabaId,create.phoneNumberId,create.requestId]);if(!inbox.has(key))inbox.set(key,{id:`event-${inbox.size}`,...create});return inbox.get(key);};
 prisma.whatsAppGroupCreationEvent.findUnique=async({where})=>{const w=where.wabaId_phoneNumberId_requestId;return inbox.get(JSON.stringify([w.wabaId,w.phoneNumberId,w.requestId]))??null;};
 prisma.whatsAppGroupCreationEvent.update=async({where,data})=>{const e=[...inbox.values()].find(e=>e.id===where.id);Object.assign(e,data);return e;};
 prisma.activity.create=async({data})=>data;
 globalThis.fetch=async(url,options)=>{
  if(!String(url).startsWith('https://graph.facebook.com/'))return originalFetch(url,options);
  if(options.method!=='POST')return Response.json({invite_link:'https://chat.whatsapp.com/FromLookup'});
  calls.push({url:String(url),body:JSON.parse(options.body),headers:options.headers});
  if(interrupt)throw Error('interrupted');
  if(early)await receiveManagedGroupLifecycle(event());
  return Response.json(providerError ?? {request_id:`request-${calls.length}`},{status:responseStatus});
 };
installSubscriptionReadFixtures(prisma);
});
after(async()=>{globalThis.fetch=originalFetch;await prisma.$disconnect();});
test('shared account creates once for concurrent taps and waits for signed confirmation',async()=>{
 const results=await Promise.all([createManagedWhatsAppGroup(scope,'Committee'),createManagedWhatsAppGroup(scope,'Committee')]);
 assert.equal(calls.length,1);assert.equal(rows.size,1);assert.equal(rows.get('project').isActive,false);assert.ok(results.every(r=>r.group));
 assert.equal(calls[0].url,'https://graph.facebook.com/v23.0/platform-phone/groups');
 assert.deepEqual(calls[0].body,{messaging_product:'whatsapp',subject:'Committee',join_approval_mode:'auto_approve'});
 await receiveManagedGroupLifecycle(event());
 const setup=await managedWhatsAppSetup(scope);assert.equal(setup.group.status,'ready');assert.equal(setup.group.invite_link,'https://chat.whatsapp.com/Invite123');
 assert.ok(!JSON.stringify(setup).includes('platform-secret'));assert.ok(!JSON.stringify(setup).includes('encryptedAccessToken'));
 await createManagedWhatsAppGroup(scope,'Duplicate');assert.equal(calls.length,1);
});
test('early lifecycle delivery is durable and reconciles after the POST response',async()=>{early=true;const result=await createManagedWhatsAppGroup(scope,'Committee');assert.equal(result.group.status,'ready');assert.equal(inbox.size,1);});
test('foreign account, unknown request and unsafe invitation cannot activate a group',async()=>{
 await createManagedWhatsAppGroup(scope,'Committee');
 const foreign=event();foreign.entry[0].id='foreign';await receiveManagedGroupLifecycle(foreign);
 await receiveManagedGroupLifecycle(event('foreign-request'));
 await receiveManagedGroupLifecycle(event('request-1',{invite_link:'https://chat.whatsapp.com.evil.test/invite'}));
 assert.equal(rows.get('project').isActive,false);assert.equal((await managedWhatsAppSetup({...scope,tenantId:'other'})).group,null);
 for(const url of ['javascript:alert(1)','http://chat.whatsapp.com/abc','https://evil.test/abc','https://user@chat.whatsapp.com/abc','https://chat.whatsapp.com/abc?x=1'])assert.equal(safeInviteLink(url),null);
});
test('uncertain outcomes cannot create duplicates; definite rejection allows an explicit retry',async()=>{
 interrupt=true;assert.equal((await createManagedWhatsAppGroup(scope,'Committee')).group.status,'unknown');
 interrupt=false;await createManagedWhatsAppGroup(scope,'Committee');assert.equal(calls.length,1);
 rows.clear();calls=[];responseStatus=403;assert.equal((await createManagedWhatsAppGroup(scope,'Committee')).group.status,'failed');
 responseStatus=200;await createManagedWhatsAppGroup(scope,'Committee');assert.equal(calls.length,2);
});
test('package and platform readiness deny creation before a provider call',async()=>{
 paid=false;await assert.rejects(createManagedWhatsAppGroup(scope,'Committee'),e=>e.code==='BUSINESS_REQUIRED');
 paid=true;process.env.WHATSAPP_GROUPS_ENABLED='false';await assert.rejects(createManagedWhatsAppGroup(scope,'Committee'),e=>e.statusCode===503);
 assert.equal(calls.length,0);assert.equal(rows.size,0);
});
test('failed creation event cannot override ready state on duplicate delivery',async()=>{
 await createManagedWhatsAppGroup(scope,'Committee');await receiveManagedGroupLifecycle(event());
 await receiveManagedGroupLifecycle(event('request-1',{errors:[{code:1}]}));assert.equal(rows.get('project').groupSetupStatus,'ready');
});
test('customer routes refuse credentials and verify lifecycle signatures even when legacy AI is disabled',async()=>{
 const app=express();app.use('/webhook',express.raw({type:'application/json'}),whatsappBotWebhookRouter);app.use(express.json());
 app.use((req,_res,next)=>{req.auth={...scope,roles:[req.header('x-role')??'admin']};next();});app.use(whatsappRouter);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  let r=await originalFetch(base+'/integrations/whatsapp/groups',{method:'POST',headers:{'content-type':'application/json','x-role':'accountant'},body:JSON.stringify({name:'Committee'})});assert.equal(r.status,403);
  r=await originalFetch(base+'/integrations/whatsapp',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({access_token:'customer-secret'})});assert.equal(r.status,410);
  await createManagedWhatsAppGroup(scope,'Committee');const body=JSON.stringify(event());
  r=await originalFetch(base+'/webhook',{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':'sha256=bad'},body});assert.equal(r.status,403);assert.equal(rows.get('project').isActive,false);
  r=await originalFetch(base+'/webhook',{method:'POST',headers:{'content-type':'application/json','x-hub-signature-256':`sha256=${createHmac('sha256','meta-test-secret').update(body).digest('hex')}`},body});assert.equal(r.status,200);assert.equal(rows.get('project').isActive,true);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('creation callbacks without an invitation retrieve it using the authoritative group ID',async()=>{
 await createManagedWhatsAppGroup(scope,'Committee');await receiveManagedGroupLifecycle(event('request-1',{invite_link:undefined}));
 const result=await managedWhatsAppSetup(scope);assert.equal(result.group.status,'ready');assert.equal(result.group.invite_link,'https://chat.whatsapp.com/FromLookup');
});

test('provider rejection preserves a safe support reference and never exposes provider text',async()=>{
 responseStatus=400;providerError={error:{code:190,error_subcode:463,message:'Expired platform-secret-token-for-tests'}};
 const original=console.warn,logs=[];console.warn=(...args)=>logs.push(args);
 let result;try{result=await createManagedWhatsAppGroup(scope,'Committee');}finally{console.warn=original;}
 assert.equal(result.group.status,'failed');assert.match(result.group.error,/connection needs renewal/);assert.match(result.group.error,/WA-190-463/);
 assert.match(JSON.stringify(logs),/credentials/);assert.ok(!JSON.stringify({result,logs}).includes('platform-secret-token-for-tests'));
});
