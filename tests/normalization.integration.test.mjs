import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import express from 'express';import {rm} from 'node:fs/promises';
const target=process.env.NORMALIZATION_TEST_DATABASE_URL;
if(!target)throw Error('Set NORMALIZATION_TEST_DATABASE_URL to an isolated migrated test database.');
const url=new URL(target);if(!['127.0.0.1','localhost'].includes(url.hostname)||!url.pathname.endsWith('_test'))throw Error('Only a local *_test database is allowed.');
process.env.DATABASE_URL=target;process.env.JWT_SECRET='normalization-integration-tests-only';process.env.NODE_ENV='production';process.env.UPLOAD_STORAGE='local';process.env.UPLOAD_LOCAL_DIR=`/tmp/fundledger-normalization-proof-${process.pid}`;
const {prisma}=await import('../dist/core/prisma/client.js');
const {tenantAccounts}=await import('../dist/core/identity/tenant-accounts.js');
const {createOneMonthTrial,renewTenantSubscription,evaluateSubscription}=await import('../dist/core/subscription/subscription.service.js');
const {saveSubscription,subscriptionContext}=await import('../dist/core/subscription/subscription.repository.js');
const {selectPackage}=await import('../dist/modules/subscription/package-selection.service.js');
const {listInvoices,submitInvoicePayment,reviewInvoicePayment}=await import('../dist/modules/subscription/billing.service.js');
const {recordManualPayment}=await import('../dist/modules/internal/payments.service.js');
const {findActiveUsersByEmail,findActiveUsersByMobile,issueLoginSession}=await import('../dist/modules/auth/auth.service.js');
const {linkedIdentityUsers}=await import('../dist/core/security/linked-identity.js');
const {tenantQuota}=await import('../dist/core/subscription/quota.service.js');
const {authenticate}=await import('../dist/core/security/auth.middleware.js');
const {subscriptionRouter}=await import('../dist/modules/subscription/subscription.routes.js');
const {authRouter}=await import('../dist/modules/auth/auth.routes.js');
const {projectsRouter}=await import('../dist/modules/projects/projects.routes.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
let a,b,other,server,base;const tenantIds=[],globalIds=new Set();
async function organization(name){
 const tenant=await prisma.tenant.create({data:{name,slug:`normalization-${randomUUID()}`}});tenantIds.push(tenant.id);
 await prisma.$transaction(tx=>saveSubscription(tx,tenant.id,createOneMonthTrial(),{event:'trial_started'}));return tenant;
}
async function member(tenant,name,mobile,email,identityRootId){
 const account=await tenantAccounts(prisma).create({data:{tenantId:tenant.id,name,mobile,email,userId:identityRootId}});globalIds.add(account.userId);
 const project=await prisma.project.create({data:{tenantId:tenant.id,name:'Test project',totalShares:1}});
 await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:project.id,userId:account.id,role:'owner'}});
 return {tenant,account,project};
}
const request=async(path,token,options={})=>{const response=await fetch(base+path,{...options,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...options.headers}});return {status:response.status,body:await response.json()};};
before(async()=>{
 a=await member(await organization('A'),'Owner','01711000001','Owner@example.test');
 b=await member(await organization('B'),'Owner','+8801711000001','owner@example.test',a.account.userId);
 other=await member(await organization('Other'),'Other','01711000002','other@example.test');
 const app=express();app.use(express.json());app.use('/subscription',authenticate,subscriptionRouter);app.use('/auth',authRouter);app.use('/projects',authenticate,projectsRouter);app.use(errorHandler);
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));for(const id of tenantIds)await prisma.tenant.deleteMany({where:{id}});await prisma.user.deleteMany({where:{id:{in:[...globalIds]}}});await prisma.$disconnect();await rm(process.env.UPLOAD_LOCAL_DIR,{recursive:true,force:true});});
test('one global identity has independent tenant memberships with canonical unique contacts',async()=>{
 assert.equal(a.account.userId,b.account.userId);assert.notEqual(a.account.id,b.account.id);
 const identity=await prisma.user.findUniqueOrThrow({where:{id:a.account.userId}});assert.equal(identity.email,'owner@example.test');assert.equal(identity.mobile,'+8801711000001');
 assert.equal((await linkedIdentityUsers(a.account.id)).users.length,2);
 await assert.rejects(prisma.user.create({data:{name:'Duplicate email',email:'owner@example.test'}}),/Unique constraint/);
 await assert.rejects(prisma.user.create({data:{name:'Duplicate phone',mobile:'+8801711000001'}}),/Unique constraint/);
 await assert.rejects(prisma.user.create({data:{name:'Bad casing',email:'OWNER@example.test'}}),/users_email_normalized/);
 await assert.rejects(prisma.user.create({data:{name:'Missing contacts'}}),/users_login_contact_required/);
 await assert.rejects(tenantAccounts(prisma).create({data:{tenantId:other.tenant.id,name:'Conflicting',mobile:'01711000001',email:'other@example.test'}}),/different users/);
});
test('email-only invitations persist NULL mobile and cannot change another user login contacts',async()=>{
 const account=await tenantAccounts(prisma).create({data:{tenantId:a.tenant.id,name:'Email person',mobile:'g:google-123',email:'Email.Person@Example.test'}});globalIds.add(account.userId);
 assert.equal((await prisma.user.findUniqueOrThrow({where:{id:account.userId}})).mobile,null);assert.equal(account.mobile,'');
 await assert.rejects(tenantAccounts(prisma).update({where:{id:account.id},data:{email:'hijack@example.test'}}),/verified account settings/);
});
test('concurrent organization upserts converge on one identity and one membership',async()=>{
 const input={where:{tenantId_mobile:{tenantId:a.tenant.id,mobile:'01711000004'}},create:{tenantId:a.tenant.id,name:'Concurrent',mobile:'01711000004',email:'concurrent@example.test'},update:{}};
 const rows=await Promise.all([tenantAccounts(prisma).upsert(input),tenantAccounts(prisma).upsert(input)]);globalIds.add(rows[0].userId);assert.equal(rows[0].id,rows[1].id);
});
test('email and mobile sign-in discover one identity and all allowed projects',async()=>{
 const emails=await findActiveUsersByEmail(' OWNER@example.test '),mobiles=await findActiveUsersByMobile('01711000001');assert.equal(emails.length,1);assert.equal(mobiles.length,1);
 const login=await issueLoginSession(emails[0]);assert.equal(login.identity_root_id,a.account.userId);assert.equal(login.memberships.length,2);
 const me=await request('/auth/me',login.token);assert.equal(me.status,200);assert.equal(me.body.data.memberships.length,2);
 const switched=await request('/auth/switch-project',login.token,{method:'POST',body:JSON.stringify({project_id:b.project.id})});assert.equal(switched.status,200);assert.equal(switched.body.data.tenant.id,b.tenant.id);
 const forbidden=await request('/subscription/',login.token,{headers:{'x-project-id':other.project.id}});assert.equal(forbidden.status,403);
});
test('database rejects cross-tenant account references',async()=>{
 await assert.rejects(prisma.projectMembership.create({data:{tenantId:other.tenant.id,projectId:other.project.id,userId:a.account.id,role:'member'}}),/ACCOUNT_TENANT_MISMATCH/);
 await assert.rejects(prisma.session.create({data:{tenantId:other.tenant.id,userId:a.account.id,tokenHash:'bad',expiresAt:new Date(Date.now()+60000)}}),/ACCOUNT_TENANT_MISMATCH/);
});
test('deactivating one membership preserves other organizations; global suspension blocks both',async()=>{
 const login=await issueLoginSession((await findActiveUsersByEmail('owner@example.test'))[0],a.project.id);
 await tenantAccounts(prisma).update({where:{id:a.account.id},data:{isActive:false}});
 assert.equal((await request('/auth/me',login.token)).status,401);
 assert.equal((await linkedIdentityUsers(b.account.id)).users.length,1);
 await tenantAccounts(prisma).update({where:{id:a.account.id},data:{isActive:true}});
 await prisma.user.update({where:{id:a.account.userId},data:{isActive:false}});
 assert.equal((await request('/auth/me',login.token)).status,401);
 await assert.rejects(linkedIdentityUsers(b.account.id),/inactive/);
 await prisma.user.update({where:{id:a.account.userId},data:{isActive:true}});
});
test('package selection creates a relational invoice without granting paid access and is idempotent',async()=>{
 const [first,second]=await Promise.all([selectPackage(a.tenant.id,a.account.id,'business','monthly'),selectPackage(a.tenant.id,a.account.id,'business','monthly')]);
 assert.equal(first.id,second.id);assert.equal(first.amount,8000);assert.equal((await prisma.tenantSubscription.findUniqueOrThrow({where:{tenantId:a.tenant.id}})).package,'free');
 assert.equal((await listInvoices(a.tenant.id)).length,1);assert.equal((await listInvoices(b.tenant.id)).length,0);
 const tenant=await prisma.tenant.findUniqueOrThrow({where:{id:a.tenant.id}});assert.equal(tenant.contact,null);
});
test('receipt approval atomically updates invoice, subscription and immutable history once',async()=>{
 const [invoice]=await listInvoices(a.tenant.id),input={payment_reference:'bank-test',payment_amount:invoice.amount,request_key:randomUUID()},buffer=Buffer.from('%PDF-1.7\ntest-proof');
 const file={originalname:'proof.pdf',buffer,size:buffer.length};
 const submitted=await submitInvoicePayment(a.tenant.id,invoice.id,a.account.id,input,file);assert.equal(submitted.status,'submitted');
 const before=await prisma.subscriptionHistory.count({where:{tenantId:a.tenant.id}});
 const [approved,replayed]=await Promise.all([reviewInvoicePayment(a.tenant.id,invoice.id,'approve',undefined,input.request_key),reviewInvoicePayment(a.tenant.id,invoice.id,'approve',undefined,input.request_key)]);
 assert.equal(approved.period_ends_at,replayed.period_ends_at);assert.equal(approved.status,'approved');
 const sub=await prisma.tenantSubscription.findUniqueOrThrow({where:{tenantId:a.tenant.id}});assert.equal(sub.package,'business');assert.equal(sub.status,'active');assert.equal(sub.revision,2);
 const history=await prisma.subscriptionHistory.findMany({where:{tenantId:a.tenant.id},orderBy:{revision:'asc'}});assert.equal(history.length,before+1);assert.equal(history.at(-1).invoiceId,invoice.id);assert.equal(history.at(-1).previous.package,'free');assert.equal(history.at(-1).current.package,'business');
 await assert.rejects(prisma.subscriptionHistory.update({where:{id:history[0].id},data:{event:'tampered'}}),/SUBSCRIPTION_HISTORY_IMMUTABLE/);
 await assert.rejects(prisma.subscriptionHistory.delete({where:{id:history[0].id}}),/SUBSCRIPTION_HISTORY_IMMUTABLE/);
 assert.equal((await tenantQuota(a.tenant.id)).package,'business');assert.equal((await tenantQuota(a.tenant.id)).projects.limit,6);
 assert.equal((await prisma.tenantSubscription.findUniqueOrThrow({where:{tenantId:b.tenant.id}})).package,'free');
});
test('history endpoint is tenant scoped and does not expose unrelated records',async()=>{
 const login=await issueLoginSession((await findActiveUsersByEmail('owner@example.test'))[0],a.project.id);
 const response=await request('/subscription/history?limit=1',login.token);assert.equal(response.status,200);assert.equal(response.body.data.history.length,1);assert.equal(response.body.data.history[0].tenantId,a.tenant.id);assert.equal(response.body.data.next_cursor,'2');
 const next=await request('/subscription/history?cursor=2',login.token);assert.equal(next.status,200);assert.equal(next.body.data.history[0].revision,1);
});
test('history failure rolls back entitlement changes',async()=>{
 const before=await prisma.tenantSubscription.findUniqueOrThrow({where:{tenantId:a.tenant.id}});
 await assert.rejects(prisma.$transaction(tx=>{
  const failing=new Proxy(tx,{get(target,key){if(key==='subscriptionHistory')return new Proxy(target.subscriptionHistory,{get(model,method){return method==='create'?async()=>{throw Error('history unavailable');}:Reflect.get(model,method);}});return Reflect.get(target,key);}});
  return saveSubscription(failing,a.tenant.id,{...createOneMonthTrial(),package:'custom'},{event:'test'});
 }),/history unavailable/);
 assert.deepEqual(await prisma.tenantSubscription.findUniqueOrThrow({where:{tenantId:a.tenant.id}}),before);
});
test('manual payments have one entitlement/history effect across retries',async()=>{
 const input={request_key:randomUUID(),package:'starter',billing_cycle:'yearly',amount:30000,currency:'BDT',method:'bank',reference:'manual-test',paid_at:new Date().toISOString()};
 const first=await recordManualPayment(b.tenant.id,input,'test-operator'),second=await recordManualPayment(b.tenant.id,input,'test-operator');assert.equal(first.replayed,false);assert.equal(second.replayed,true);
 assert.equal(first.payment.id,second.payment.id);const history=await prisma.subscriptionHistory.findMany({where:{tenantId:b.tenant.id,event:'manual_payment'}});assert.equal(history.length,1);assert.equal(history[0].paymentId,first.payment.id);
});
test('authenticated organization creation reuses global identity and creates independent subscription history',async()=>{
 const login=await issueLoginSession((await findActiveUsersByEmail('owner@example.test'))[0],a.project.id);
 const response=await request('/projects/owned-organization',login.token,{method:'POST',body:JSON.stringify({organization_name:'Created organization',name:'Created project',total_shares:1,project_type:'fund_shares'})});
 assert.equal(response.status,201,JSON.stringify(response.body));const id=response.body.data.tenant_id;tenantIds.push(id);
 const account=await prisma.tenantUser.findFirstOrThrow({where:{tenantId:id}});assert.equal(account.userId,a.account.userId);
 assert.equal((await prisma.tenantSubscription.findUniqueOrThrow({where:{tenantId:id}})).package,'free');assert.equal(await prisma.subscriptionHistory.count({where:{tenantId:id,event:'trial_started'}}),1);
});
test('provisioning persists canonical global identity, organization membership and trial atomically',async()=>{
 const {provisionTenant}=await import('../dist/modules/tenants/tenants.service.js');
 const result=await provisionTenant({name:'Signup',slug:'signup-'+randomUUID(),adminName:'New owner',adminMobile:'01711000005',adminEmail:'New.Owner@EXAMPLE.test',projectName:'Signup project',source:'self_signup'});tenantIds.push(result.tenantId);
 const account=await prisma.tenantUser.findUniqueOrThrow({where:{id:result.ownerUserId},include:{identity:true}});globalIds.add(account.userId);assert.equal(account.identity.email,'new.owner@example.test');assert.equal(account.identity.mobile,'+8801711000005');
 assert.equal(await prisma.subscriptionHistory.count({where:{tenantId:result.tenantId,event:'trial_started'}}),1);
 await assert.rejects(provisionTenant({name:'Duplicate signup',slug:'duplicate-'+randomUUID(),adminName:'Collision',adminMobile:'01711000005',adminEmail:'new-email@example.test',source:'self_signup'}),/already has a FundLedger login/);
});
test('direct subscription edits advance the revision and append history automatically',async()=>{
 const before=await prisma.tenantSubscription.findUniqueOrThrow({where:{tenantId:other.tenant.id}});
 const changed=await prisma.tenantSubscription.update({where:{tenantId:other.tenant.id},data:{quotaResetAt:new Date()}});
 assert.equal(changed.revision,before.revision+1);
 const event=await prisma.subscriptionHistory.findUniqueOrThrow({where:{tenantId_revision:{tenantId:other.tenant.id,revision:changed.revision}}});assert.equal(event.event,'database_updated');assert.equal(event.current.package,'free');
});
test('a legacy JSON package cannot override the relational subscription',async()=>{
 const tenant=await prisma.tenant.update({where:{id:other.tenant.id},data:{contact:{subscription:{package:'business',status:'active',current_period_end_at:'2099-01-01T00:00:00Z'}}},include:{subscription:true}});
 assert.equal(subscriptionContext(tenant).subscription.package,'free');assert.equal((await tenantQuota(other.tenant.id)).package,'free');
 assert.equal(evaluateSubscription(subscriptionContext(tenant)).status,'trial');
});
