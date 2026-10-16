import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import nodemailer from 'nodemailer';
import {Prisma} from '@prisma/client';
import {prisma} from '../dist/core/prisma/client.js';
import {env} from '../dist/config/env.js';
import {createApp} from '../dist/app.js';
import {signAccessToken,hashToken} from '../dist/core/security/jwt.js';
import {recordManualPayment,manualPaymentSchema} from '../dist/modules/internal/payments.service.js';
import {assistantStatus,reserveReply} from '../dist/modules/assistant/assistant.service.js';
import {cleanupPreview,beginCleanup,runCleanup,tenantDeletionOrder} from '../dist/modules/internal/cleanup.service.js';
import {storeObject,readObject,StorageObjectNotFoundError} from '../dist/core/storage/object-storage.service.js';

test('isolated PostgreSQL: support, invitations, quota resets, exports and complete tenant cleanup', {skip:process.env.RUN_PLATFORM_INTEGRATION!=='true'}, async t=>{
 const dbUrl=new URL(process.env.DATABASE_URL);assert.equal(dbUrl.hostname,'127.0.0.1');assert.equal(dbUrl.pathname,'/fundnesta_verify','Integration tests are restricted to the disposable database');
 env.internalApiKey='synthetic-platform-key-only-01234567890123456789';env.smtp.user='synthetic';env.smtp.pass='synthetic';
 const delivered=[];nodemailer.createTransport=()=>({sendMail:async mail=>{delivered.push(mail);return{messageId:'synthetic-only'};}});
 // db push does not install the existing quota function/triggers. Install those
 // against this disposable database so new routes run under the real guards.
 const quotaSql=await readFile(new URL('../prisma/migrations/20261016120000_organization_package_quotas/migration.sql',import.meta.url),'utf8');
 const statements=quotaSql.slice(quotaSql.indexOf('CREATE FUNCTION organization_quota_identities'));
 // A single simple-query call accepts dollar-quoted function bodies and triggers.
 const {execFileSync}=await import('node:child_process');
 const {writeFile}=await import('node:fs/promises');
 const sqlFile='/private/tmp/fundnesta-platform-quota-test.sql';await writeFile(sqlFile,statements);
 const installed=await prisma.$queryRaw`SELECT count(*) AS count FROM pg_proc WHERE proname='organization_quota_identities'`;
 if(Number(installed[0].count)===0)execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','execute','--file',sqlFile,'--schema','prisma/schema.prisma'],{env:process.env,stdio:'pipe'});
 const prefix=`platform-${randomUUID()}`;
 async function org(name,paid=true){return prisma.tenant.create({data:{name,slug:`${prefix}-${name}`,contact:{subscription:{status:paid?'active':'expired',package:paid?'business':'starter',billing_cycle:'monthly',current_period_end_at:new Date(Date.now()+(paid?30:-100)*86400000).toISOString()}}}});}
 const ownerOrg=await org('owner'),foreign=await org('foreign'),expired=await org('expired',false);
 const owner=await prisma.user.create({data:{tenantId:ownerOrg.id,name:'Owner',mobile:'+8801711000001'}}),other=await prisma.user.create({data:{tenantId:ownerOrg.id,name:'Other',mobile:'+8801711000002'}}),expiredUser=await prisma.user.create({data:{tenantId:expired.id,name:'Expired user',mobile:'+8801711000003'}});
 const project=await prisma.project.create({data:{tenantId:ownerOrg.id,name:'Fund',totalShares:54}});
 await prisma.projectMembership.create({data:{tenantId:ownerOrg.id,projectId:project.id,userId:owner.id,role:'owner'}});
 const memberUser=await prisma.user.create({data:{tenantId:ownerOrg.id,name:'Imported member',mobile:'+8801711000004'}});
 const member=await prisma.member.create({data:{tenantId:ownerOrg.id,projectId:project.id,userId:memberUser.id,name:memberUser.name,mobile:memberUser.mobile,shares:1}});
 await prisma.projectMembership.create({data:{tenantId:ownerOrg.id,projectId:project.id,userId:memberUser.id,memberId:member.id,role:'member'}});
 async function token(user,projectId=null){const id=randomUUID(),value=signAccessToken({tenantId:user.tenantId,userId:user.id,sessionId:id});await prisma.session.create({data:{id,tenantId:user.tenantId,userId:user.id,activeProjectId:projectId,tokenHash:hashToken(value),expiresAt:new Date(Date.now()+86400000)}});return value;}
 const ownerToken=await token(owner,project.id),otherToken=await token(other),expiredToken=await token(expiredUser),memberToken=await token(memberUser,project.id);
 const server=createApp().listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const internal={'x-internal-api-key':env.internalApiKey,'x-internal-actor':'synthetic-operator'};
 const json=async(path,method,body,headers={})=>{const response=await fetch(base+path,{method,headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,data:await response.json()};};
 const multipart=async(path,auth,{subject,body='',request_key=randomUUID(),file}={})=>{const form=new FormData();form.append('request_key',request_key);form.append('body',body);if(subject)form.append('subject',subject);if(file)form.append('files',new Blob([file],{type:'image/png'}),'screenshot.png');const r=await fetch(base+path,{method:'POST',headers:auth,body:form});return{status:r.status,data:await r.json()};};
 try{
  await t.test('late-added email can be invited from the member profile; Gmail maps to the linked account',async()=>{
   const headers={Authorization:`Bearer ${ownerToken}`,'x-project-id':project.id};
   assert.equal((await json(`/v1/members/${member.id}/invitation`,'POST',{request_key:randomUUID()},headers)).status,400);assert.equal(delivered.length,0);
   assert.equal((await json(`/v1/members/${member.id}/profile`,'PATCH',{email:'member@example.test'},headers)).status,200);
   const request_key=randomUUID();assert.equal((await json(`/v1/members/${member.id}/invitation`,'POST',{request_key},headers)).data.data.status,'sent');
   assert.equal(delivered.length,1);assert.match(delivered[0].text,/member@example.test/);assert.match(delivered[0].text,/Google/);assert.match(delivered[0].text,/play.google.com/);
   assert.equal((await prisma.user.findUnique({where:{id:memberUser.id}})).email,'member@example.test');
   assert.equal((await json(`/v1/members/${member.id}/invitation`,'POST',{request_key},headers)).data.data.replayed,true);assert.equal(delivered.length,1);
   assert.equal((await json(`/v1/members/${member.id}/invitation`,'POST',{request_key:randomUUID()},{Authorization:`Bearer ${memberToken}`,'x-project-id':project.id})).status,403);
  });
  let ticketId,attachmentId;
  await t.test('expired accounts can send support screenshots; only the requester and team can read them',async()=>{
   const auth={Authorization:`Bearer ${expiredToken}`},request_key=randomUUID(),file=Buffer.from([137,80,78,71,13,10,26,10,0]);
   const sent=await multipart('/v1/support/tickets',auth,{subject:'Test support',body:'Synthetic question',request_key,file});assert.equal(sent.status,201,JSON.stringify(sent.data));ticketId=sent.data.data.ticket.id;attachmentId=sent.data.data.message.attachments[0].id;
   const retry=await multipart('/v1/support/tickets',auth,{subject:'Test support',body:'Synthetic question',request_key,file});assert.equal(retry.data.data.replayed,true);assert.equal(await prisma.supportMessage.count({where:{ticketId}}),1);
   const bad=await multipart('/v1/support/tickets',auth,{subject:'Bad file',body:'No script images',file:Buffer.from('<script>bad</script>')});assert.equal(bad.status,400);
   assert.equal((await json(`/v1/support/tickets/${ticketId}`,'GET',undefined,{Authorization:`Bearer ${ownerToken}`})).status,404);
   assert.equal((await fetch(base+`/v1/support/attachments/${attachmentId}`,{headers:{Authorization:`Bearer ${ownerToken}`}})).status,404);
   assert.equal((await fetch(base+`/v1/support/attachments/${attachmentId}`,{headers:auth})).status,200);
   assert.equal((await multipart(`/v1/internal/support/tickets/${ticketId}/messages`,internal,{body:'Synthetic team reply'})).status,201);
   const read=await json(`/v1/support/tickets/${ticketId}`,'GET',undefined,auth);assert.equal(read.data.data.messages.length,2);assert.equal(read.data.data.messages[1].sender,'team');
   assert.equal((await json(`/v1/internal/support/tickets/${ticketId}`,'GET',undefined,{})).status,401);
  });
  await t.test('manual plan changes reset allowance timestamps precisely, even twice on the same day',async()=>{
   const payment=()=>manualPaymentSchema.parse({request_key:randomUUID(),package:'business',billing_cycle:'monthly',amount:5000,method:'bank',reference:'SYNTHETIC',paid_at:new Date().toISOString()});
   const first=payment();await recordManualPayment(ownerOrg.id,first,'operator');
   await reserveReply({tenantId:ownerOrg.id,projectId:project.id,userId:owner.id,channel:'ai_chat',requestKey:randomUUID(),prompt:'Synthetic'});
   assert.equal((await assistantStatus(ownerOrg.id)).features.ai_chat.used,1);
   await recordManualPayment(ownerOrg.id,payment(),'operator');assert.equal((await assistantStatus(ownerOrg.id)).features.ai_chat.used,0);
   await reserveReply({tenantId:ownerOrg.id,projectId:project.id,userId:owner.id,channel:'ai_chat',requestKey:randomUUID(),prompt:'Synthetic after reset'});assert.equal((await assistantStatus(ownerOrg.id)).features.ai_chat.used,1);
   const replay=await recordManualPayment(ownerOrg.id,first,'operator');assert.equal(replay.replayed,true);assert.equal((await assistantStatus(ownerOrg.id)).features.ai_chat.used,1);
  });
  await t.test('monitoring is keyed, reports actual counts, and export is tenant scoped',async()=>{
   assert.equal((await json('/v1/internal/summary','GET',undefined,{Authorization:`Bearer ${ownerToken}`})).status,401);
   const summary=await json(`/v1/internal/tenants/${ownerOrg.id}`,'GET',undefined,internal);assert.equal(summary.status,200,JSON.stringify(summary.data));assert.equal(summary.data.data.counts.members,1);assert.equal(summary.data.data.counts.projects,1);
   const workbook=await fetch(base+`/v1/internal/tenants/${ownerOrg.id}/export.xlsx`,{headers:internal});assert.equal(workbook.status,200);assert.ok((await workbook.arrayBuffer()).byteLength>1000);
   assert.equal((await fetch(base+`/v1/internal/tenants/${ownerOrg.id}/export.xlsx?project_id=foreign`,{headers:internal})).status,404);
   const preview=await json(`/v1/internal/tenants/${ownerOrg.id}/cleanup`,'POST',{},internal);assert.equal(preview.data.data.eligibility.eligible,false);assert.equal(await prisma.tenant.count({where:{id:ownerOrg.id}}),1);
  });
  await t.test('app-seen tracking keeps the original first use and separates web from native usage',async()=>{
   const headers={Authorization:`Bearer ${memberToken}`},installation_id=randomUUID();
   const first=await json('/v1/support/installations','POST',{installation_id,platform:'android',app_version:'test-1'},headers);
   const again=await json('/v1/support/installations','POST',{installation_id,platform:'android',app_version:'test-2'},headers);
   assert.equal(first.status,200);assert.equal(first.data.data.first_app_seen_at,again.data.data.first_app_seen_at);
   assert.equal(await prisma.appInstallation.count({where:{tenantId:ownerOrg.id,userId:memberUser.id}}),1);
   const status=await json(`/v1/members/${member.id}/invitation`,'GET',undefined,{Authorization:`Bearer ${ownerToken}`,'x-project-id':project.id});assert.ok(status.data.data.first_app_seen_at);
  });
  await t.test('cleanup refuses shared identities, renewed coverage and stale previews before freezing',async()=>{
   const target=await org('blocked',false),root=await prisma.user.create({data:{tenantId:target.id,name:'Synthetic root',mobile:'+8801711000091'}});
   const linked=await prisma.user.create({data:{tenantId:foreign.id,name:'Synthetic linked account',mobile:'+8801711000092',identityRootId:root.id}});
   let preview=await cleanupPreview(target.id);
   await assert.rejects(beginCleanup(target.id,preview.preview_token,preview.confirmation,'operator'),/linked to other organizations/);
   assert.equal((await prisma.tenant.findUnique({where:{id:target.id}})).deletionStartedAt,null);
   await prisma.user.update({where:{id:linked.id},data:{identityRootId:null}});
   await prisma.tenant.update({where:{id:target.id},data:{name:'Changed after preview'}});
   await assert.rejects(beginCleanup(target.id,preview.preview_token,preview.confirmation,'operator'),/changed/);
   preview=await cleanupPreview(target.id);
   await prisma.tenant.update({where:{id:target.id},data:{contact:{subscription:{status:'active',package:'starter',current_period_end_at:new Date(Date.now()+86400000).toISOString()}}}});
   await assert.rejects(beginCleanup(target.id,preview.preview_token,preview.confirmation,'operator'),/active subscription/);
  });
  await t.test('cleanup deletes every tenant-scoped model and orphan object, preserving a foreign tenant and minimal audit',async()=>{
   const target=await org('cleanup',false),parents=new Map([['Tenant',target]]),models=Prisma.dmmf.datamodel.models;
   for(const name of tenantDeletionOrder().reverse()){
    const model=models.find(m=>m.name===name),data={};
    for(const field of model.fields){
     if(field.kind==='object'||field.hasDefaultValue||!field.isRequired||field.isUpdatedAt)continue;
     if(field.name==='tenantId'){data[field.name]=target.id;continue;}
     const relation=model.fields.find(f=>f.relationFromFields?.includes(field.name));
     if(relation){const parent=parents.get(relation.type);assert.ok(parent,`${name} requires ${relation.type}`);data[field.name]=parent[relation.relationToFields[relation.relationFromFields.indexOf(field.name)]];continue;}
     data[field.name]=field.isList?[]:field.kind==='enum'?Prisma.dmmf.datamodel.enums.find(e=>e.name===field.type).values[0].name:field.type==='DateTime'?new Date():field.type==='Decimal'?'1':field.type==='Int'||field.type==='Float'?1:field.type==='Boolean'?true:field.type==='Json'?{}:`synthetic-${randomUUID()}`;
    }
    if(name==='Upload'||name==='SupportAttachment')data.storageKey=`${target.id}/${name}/sample`;
    const delegate=prisma[name[0].toLowerCase()+name.slice(1)],row=await delegate.create({data});parents.set(name,row);
   }
   for(const name of ['Upload','SupportAttachment'])await storeObject({storageKey:parents.get(name).storageKey,buffer:Buffer.from('Synthetic tracked object')});
   await storeObject({storageKey:`${target.id}/orphan-file`,buffer:Buffer.from('Synthetic orphan')});
   await storeObject({storageKey:`${foreign.id}/keep-file`,buffer:Buffer.from('Keep this synthetic foreign file')});
   const preview=await cleanupPreview(target.id);assert.equal(preview.eligibility.eligible,true);assert.ok(Object.values(preview.counts).every(n=>n>=1));
   await assert.rejects(beginCleanup(target.id,preview.preview_token,'DELETE wrong','operator'),/confirmation/);
   const job=await beginCleanup(target.id,preview.preview_token,preview.confirmation,'operator');
   assert.ok((await prisma.tenant.findUnique({where:{id:target.id}})).deletionStartedAt);
   assert.ok((await runCleanup(job.id,'operator')).run_after_at);
   await prisma.tenantDeletionJob.update({where:{id:job.id},data:{createdAt:new Date(Date.now()-301000)}});
   const {symlink,unlink}=await import('node:fs/promises'),badLink=`${process.env.UPLOAD_LOCAL_DIR}/${target.id}/unsupported-link`;
   await symlink('/private/tmp',badLink);
   await assert.rejects(runCleanup(job.id,'operator'),/symbolic link/);
   assert.ok(await prisma.tenant.findUnique({where:{id:target.id}}));assert.equal(await prisma.upload.count({where:{tenantId:target.id}}),1);
   await unlink(badLink);
   let result;for(let i=0;i<10;i++){result=await runCleanup(job.id,'operator');if(result.status==='completed')break;}
   assert.equal(result.status,'completed');assert.equal(await prisma.tenant.findUnique({where:{id:target.id}}),null);
   for(const name of tenantDeletionOrder())assert.equal(await prisma[name[0].toLowerCase()+name.slice(1)].count({where:{tenantId:target.id}}),0,name);
   await assert.rejects(readObject(`${target.id}/orphan-file`),StorageObjectNotFoundError);
   assert.equal((await readObject(`${foreign.id}/keep-file`)).buffer.toString(),'Keep this synthetic foreign file');assert.ok(await prisma.tenant.findUnique({where:{id:foreign.id}}));
   assert.equal(await prisma.internalAudit.count({where:{tenantId:target.id,action:'tenant.cleanup_completed'}}),1);
   assert.equal((await runCleanup(job.id,'operator')).status,'completed');
  });
 }finally{await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();}
});
