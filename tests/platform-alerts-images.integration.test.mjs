import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import nodemailer from 'nodemailer';
const database=process.env.UPGRADE_TEST_DATABASE_URL;
test('isolated migration: durable alerts, channel retries, previous dues and private AI images',{skip:!database},async t=>{
 const url=new URL(database);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/fundtest');
 Object.assign(process.env,{DATABASE_URL:database,JWT_SECRET:'upgrade-isolated-test-secret',NODE_ENV:'test',UPLOAD_STORAGE:'local',UPLOAD_LOCAL_DIR:'/private/tmp/fund-upgrade-test-storage',INTERNAL_API_KEY:'upgrade-internal-key-for-test-only-0123456789',SMTP_USER:'synthetic',SMTP_PASS:'synthetic',AI_CHAT_ENABLED:'true',OPENAI_API_KEY:'synthetic',OPENAI_CHAT_MODEL:'synthetic',PLATFORM_ALERT_EMAILS:'hello@example.test',PLATFORM_ALERT_TELEGRAM_CHAT_ID:'-100-test',TELEGRAM_BOT_TOKEN:'synthetic-test-token',ADMIN_WEB_URL:'https://admin.example.test'});
 const mail=[],telegram=[],inputs=[];let failEmail=true,failTelegram=false;
 nodemailer.createTransport=()=>({sendMail:async message=>{if(failEmail)throw Error('Synthetic mail outage');mail.push(message);}});
 const {prisma}=await import('../dist/core/prisma/client.js'),{createApp}=await import('../dist/app.js'),{signAccessToken,hashToken}=await import('../dist/core/security/jwt.js'),{deliverPlatformAlerts}=await import('../dist/modules/internal/alerts.service.js'),{renewTenantSubscription}=await import('../dist/core/subscription/subscription.service.js'),{tenantObjectKeys,purgeObject}=await import('../dist/core/storage/object-storage.service.js');
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  if(String(url).startsWith('https://api.telegram.org/')){if(failTelegram)return Response.json({ok:false},{status:503});telegram.push(JSON.parse(options.body));return Response.json({ok:true});}
  if(String(url)==='https://api.openai.com/v1/responses'){inputs.push(JSON.parse(options.body));return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Authorized reply.'}]}]});}
  if(!String(url).startsWith('http://127.0.0.1:'))throw Error('External calls blocked by test');return originalFetch(url,options);
 };
 const tenant=await prisma.tenant.create({data:{name:'Synthetic customer fund',slug:'upgrade-'+randomUUID(),contact:renewTenantSubscription({},new Date(),{package:'business',billing_cycle:'yearly'}).contact}});
 const project=await prisma.project.create({data:{tenantId:tenant.id,name:'Synthetic project',totalShares:54}}),user=await prisma.user.create({data:{tenantId:tenant.id,name:'Test customer',mobile:'+8801700000099',email:'customer@example.test'}});
 await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:project.id,userId:user.id,role:'owner'}});
 const member=await prisma.member.create({data:{tenantId:tenant.id,projectId:project.id,userId:user.id,name:user.name,mobile:user.mobile,shares:2,mid:'S2'}});
 const outsider=await prisma.user.create({data:{tenantId:tenant.id,name:'Other customer',mobile:'+8801700000098'}});
 await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:project.id,userId:outsider.id,role:'owner'}});
 async function headers(u){const id=randomUUID(),token=signAccessToken({tenantId:tenant.id,userId:u.id,sessionId:id});await prisma.session.create({data:{id,tenantId:tenant.id,userId:u.id,activeProjectId:project.id,tokenHash:hashToken(token),expiresAt:new Date(Date.now()+3600000)}});return{Authorization:'Bearer '+token,'x-project-id':project.id};}
 const own=await headers(user),other=await headers(outsider),internal={'x-internal-api-key':process.env.INTERNAL_API_KEY,'x-internal-actor':'test-admin'};
 const server=createApp().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
 const get=async(path,h=internal)=>{const r=await fetch(base+path,{headers:h});return{status:r.status,body:await r.json()};};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9t8AAAAASUVORK5CYII=','base64');
 async function multipart(path,h,fields,file=png){const form=new FormData();for(const [k,v]of Object.entries(fields))form.append(k,v);if(file)form.append('files',new Blob([file],{type:'image/png'}),'screenshot.png');const r=await fetch(base+path,{method:'POST',headers:h,body:form});return{status:r.status,body:await r.json()};}
 try{
  await t.test('source rollback does not emit an alert; signup resolves customer contacts and actual shares',async()=>{
   await assert.rejects(prisma.$transaction(async tx=>{await tx.tenant.create({data:{id:'rollback-org',name:'Rolled back',slug:'rollback-'+randomUUID()}});throw Error('Rollback');}));
   assert.equal(await prisma.platformAlert.count({where:{tenantId:'rollback-org'}}),0);
   const r=await get('/v1/internal/alerts');assert.equal(r.status,200);const alert=r.body.data.alerts.find(a=>a.tenantId===tenant.id);assert.equal(alert.kind,'signup');assert.equal(alert.customer.name,user.name);assert.equal(alert.customer.mobile,user.mobile);assert.equal(alert.customer.email,user.email);assert.equal(alert.customer.shares,2);assert.equal(alert.customer.members[0].mid,'S2');
   assert.equal((await get('/v1/internal/alerts',own)).status,401);
  });
  let ticket;
  await t.test('support retries create one event, team replies create none, conversation exposes contacts only internally',async()=>{
   const fields={request_key:randomUUID(),subject:'Synthetic issue',body:'Please help'};
   let r=await multipart('/v1/support/tickets',own,fields);assert.equal(r.status,201,JSON.stringify(r.body));ticket=r.body.data.ticket.id;
   r=await multipart('/v1/support/tickets',own,fields);assert.equal(r.body.data.replayed,true);
   assert.equal(await prisma.platformAlert.count({where:{ticketId:ticket}}),1);
   r=await multipart(`/v1/internal/support/tickets/${ticket}/messages`,internal,{request_key:randomUUID(),body:'Team reply'});assert.equal(r.status,201);
   assert.equal(await prisma.platformAlert.count({where:{ticketId:ticket}}),1);
   r=await get(`/v1/internal/support/tickets/${ticket}`);assert.equal(r.body.data.customer.shares,2);assert.equal(r.body.data.messages.at(-1).body,'Team reply');
   r=await get(`/v1/support/tickets/${ticket}`,own);assert.equal(r.body.data.customer,undefined);
   const read=await fetch(base+`/v1/internal/support/tickets/${ticket}/read`,{method:'POST',headers:internal});assert.equal(read.status,200);assert.equal(await prisma.platformAlert.count({where:{ticketId:ticket,readAt:null}}),0);
  });
  await t.test('Telegram delivers during email outage; later email retry never resends Telegram',async()=>{
   await deliverPlatformAlerts();assert.equal(mail.length,0);assert.equal(telegram.length,2);assert.match(telegram[0].text,/Test customer/);assert.match(telegram[0].text,/customer@example.test/);assert.match(telegram[1].text,/view=support/);
   const alerts=await prisma.platformAlert.findMany({where:{tenantId:tenant.id}});assert.ok(alerts.every(a=>a.telegramSentAt&&!a.emailSentAt));
   failEmail=false;await prisma.platformAlert.updateMany({where:{tenantId:tenant.id},data:{nextAttemptAt:new Date(0)}});await deliverPlatformAlerts();assert.equal(mail.length,2);assert.equal(telegram.length,2);await deliverPlatformAlerts();assert.equal(mail.length,2);
   const later=await multipart(`/v1/support/tickets/${ticket}/messages`,own,{request_key:randomUUID(),body:'Follow up'},null);assert.equal(later.status,201);failTelegram=true;await deliverPlatformAlerts();assert.equal(mail.length,3);failTelegram=false;await prisma.platformAlert.updateMany({where:{tenantId:tenant.id,telegramSentAt:null},data:{telegramNextAttemptAt:new Date(0)}});await deliverPlatformAlerts();assert.equal(mail.length,3);assert.equal(telegram.length,3);
  });
  await t.test('previous installment is included on request, inspectable, scoped and remains immutable',async()=>{
   const schedule=await prisma.schedule.create({data:{tenantId:tenant.id,projectId:project.id,name:'Before opening',purpose:'previous_installment',totalAmount:100,dueDate:new Date('2025-01-01'),createdById:user.id,status:'active'}});
   await prisma.due.create({data:{tenantId:tenant.id,projectId:project.id,memberId:member.id,scheduleId:schedule.id,amount:100,paidAmount:20,dueDate:schedule.dueDate}});
   let r=await get('/v1/schedules?include_system=true',own);assert.equal(r.body.data.find(s=>s.id===schedule.id).collection.remaining,80);
   r=await get(`/v1/schedules/${schedule.id}/member-summary`,own);assert.equal(r.status,200);assert.equal(r.body.data.items[0].due.outstanding,80);
   const update=await fetch(base+'/v1/schedules/'+schedule.id,{method:'PATCH',headers:{...own,'content-type':'application/json'},body:JSON.stringify({name:'Changed'})});assert.equal(update.status,400);
   r=await get('/v1/schedules',own);assert.equal(r.body.data.some(s=>s.id===schedule.id),false);
  });
  await t.test('AI images reach Responses once, retries retain quota and access never crosses users',async()=>{
   const fields={request_key:randomUUID(),message:'Explain this screenshot'};
   let r=await multipart('/v1/assistant/messages',own,fields);assert.equal(r.status,200,JSON.stringify(r.body));const image=r.body.data.attachments[0].id,reply=r.body.data.id;
   assert.equal(inputs.length,1);assert.equal(inputs[0].store,false);const parts=inputs[0].input.at(-1).content;assert.equal(parts[0].type,'input_text');assert.match(parts[1].image_url,/^data:image\/png;base64,/);
   r=await multipart('/v1/assistant/messages',own,fields);assert.equal(r.status,200);assert.equal(inputs.length,1);assert.equal(await prisma.assistantAttachment.count({where:{replyId:reply}}),1);
   assert.equal((await fetch(base+'/v1/assistant/attachments/'+image,{headers:own})).status,200);assert.equal((await fetch(base+'/v1/assistant/attachments/'+image,{headers:other})).status,404);
   r=await multipart('/v1/assistant/messages',own,{...fields,message:'Changed question'});assert.equal(r.status,409);
   r=await multipart('/v1/assistant/messages',own,{...fields,request_key:randomUUID()},Buffer.from('<script>'));assert.equal(r.status,400);
   const extra=new FormData();extra.append('request_key',randomUUID());extra.append('message','Four files');for(let i=0;i<4;i++)extra.append('files',new Blob([png],{type:'image/png'}),'image.png');
   assert.equal((await fetch(base+'/v1/assistant/messages',{method:'POST',headers:own,body:extra})).status,400);
   const exact=Buffer.alloc(5_000_000);png.copy(exact);r=await multipart('/v1/assistant/messages',own,{request_key:randomUUID(),message:'Exact size boundary'},exact);assert.equal(r.status,200,JSON.stringify(r.body));
   r=await multipart('/v1/assistant/messages',own,{request_key:randomUUID(),message:'Oversize'},Buffer.concat([exact,Buffer.from([0])]));assert.equal(r.status,413);
   await prisma.projectMembership.updateMany({where:{userId:user.id},data:{isActive:false}});assert.equal((await fetch(base+'/v1/assistant/attachments/'+image,{headers:own})).status,403);
  });
 }finally{globalThis.fetch=originalFetch;await new Promise(resolve=>server.close(resolve));for(const key of await tenantObjectKeys(tenant.id,100))await purgeObject(key);await prisma.tenant.delete({where:{id:tenant.id}});await prisma.$disconnect();}
});
