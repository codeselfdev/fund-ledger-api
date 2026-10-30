import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
// Explicit opt-in only. This suite must never use the repository's default database.
const testUrl = process.env.SAFETY_TEST_DATABASE_URL;
if (!testUrl || !['127.0.0.1','localhost'].includes(new URL(testUrl).hostname) || !new URL(testUrl).pathname.endsWith('/safety')) throw Error('Use SAFETY_TEST_DATABASE_URL pointing to a disposable localhost /safety database');
const storageRoot=await mkdtemp(path.join(tmpdir(),'fundledger-project-storage-'));process.env.UPLOAD_LOCAL_DIR=storageRoot;
process.env.DATABASE_URL=testUrl;process.env.JWT_SECRET='isolated-safety-tests';process.env.NODE_ENV='production';process.env.UPLOAD_STORAGE='local';
const { prisma }=await import('../dist/core/prisma/client.js');
const { reversalPreview,reverseTransaction,requireReversalAdmin }=await import('../dist/modules/reversals/reversals.service.js');
const { projectDeletionPreview,beginProjectDeletion,runProjectDeletion,deletionJob,retryProjectDeletion,projectDeletionModels }=await import('../dist/modules/projects/project-deletion.service.js');
const { storeObject,projectObjectKeys }=await import('../dist/core/storage/object-storage.service.js');
const { purchase }=await import('../dist/modules/fixed-assets/fixed-assets.service.js');
const { today }=await import('../dist/modules/billing/billing.policy.js');
const { createSessionToken }=await import('../dist/modules/auth/auth.service.js');
const { authenticate }=await import('../dist/core/security/auth.middleware.js');
const { reversalsRouter }=await import('../dist/modules/reversals/reversals.routes.js');
const { projectDeletionRouter }=await import('../dist/modules/projects/project-deletion.routes.js');
const { errorHandler }=await import('../dist/core/http/error-handler.js');
let server,base;
before(async()=>{const app=express();app.use(express.json());app.use('/v1/reversals',authenticate,reversalsRouter);app.use('/v1/project-deletions',projectDeletionRouter);app.use(errorHandler);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise(r=>server.close(r));await prisma.$disconnect();await rm(storageRoot,{recursive:true,force:true});});
async function fixture(projectType='fund_shares',role='admin') {
 const tenant=await prisma.tenant.create({data:{name:'Safety organization',slug:randomUUID()}});
 const identity=await prisma.user.create({data:{name:'Test admin',email:randomUUID()+'@example.test'}});
 const user=await prisma.tenantUser.create({data:{tenantId:tenant.id,userId:identity.id,lastActiveAt:new Date()}});
 const project=await prisma.project.create({data:{tenantId:tenant.id,name:'Safety '+projectType,totalShares:10,projectType}});
 await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:project.id,userId:user.id,role}});
 const account=await prisma.account.create({data:{tenantId:tenant.id,projectId:project.id,name:'Cash',type:'cash',balance:100000}});
 const session=await createSessionToken({tenantId:tenant.id,userId:user.id,activeProjectId:project.id,recordLogin:true});
 return {a:{tenantId:tenant.id,projectId:project.id,userId:user.id,sessionId:session.sessionId},project,account,token:session.token};
}
async function posting(f,kind='income',id,amount=100) {
 return prisma.accountTransaction.create({data:{tenantId:f.a.tenantId,projectId:f.a.projectId,accountId:f.account.id,direction:kind==='expense'?'money_out':'money_in',amount,referenceType:kind,referenceId:id??f.account.id,balanceAfter:100000,createdById:f.a.userId}});
}
async function begin(f) {const p=await projectDeletionPreview(f.a,f.a.projectId);assert.deepEqual(p.blockers,[]);return beginProjectDeletion(f.a,f.a.projectId,{preview_token:p.preview_token,confirmation:p.confirmation,reason:'Project is a duplicate workspace'});}
const reason=()=>({reason:'Correct a duplicated posting',request_key:randomUUID()});
async function api(f,path,body){return fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+f.token,'X-Project-Id':f.a.projectId,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}

test('admin-only reversal rejects accountants, custom-role elevation and impersonation',async()=>{
 for(const auth of [{roles:['accountant']},{roles:['admin'],builtinRoles:[]},{roles:['admin'],menuRouteGranted:true},{roles:['admin'],impersonation:{}}])assert.throws(()=>requireReversalAdmin(auth),/Only/);
 for(const auth of [{roles:['admin']},{roles:['owner'],builtinRoles:['owner']}])requireReversalAdmin(auth);
 const f=await fixture('fund_shares','accountant'),p=await posting(f);
 assert.equal((await api(f,`/v1/reversals/income/${p.id}`,reason())).status,403);
 assert.equal(await prisma.transactionReversal.count({where:{projectId:f.a.projectId}}),0);
});
test('concurrent identical reversal retries post one linked counter-entry and keep history',async()=>{
 const f=await fixture(),p=await posting(f),b=reason();
 const [one,two]=await Promise.all([reverseTransaction(f.a,'income',p.id,b),reverseTransaction(f.a,'income',p.id,b)]);
 assert.deepEqual(one,two);assert.equal((await prisma.account.findUnique({where:{id:f.account.id}})).balance,99900);
 const rows=await prisma.accountTransaction.findMany({where:{projectId:f.a.projectId}});assert.equal(rows.length,2);assert.ok(rows.find(r=>r.id===p.id).reversedAt);assert.equal(rows.find(r=>r.reversalOfId===p.id).direction,'money_out');
 await assert.rejects(reverseTransaction(f.a,'income',p.id,reason()),/already reversed/);
 await assert.rejects(reverseTransaction(f.a,'income',p.id,{...b,reason:'Different reversal request'}),/retry key/);
});
test('scope and available balance are checked before any reversal writes',async()=>{
 const f=await fixture(),foreign=await fixture(),p=await posting(f);
 await assert.rejects(reverseTransaction(foreign.a,'income',p.id,reason()),/not found/);
 await prisma.account.update({where:{id:f.account.id},data:{balance:20}});
 assert.match((await reversalPreview(f.a,'income',p.id)).blockers.join(' '),/insufficient/);
 await assert.rejects(reverseTransaction(f.a,'income',p.id,reason()),/insufficient/);
 assert.equal((await prisma.account.findUnique({where:{id:f.account.id}})).balance,20);
});
test('paid expense reversal restores cash and preserves the expense as reversed',async()=>{
 const f=await fixture(),e=await prisma.expense.create({data:{tenantId:f.a.tenantId,projectId:f.a.projectId,title:'Duplicate stationery',amount:100,category:'services',status:'paid',createdById:f.a.userId,paidAccountId:f.account.id}});await posting(f,'expense',e.id);
 await reverseTransaction(f.a,'expense',e.id,reason());assert.equal((await prisma.account.findUnique({where:{id:f.account.id}})).balance,100100);assert.equal((await prisma.expense.findUnique({where:{id:e.id}})).status,'reversed');
});
async function deposit(f,{legacy=false,advance=false,used=false,refunded=false}={}){
 const scope={tenantId:f.a.tenantId,projectId:f.a.projectId};
 const member=await prisma.member.create({data:{...scope,name:'Member',mobile:'01700000000',shares:1}});
 const schedule=await prisma.schedule.create({data:{...scope,name:'Contribution',totalAmount:100,dueDate:new Date(),createdById:f.a.userId}});
 const due=await prisma.due.create({data:{...scope,memberId:member.id,scheduleId:schedule.id,amount:100,dueDate:new Date(),paidAmount:90,penaltyDue:20,penaltyPaid:10,status:'partial'}});
 const d=await prisma.deposit.create({data:{...scope,memberId:member.id,accountId:f.account.id,amount:100,method:'cash',allocate:advance?'advance':'penalty_first',status:'confirmed',submittedById:f.a.userId,refundedAmount:refunded?10:0}});
 if(!advance||used)await prisma.depositAllocation.create({data:{...scope,depositId:d.id,dueId:due.id,scheduleId:schedule.id,amount:100,...(!legacy?{principalAmount:90,penaltyAmount:10}:{})}});
 await prisma.receipt.create({data:{...scope,depositId:d.id,memberId:member.id,receiptNo:randomUUID(),amount:100,method:'cash'}});await posting(f,'deposit',d.id);return{d,due};
}
test('deposit reversal reopens exact principal and penalties and voids its retained receipt',async()=>{
 const f=await fixture(),{d,due}=await deposit(f);await reverseTransaction(f.a,'deposit',d.id,reason());
 const changed=await prisma.due.findUnique({where:{id:due.id}});assert.equal(changed.paidAmount,0);assert.equal(changed.penaltyPaid,0);assert.equal(changed.status,'due');assert.equal(changed.paidAt,null);
 assert.equal((await prisma.deposit.findUnique({where:{id:d.id}})).status,'reversed');assert.ok((await prisma.receipt.findUnique({where:{depositId:d.id}})).voidedAt);
 assert.equal(await prisma.depositAllocation.count({where:{depositId:d.id}}),1);
});
for(const [label,options,pattern] of [['legacy split',{legacy:true},/exact principal/],['used advance',{advance:true,used:true},/advance has been used/],['refunded deposit',{refunded:true},/refunded/]])test(`${label} blocks unsafe reversal`,async()=>{
 const f=await fixture(),{d}=await deposit(f,options);await assert.rejects(reverseTransaction(f.a,'deposit',d.id,reason()),pattern);assert.equal((await prisma.account.findUnique({where:{id:f.account.id}})).balance,100000);
});
test('bulk asset reversal from any unit reverses the entire invoice and depreciation once',async()=>{
 const f=await fixture(),date=today(),purchaseDate=date.slice(0,4)+'-01-01';
 const body={name:'Test laptop',category:'computers',cost:100,residual:0,life_months:24,purchase_date:purchaseDate,in_use_date:purchaseDate,supplier:'Test',invoice:'I-1',account_id:f.account.id,quantity:2,units:[{location:'Office',assigned_to:'',serial:randomUUID()},{location:'Office',assigned_to:'',serial:randomUUID()}],request_key:randomUUID()};
 const assets=await purchase(f.a,body);
 const p=await reversalPreview(f.a,'fixed_asset',assets[1].id);assert.equal(p.units,2);assert.equal(p.amount,200);assert.deepEqual(p.blockers,[]);
 await reverseTransaction(f.a,'fixed_asset',assets[1].id,reason());assert.equal((await prisma.account.findUnique({where:{id:f.account.id}})).balance,100000);
 assert.equal(await prisma.fixedAsset.count({where:{projectId:f.a.projectId,status:'reversed'}}),2);
 const journals=await prisma.fixedAssetJournal.findMany({where:{projectId:f.a.projectId}});assert.equal(journals.reduce((n,r)=>n+r.amount,0),0);
 for(const j of journals)assert.equal(j.lines.reduce((n,l)=>n+l.debit-l.credit,0),0);
 await assert.rejects(reverseTransaction(f.a,'fixed_asset',assets[0].id,reason()),/active|already/);
 const correction=await purchase(f.a,{...body,request_key:randomUUID()});assert.equal(correction.length,2);assert.equal(correction[0].serial,assets[0].serial);assert.equal(await prisma.fixedAsset.count({where:{projectId:f.a.projectId,status:'reversed'}}),2);
});
test('audit failure rolls back cash, status and reversal receipt atomically',async()=>{
 const f=await fixture(),p=await posting(f);
 await prisma.$executeRawUnsafe(`CREATE FUNCTION safety_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id='${p.id}' AND NEW.action='income.reversed' THEN RAISE EXCEPTION 'Injected audit failure'; END IF; RETURN NEW; END $$`);
 await prisma.$executeRawUnsafe('CREATE TRIGGER safety_reject_audit BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION safety_reject_audit()');
 try{await assert.rejects(reverseTransaction(f.a,'income',p.id,reason()),/Injected audit failure/);assert.equal((await prisma.account.findUnique({where:{id:f.account.id}})).balance,100000);assert.equal(await prisma.accountTransaction.count({where:{projectId:f.a.projectId}}),1);assert.equal(await prisma.transactionReversal.count({where:{projectId:f.a.projectId}}),0);}finally{await prisma.$executeRawUnsafe('DROP TRIGGER safety_reject_audit ON activity');await prisma.$executeRawUnsafe('DROP FUNCTION safety_reject_audit()');}
});
test('deletion requires built-in admin, fresh authentication, exact confirmation and an unchanged preview',async()=>{
 const f=await fixture(),p=await projectDeletionPreview(f.a,f.a.projectId);
 await assert.rejects(beginProjectDeletion(f.a,f.a.projectId,{preview_token:p.preview_token,confirmation:'DELETE other',reason:'Duplicate test project'}),/exact/);
 await prisma.account.create({data:{tenantId:f.a.tenantId,projectId:f.a.projectId,name:'New bank',type:'cash'}});
 await assert.rejects(beginProjectDeletion(f.a,f.a.projectId,{preview_token:p.preview_token,confirmation:p.confirmation,reason:'Duplicate test project'}),/records changed/);
 const fresh=await projectDeletionPreview(f.a,f.a.projectId);
 await prisma.session.update({where:{id:f.a.sessionId},data:{authenticatedAt:new Date(Date.now()-16*60000)}});
 const result=await api(f,`/v1/project-deletions/${f.a.projectId}`,{preview_token:fresh.preview_token,confirmation:fresh.confirmation,reason:'Duplicate test project'});assert.equal(result.status,403);
 const nonadmin=await fixture('fund_shares','accountant');assert.equal((await api(nonadmin,`/v1/project-deletions/${nonadmin.a.projectId}/preview`)).status,403);
});
test('frozen projects reject database inserts, updates, reactivation and moving records away',async()=>{
 const f=await fixture(),other=await prisma.project.create({data:{tenantId:f.a.tenantId,name:'Keep',totalShares:0}});await begin(f);
 await assert.rejects(prisma.account.create({data:{tenantId:f.a.tenantId,projectId:f.a.projectId,name:'Late',type:'cash'}}),/locked for deletion/);
 await assert.rejects(prisma.account.update({where:{id:f.account.id},data:{balance:42}}),/locked for deletion/);
 await assert.rejects(prisma.account.update({where:{id:f.account.id},data:{projectId:other.id}}),/locked for deletion/);
 await assert.rejects(prisma.project.update({where:{id:f.a.projectId},data:{isActive:true}}),/locked for deletion/);
});
test('storage failure retains all DB metadata, then a safe retry completes and clears the manifest',async()=>{
 const f=await fixture(),key=`${f.a.tenantId}/${f.a.projectId}/expense_doc/proof.pdf`;
 await prisma.upload.create({data:{tenantId:f.a.tenantId,projectId:f.a.projectId,userId:f.a.userId,fileName:'proof.pdf',mimeType:'application/pdf',size:10,storageKey:key}});
 const job=await begin(f);await runProjectDeletion(job.id,{purgeObject:async()=>{throw Error('Provider offline');},projectObjectKeys:async()=>[]});
 assert.equal((await deletionJob(f.a,job.id)).status,'failed');assert.ok(await prisma.project.findUnique({where:{id:f.a.projectId}}));assert.equal(await prisma.upload.count({where:{projectId:f.a.projectId}}),1);
 await retryProjectDeletion(f.a,job.id);const removed=[];const deps={purgeObject:async k=>removed.push(k),projectObjectKeys:async()=>[]};await runProjectDeletion(job.id,deps);await runProjectDeletion(job.id,deps);
 assert.equal((await deletionJob(f.a,job.id)).status,'completed');assert.deepEqual(removed,[key]);assert.equal(await prisma.project.findUnique({where:{id:f.a.projectId}}),null);assert.deepEqual((await prisma.projectDeletionJob.findUnique({where:{id:job.id}})).manifest,[]);
 assert.equal((await projectDeletionPreview(f.a,f.a.projectId)).job.status,'completed');
});
for(const type of ['fund_shares','accounting','billing','construction','payroll_pf','institute'])test(`${type} deletion scopes files and data to one project`,async()=>{
 const f=await fixture(type),other=await prisma.project.create({data:{tenantId:f.a.tenantId,name:'Keep project',totalShares:0,projectType:type}});
 await prisma.onboardingProgress.create({data:{tenantId:f.a.tenantId,projectId:f.a.projectId,incomeApprovalFlow:'accountant_and_approver',expenseApprovalFlow:'accountant_only'}});
 const scope={tenantId:f.a.tenantId,projectId:f.a.projectId},key=`${scope.tenantId}/${scope.projectId}/member_document/file`,legacy=`${scope.tenantId}/assistant/${randomUUID()}`;
 await prisma.upload.create({data:{...scope,userId:f.a.userId,fileName:'proof',mimeType:'image/png',size:10,storageKey:key}});
 const reply=await prisma.assistantReply.create({data:{...scope,userId:f.a.userId,channel:'app',requestKey:randomUUID(),promptHash:'hash',prompt:'test',periodStart:new Date()}});
 await prisma.assistantAttachment.create({data:{tenantId:scope.tenantId,replyId:reply.id,fileName:'old image',mimeType:'image/png',size:10,contentHash:'hash',storageKey:legacy}});
 const job=await begin(f),removed=[];let orphan=true;const deps={purgeObject:async k=>{removed.push(k);if(k.endsWith('/orphan'))orphan=false;},projectObjectKeys:async(t,p)=>{assert.equal(t,scope.tenantId);assert.equal(p,scope.projectId);return orphan?[`${t}/${p}/reports/orphan`]:[];}};
 for(let i=0;i<4;i++)await runProjectDeletion(job.id,deps);
 assert.equal((await deletionJob(f.a,job.id)).status,'completed');assert.deepEqual(new Set(removed),new Set([key,legacy,`${scope.tenantId}/${scope.projectId}/reports/orphan`]));
 for(const model of projectDeletionModels())assert.equal(await prisma[model.name[0].toLowerCase()+model.name.slice(1)].count({where:scope}),0,model.name);
 assert.ok(await prisma.project.findUnique({where:{id:other.id}}));assert.ok(await prisma.tenantUser.findUnique({where:{id:f.a.userId}}));assert.ok(await prisma.user.findFirst({where:{tenantMemberships:{some:{id:f.a.userId}}}}));
 const onboarding=await prisma.onboardingProgress.findUnique({where:{tenantId:scope.tenantId}});assert.equal(onboarding.projectId,other.id);assert.equal(onboarding.incomeApprovalFlow,'accountant_and_approver');
});
test('deletion order covers all project tables, child relations precede parents',()=>{
 const order=projectDeletionModels().map(m=>m.name);assert.ok(order.includes('TransactionReversal'));assert.ok(!order.includes('ProjectDeletionJob'));assert.ok(order.indexOf('FixedAssetJournal')<order.indexOf('FixedAsset'));assert.ok(order.indexOf('AccountTransaction')<order.indexOf('Account'));
});

test('real local storage cleanup drains nested orphan files and preserves another project',async()=>{
 const f=await fixture(),other=await prisma.project.create({data:{tenantId:f.a.tenantId,name:'Keep files',totalShares:0}});
 const gone=`${f.a.tenantId}/${f.a.projectId}/reports/nested/orphan.pdf`,kept=`${f.a.tenantId}/${other.id}/member_document/keep.pdf`;
 await storeObject({storageKey:gone,buffer:Buffer.from('delete me')});await storeObject({storageKey:kept,buffer:Buffer.from('keep me')});
 const job=await begin(f);await assert.rejects(storeObject({storageKey:gone,buffer:Buffer.from('late write')}),/locked for deletion/);
 await runProjectDeletion(job.id);await runProjectDeletion(job.id);
 assert.equal((await deletionJob(f.a,job.id)).status,'completed');assert.deepEqual(await projectObjectKeys(f.a.tenantId,f.a.projectId),[]);assert.equal((await readFile(path.join(storageRoot,kept))).toString(),'keep me');
 await assert.rejects(storeObject({storageKey:gone,buffer:Buffer.from('resurrect')}),/unavailable/);
});
test('cross-project foreign references block deletion before any file is removed',async()=>{
 const f=await fixture(),other=await prisma.project.create({data:{tenantId:f.a.tenantId,name:'Other project',totalShares:0}});
 await prisma.accountTransaction.create({data:{tenantId:f.a.tenantId,projectId:other.id,accountId:f.account.id,direction:'money_in',amount:1,balanceAfter:1}});
 assert.match((await projectDeletionPreview(f.a,f.a.projectId)).blockers.join(' '),/Another project/);
 assert.equal((await prisma.project.findUnique({where:{id:f.a.projectId}})).isActive,true);
});
