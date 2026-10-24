import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
const database=process.env.PAYROLL_TEST_DATABASE_URL;
test('Payroll & PF authenticated workflows and atomic ledger postings', {skip:!database}, async t=>{
 const target=new URL(database);assert.ok(['127.0.0.1','localhost'].includes(target.hostname));assert.equal(target.pathname,'/payroll_test');
 process.env.DATABASE_URL=database;process.env.JWT_SECRET='disposable-payroll-only-secret';process.env.NODE_ENV='production';process.env.UPLOAD_STORAGE='local';process.env.UPLOAD_LOCAL_DIR=`/private/tmp/payroll-files-${randomUUID()}`;
 const {prisma}=await import('../dist/core/prisma/client.js');
 const {payrollRouter}=await import('../dist/modules/payroll/payroll.routes.js');
 const {uploadsRouter}=await import('../dist/modules/uploads/uploads.routes.js');
 const {projectsRouter}=await import('../dist/modules/projects/projects.routes.js');
 const {authenticate}=await import('../dist/core/security/auth.middleware.js');
 const {payrollFinancialPrivacy}=await import('../dist/core/security/payroll-privacy.js');
 const {createSessionToken}=await import('../dist/modules/auth/auth.service.js');
 const {errorHandler}=await import('../dist/core/http/error-handler.js');
 const {storeObject}=await import('../dist/core/storage/object-storage.service.js');
 const {today,workingDates}=await import('../dist/modules/payroll/payroll.policy.js');
 const {default:express}=await import('express');
 const date=today(),month=date.slice(0,7),nextDate=new Date(`${month}-01T00:00:00Z`);nextDate.setUTCMonth(nextDate.getUTCMonth()+1);const next=nextDate.toISOString().slice(0,10);
 const tenant=await prisma.tenant.create({data:{name:'Disposable Payroll Test',slug:randomUUID(),contact:{subscription:{package:'custom',current_period_end_at:new Date(Date.now()+365*86400000).toISOString()}}}});
 const project=await prisma.project.create({data:{tenantId:tenant.id,name:'Payroll test',projectType:'payroll_pf',totalShares:1}});
 const other=await prisma.project.create({data:{tenantId:tenant.id,name:'Other payroll',projectType:'payroll_pf',totalShares:1}});
 const fund=await prisma.project.create({data:{tenantId:tenant.id,name:'Fund type',projectType:'fund_shares',totalShares:1}});
 const actors={};
 for(const [name,mobile,roles] of [['owner','01711000001',['owner']],['checker','01711000002',['accountant','approver']],['approver','01711000003',['approver']],['sadia','01711482930',['member']],['jahid','01633118842',['member']],['cashier','01711000004',['cashier']],['auditor','01711000005',['auditor']]]){
  const user=await prisma.user.create({data:{tenantId:tenant.id,name,mobile}});
  for(const role of roles)await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:project.id,userId:user.id,role}});
  if(name==='owner')for(const p of [other,fund])await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:p.id,userId:user.id,role:'owner'}});
  const {token}=await createSessionToken({tenantId:tenant.id,userId:user.id,activeProjectId:project.id});actors[name]={...user,token};
 }
 const bank=await prisma.account.create({data:{tenantId:tenant.id,projectId:project.id,name:'Payroll bank',type:'bank',balance:2000000}});
 const cash=await prisma.account.create({data:{tenantId:tenant.id,projectId:project.id,name:'Cash',type:'cash',balance:500}});
 const foreign=await prisma.account.create({data:{tenantId:tenant.id,projectId:other.id,name:'Other bank',type:'bank',balance:2000000}});
 const app=express();app.use(express.json());app.use('/v1/projects',projectsRouter);app.use(authenticate);app.use(payrollFinancialPrivacy);for(const path of ['/v1/ledger','/v1/activity','/v1/accounts','/v1/expenses'])app.get(path,(_req,res)=>res.json({ok:true,data:[]}));app.use('/v1/payroll',payrollRouter);app.use('/v1/uploads',uploadsRouter);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(path,body,who='owner',projectId=project.id,method=body?'POST':'GET')=>{
  const r=await fetch(base+path,{method,headers:{'content-type':'application/json',authorization:`Bearer ${actors[who].token}`,'x-project-id':projectId},...(body?{body:JSON.stringify(body)}:{})});
  const content=r.headers.get('content-type')??'';const parsed=content.includes('json')?await r.json():await r.text();return{status:r.status,data:parsed?.data,error:parsed?.error,body:parsed};
 };
 const call=async(...args)=>{const result=await req(...args);assert.ok(result.status<300,JSON.stringify(result));return result.data;};
 const workspace=(who='owner')=>call(`/v1/payroll/workspace?month=${month}`,undefined,who);
 const key=()=>randomUUID();
 const upload=async(who,purpose='payroll_receipt')=>{
  const storageKey=`${tenant.id}/${project.id}/${randomUUID()}.pdf`;await storeObject({storageKey,buffer:Buffer.from('%PDF-1.4\n payroll test receipt'),contentType:'application/pdf'});
  return prisma.upload.create({data:{tenantId:tenant.id,projectId:project.id,userId:actors[who].id,fileName:'receipt.pdf',mimeType:'application/pdf',size:29,storageKey,purpose}});
 };
 const row=(name,mobile,basic,joiningDate='2021-01-01')=>({name,mobile,basic:String(basic),designation:'Officer',department:'Finance',medical:'3000',transport:'2500',joiningDate,pfMember:true});
 let sadia,jahid,unpaid,reserved,standalone,paidRun,paidPosting;
 const reviewBill=async(id)=>{
  let bill=(await workspace()).bills.find(b=>b.id===id);
  await call(`/v1/payroll/bills/${id}/check`,{revision:bill.revision,request_key:key()},'checker');
  bill=(await workspace()).bills.find(b=>b.id===id);
  assert.equal((await req(`/v1/payroll/bills/${id}/approve`,{revision:bill.revision,request_key:key()},'checker')).status,403);
  await call(`/v1/payroll/bills/${id}/approve`,{revision:bill.revision,request_key:key()},'approver');
  return (await workspace()).bills.find(b=>b.id===id);
 };
 const createBill=async(amount,who='sadia')=>{const file=await upload(who);return call('/v1/payroll/bills',{employee_id:who==='sadia'?sadia.id:jahid.id,category:'Food',amount,date,note:'Receipt review',receipt_file_id:file.id,request_key:key()},who);};
 try{
  await t.test('project type is accepted by project creation and rejected by other project workspaces',async()=>{
   const created=await call('/v1/projects',{name:'New payroll onboarding type',project_type:'payroll_pf',total_shares:1,owner_is_member:false});assert.equal(created.project_type,'payroll_pf');
   assert.equal(await prisma.member.count({where:{projectId:created.project_id}}),0);
   assert.equal((await req(`/v1/payroll/workspace?month=${month}`,undefined,'owner',fund.id)).status,403);
  });
  await t.test('imports validate atomically, update by normalized mobile and preserve joining dates',async()=>{
   await call('/v1/payroll/employees/import',{rows:[row('Sadia','01711482930',32000),row('Jahid','01633118842',14000)],match_by:'mobile',request_key:key()});
   const six=[row('Tanvir','01712334455',22000,next),row('Farhana','01819776611',18000,next),row('Mahbub','0191122',15000,next),row('Rumana','01715908877','',next),row('Imran','01633445566',14000,next),row('Sadia','+8801711482930',36000,next)];
   assert.equal((await req('/v1/payroll/employees/import',{rows:six,match_by:'mobile',request_key:key()})).status,400);assert.equal(await prisma.payrollEmployee.count({where:{projectId:project.id}}),2);
   six[2].mobile='01911223344';six[3].basic='28000';
   const body={rows:six,match_by:'mobile',request_key:key()};const results=await Promise.all([call('/v1/payroll/employees/import',body),call('/v1/payroll/employees/import',body)]);assert.deepEqual(results,[{added:5,updated:1},{added:5,updated:1}]);
   const w=await workspace();sadia=w.employees.find(e=>e.mobile==='01711482930');jahid=w.employees.find(e=>e.mobile==='01633118842');assert.equal(sadia.joiningDate,'2021-01-01');assert.equal(sadia.basic,36000);assert.equal(w.employees.length,7);
   assert.equal((await req('/v1/payroll/employees/import',{rows:[row('x','01711000009',1)],match_by:'mobile',request_key:key()},'auditor')).status,403);
   assert.equal((await req(`/v1/payroll/employees/${sadia.id}/status`,{status:'active',probation_completed_on:date,revision:sadia.revision,request_key:key()},'sadia',project.id,'PATCH')).status,403);
   const active=await call(`/v1/payroll/employees/${sadia.id}/status`,{status:'active',probation_completed_on:date,revision:sadia.revision,request_key:key()},'owner',project.id,'PATCH');assert.equal(active.status,'active');
   const saved=await call('/v1/payroll/settings',{...w.settings,eligibility:'joining'},'owner',project.id,'PUT');assert.equal(saved.revision,1);
   assert.equal((await req('/v1/payroll/settings',w.settings,'owner',project.id,'PUT')).status,409);
  });
  await t.test('member snapshots and attachment access exclude other employee records',async()=>{
   const w=await workspace('sadia');assert.equal(w.employees.length,1);assert.equal(w.me.id,sadia.id);assert.equal(w.employees[0].name,'Sadia');
   for(const path of ['/v1/ledger','/v1/activity','/v1/accounts','/v1/expenses']) {assert.equal((await req(path,undefined,'sadia')).status,403);assert.equal((await req(path)).status,200);}
   const file=await upload('sadia','payroll_leave_note');assert.equal((await req(`/v1/uploads/${file.id}/view`,undefined,'jahid')).status,403);assert.equal((await req(`/v1/uploads/${file.id}/view`,undefined,'sadia')).status,200);
   assert.equal((await req(`/v1/payroll/workspace?month=${month}`,undefined,'sadia',other.id)).status,403);
  });
  await t.test('leave self-service enforces ownership, allowance, overlap and real doctor notes',async()=>{
   const body={employee_id:jahid.id,type:'Unpaid',start_date:date,days:1,reason:'Bike repair',request_key:key()};
   assert.equal((await req('/v1/payroll/leave',{...body,employee_id:sadia.id},'jahid')).status,403);
   unpaid=await call('/v1/payroll/leave',body,'jahid');
   assert.equal((await req('/v1/payroll/leave',{...body,request_key:key()},'jahid')).status,409);
   const start=new Date(`${date}T00:00:00Z`);start.setUTCDate(start.getUTCDate()+7);const future=start.toISOString().slice(0,10);
   const sick={employee_id:sadia.id,type:'Sick',start_date:future,days:3,reason:'Doctor advised rest',request_key:key()};
   assert.equal((await req('/v1/payroll/leave',sick,'sadia')).status,400);
   const wrong=await upload('sadia');assert.equal((await req('/v1/payroll/leave',{...sick,note_file_id:wrong.id},'sadia')).status,400);
   const note=await upload('sadia','payroll_leave_note');await call('/v1/payroll/leave',{...sick,note_file_id:note.id},'sadia');
   assert.equal((await req('/v1/payroll/leave',{employee_id:sadia.id,type:'Annual',start_date:date,days:21,reason:'Long leave',request_key:key()},'sadia')).status,409);
  });
  await t.test('bill checking, separate account payment, retries and insufficient balance',async()=>{
   const file=await upload('sadia'),body={employee_id:sadia.id,category:'Medical',amount:1200,date,note:'Medicine',receipt_file_id:file.id,request_key:key()};
   const submitted=await Promise.all([call('/v1/payroll/bills',body,'sadia'),call('/v1/payroll/bills',body,'sadia')]);assert.equal(submitted[0].id,submitted[1].id);standalone=submitted[0];
   assert.equal((await req('/v1/payroll/bills',{...body,request_key:key()},'sadia')).status,409);
   let bill=await reviewBill(standalone.id);
   assert.equal((await req(`/v1/payroll/bills/${bill.id}/disburse`,{account_id:foreign.id,revision:bill.revision,request_key:key()})).status,404);
   assert.equal((await req(`/v1/payroll/bills/${bill.id}/disburse`,{account_id:cash.id,revision:bill.revision,request_key:key()})).status,409);
   await prisma.account.update({where:{id:cash.id},data:{balance:10000}});
   const pay={account_id:cash.id,revision:bill.revision,request_key:key()};const results=await Promise.all([call(`/v1/payroll/bills/${bill.id}/disburse`,pay),call(`/v1/payroll/bills/${bill.id}/disburse`,pay)]);assert.equal(results[0].id,results[1].id);assert.equal(results[0].accountId,cash.id);assert.equal(results[0].amount,1200);assert.equal(results[0].ledgerTransactionIds.length,1);
   assert.equal((await req(`/v1/payroll/bills/${bill.id}/disburse`,{...pay,account_id:bank.id})).status,409);
   assert.equal((await req(`/v1/payroll/bills/${bill.id}/disburse`,pay,'cashier')).status,409);
   assert.equal((await prisma.account.findUnique({where:{id:cash.id}})).balance,8800);assert.equal(await prisma.accountTransaction.count({where:{projectId:project.id,referenceId:bill.id}}),1);
   assert.equal((await req(`/v1/payroll/bills/${bill.id}/disburse`,{...pay,account_id:bank.id,request_key:key()})).status,409);
  });
  await t.test('future hires are excluded and unpaid leave/bill approval invalidate reviewed salary totals',async()=>{
   const prepared=await call('/v1/payroll/runs',{month,request_key:key()});assert.equal(prepared.rows.length,2);assert.ok(prepared.rows.every(r=>[sadia.id,jahid.id].includes(r.employeeId)));assert.ok(prepared.rows.every(r=>r.billIds.length===0));
   assert.equal((await req(`/v1/payroll/runs/${prepared.id}/approve`,{revision:prepared.revision,request_key:key()})).status,409);
   assert.equal((await req(`/v1/payroll/runs/${prepared.id}/check`,{revision:prepared.revision,request_key:key()})).status,403);
   await call(`/v1/payroll/runs/${prepared.id}/check`,{revision:prepared.revision,request_key:key()},'checker');
   let current=(await workspace()).run;await call(`/v1/payroll/runs/${prepared.id}/approve`,{revision:current.revision,request_key:key()},'approver');
   const approved=(await workspace()).run;
   await call(`/v1/payroll/leave/${unpaid.id}/decision`,{decision:'approve',reason:'',request_key:key()},'approver');
   current=(await workspace()).run;assert.equal(current.status,'prepared');assert.ok(current.revision>approved.revision);
   const jr=current.rows.find(r=>r.employeeId===jahid.id);assert.equal(jr.unpaidDays,1);assert.equal(jr.unpaidDeduction,Math.round(jr.gross/30));
   assert.equal((await req(`/v1/payroll/runs/${current.id}/disburse`,{account_id:bank.id,revision:approved.revision,request_key:key()})).status,409);
   reserved=await createBill(650);await reviewBill(reserved.id);let w=await workspace();const bill=w.bills.find(b=>b.id===reserved.id);assert.equal(bill.reservedRunId,current.id);assert.ok(w.run.rows.find(r=>r.employeeId===sadia.id).billIds.includes(bill.id));
   assert.equal((await req(`/v1/payroll/bills/${bill.id}/disburse`,{account_id:bank.id,revision:bill.revision,request_key:key()})).status,409);
   await call(`/v1/payroll/runs/${current.id}/check`,{revision:w.run.revision,request_key:key()},'checker');w=await workspace();assert.equal((await req(`/v1/payroll/runs/${current.id}/approve`,{revision:w.run.revision,request_key:key()},'checker')).status,403);
   await call(`/v1/payroll/runs/${current.id}/approve`,{revision:w.run.revision,request_key:key()},'approver');
  });
  await t.test('a PF insert failure after the cash/ledger writes rolls back the entire salary payment',async()=>{
   const run=(await workspace()).run,request=key(),balance=(await prisma.account.findUnique({where:{id:bank.id}})).balance,expenses=await prisma.expense.count({where:{projectId:project.id}});
   const duplicate=await prisma.payrollPFEntry.create({data:{tenantId:tenant.id,projectId:project.id,employeeId:sadia.id,runId:run.id,own:1,company:1}});
   try {
    assert.equal((await req(`/v1/payroll/runs/${run.id}/disburse`,{account_id:bank.id,revision:run.revision,request_key:request},'cashier')).status,409);
    assert.equal((await prisma.account.findUnique({where:{id:bank.id}})).balance,balance);assert.equal(await prisma.expense.count({where:{projectId:project.id}}),expenses);assert.equal(await prisma.accountTransaction.count({where:{projectId:project.id,referenceId:run.id}}),0);assert.equal((await workspace()).run.status,'approved');assert.equal(await prisma.payrollOperation.count({where:{projectId:project.id,requestKey:request}}),0);
   }finally{await prisma.payrollPFEntry.delete({where:{id:duplicate.id}});}
  });
  await t.test('simultaneous salary disbursements post one movement and settle included bills/PF once',async()=>{
   const run=(await workspace()).run,amount=run.rows.reduce((s,r)=>s+r.net,0),before=(await prisma.account.findUnique({where:{id:bank.id}})).balance;
   const body={account_id:bank.id,revision:run.revision,request_key:key()};const results=await Promise.all([call(`/v1/payroll/runs/${run.id}/disburse`,body,'cashier'),call(`/v1/payroll/runs/${run.id}/disburse`,body,'cashier')]);assert.equal(results[0].id,results[1].id);paidPosting=results[0];assert.equal(paidPosting.amount,amount);
   assert.equal((await prisma.account.findUnique({where:{id:bank.id}})).balance,before-amount);assert.equal(await prisma.accountTransaction.count({where:{projectId:project.id,referenceId:run.id}}),1);
   assert.equal(await prisma.payrollPFEntry.count({where:{runId:run.id}}),2);assert.equal((await prisma.payrollPFEntry.aggregate({where:{runId:run.id},_sum:{own:true}}))._sum.own,run.rows.reduce((s,r)=>s+r.pf,0));
   const w=await workspace();paidRun=w.run;assert.equal(w.run.status,'paid');assert.equal(w.bills.find(b=>b.id===reserved.id).status,'paid');assert.equal(w.bills.find(b=>b.id===reserved.id).posting.id,paidPosting.id);
   assert.equal((await req(`/v1/payroll/runs/${run.id}/disburse`,{...body,account_id:cash.id,request_key:key()})).status,409);
   const member=await workspace('sadia');assert.equal(member.run.rows.length,1);assert.equal(member.run.rows[0].employeeId,sadia.id);assert.equal(member.run.posting,undefined);
  });
  await t.test('paid figures remain immutable after imports/settings and late unpaid leave cannot rewrite them',async()=>{
   const current=await workspace();await call('/v1/payroll/settings',{...current.settings,rate:5},'owner',project.id,'PUT');
   await call('/v1/payroll/employees/import',{rows:[row('Sadia','01711482930',60000,next)],match_by:'mobile',request_key:key()});assert.deepEqual((await workspace()).run,paidRun);
   const body={employee_id:sadia.id,type:'Unpaid',start_date:date,days:1,reason:'Late unpaid correction',request_key:key()};const l=await call('/v1/payroll/leave',body,'sadia');assert.equal((await req(`/v1/payroll/leave/${l.id}/decision`,{decision:'approve',request_key:key()},'approver')).status,409);
  });
  await t.test('competing bills cannot overdraw a shared source account',async()=>{
   const race=await prisma.account.create({data:{tenantId:tenant.id,projectId:project.id,name:'Race account',type:'cash',balance:1500}});
   const b1=await createBill(1000),b2=await createBill(1000);const first=await reviewBill(b1.id),second=await reviewBill(b2.id);
   const results=await Promise.all([req(`/v1/payroll/bills/${first.id}/disburse`,{account_id:race.id,revision:first.revision,request_key:key()}),req(`/v1/payroll/bills/${second.id}/disburse`,{account_id:race.id,revision:second.revision,request_key:key()})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await prisma.account.findUnique({where:{id:race.id}})).balance,500);
  });
  await t.test('a ledger insert failure rolls back the balance, expense, status and operation receipt',async()=>{
   const bill=await reviewBill((await createBill(1000)).id),request=key();
   await prisma.accountTransaction.create({data:{tenantId:tenant.id,projectId:project.id,accountId:bank.id,direction:'money_in',amount:1,balanceAfter:1,requestKey:`payroll:${request}`}});
   const before=(await prisma.account.findUnique({where:{id:bank.id}})).balance,count=await prisma.expense.count({where:{projectId:project.id}});
   assert.equal((await req(`/v1/payroll/bills/${bill.id}/disburse`,{account_id:bank.id,revision:bill.revision,request_key:request})).status,409);
   assert.equal((await prisma.account.findUnique({where:{id:bank.id}})).balance,before);assert.equal(await prisma.expense.count({where:{projectId:project.id}}),count);assert.equal((await prisma.payrollBill.findUnique({where:{id:bill.id}})).status,'approved');assert.equal(await prisma.payrollOperation.count({where:{projectId:project.id,requestKey:request}}),0);
  });
 }finally{
  await new Promise(r=>server.close(r));
  await prisma.tenant.delete({where:{id:tenant.id}});await prisma.$disconnect();await rm(process.env.UPLOAD_LOCAL_DIR,{recursive:true,force:true});
 }
});
