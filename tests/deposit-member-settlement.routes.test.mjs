import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import express from 'express';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'member-settlement-isolated-test-secret';
process.env.WHATSAPP_ENABLED = 'false';
const { prisma } = await import('../dist/core/prisma/client.js');
const { depositsRouter } = await import('../dist/modules/deposits/deposits.routes.js');
const { calculateDueBalance } = await import('../dist/modules/members/member-settlement.service.js');
let server, base, dues, deposits, allocations, receipts, transactions, account, queries, activities;
let transactionQueue = Promise.resolve();
const copy = value => structuredClone(value);
function matches(row, where) {
 return Object.entries(where).every(([key,value])=>{
  if(value===undefined)return true;
  if(value&&typeof value==='object'&&!(value instanceof Date)) {
   if('in' in value)return value.in.includes(row[key]);
   if('notIn' in value)return !value.notIn.includes(row[key]);
  }
  return row[key]===value;
 });
}
function due(id,scheduleId,amount,extra={}) {return {id,scheduleId,amount,schedule:{name:scheduleId},tenantId:'tenant',projectId:'project',memberId:'member',paidAmount:0,waivedAmount:0,penaltyDue:0,penaltyPaid:0,status:'due',paidAt:null,dueDate:new Date('2026-01-01'),...extra};}
function reset() {
 dues=[due('arrears','imported-schedule',20000),due('new','new-schedule',2000,{dueDate:new Date('2026-10-15')}),due('foreign','foreign-schedule',99999,{tenantId:'other'}),due('other-project','other-project-schedule',99999,{projectId:'other'}),due('other-member','other-member-schedule',99999,{memberId:'other'})];
 deposits=[];allocations=[];receipts=[];transactions=[];queries=[];activities=[];account={id:'account',tenantId:'tenant',projectId:'project',balance:0};
}
before(async()=>{
 prisma.$transaction=async fn=>{
  const previous=transactionQueue;let release;transactionQueue=new Promise(resolve=>{release=resolve;});await previous;
  const snapshot=copy({dues,deposits,allocations,receipts,transactions,account,activities});
  try{return await fn(prisma);}catch(e){({dues,deposits,allocations,receipts,transactions,account,activities}=snapshot);throw e;}finally{release();}
 };
 prisma.$queryRaw=async()=>[];
 prisma.project.findFirstOrThrow=async()=>({portalSettings:{deposit_review:'admin_only',member_shortcuts:[],accountant_shortcuts:[]}});
 prisma.projectMembership.findFirst=async()=>null;
 prisma.projectMembership.findMany=async()=>[];
 prisma.member.findFirst=async({where})=>where.id==='member'?{id:'member',name:'Imported member',status:'active',email:null}:null;
 prisma.member.findUnique=async()=>({email:null});
 prisma.tenant.findUnique=async()=>null;
 prisma.account.findFirst=async({where})=>matches(account,where)?copy(account):null;
 prisma.account.findFirstOrThrow=async({where})=>{assert.ok(matches(account,where));return copy(account);};
 prisma.account.update=async({data})=>{account.balance+=data.balance.increment;return copy(account);};
 prisma.due.findMany=async({where})=>{queries.push(copy(where));return copy(dues.filter(d=>matches(d,where)));};
 prisma.due.update=async({where,data})=>{const row=dues.find(d=>d.id===where.id);Object.assign(row,data);return copy(row);};
 prisma.deposit.create=async({data})=>{const row={id:`deposit-${deposits.length}`,createdAt:new Date(),...data};deposits.push(row);return copy(row);};
 prisma.deposit.findFirst=async({where})=>copy(deposits.find(d=>matches(d,where))??null);
 prisma.deposit.findUniqueOrThrow=async({where})=>copy(deposits.find(d=>d.id===where.id));
 prisma.deposit.updateMany=async({where,data})=>{const rows=deposits.filter(d=>matches(d,where));rows.forEach(d=>Object.assign(d,data));return{count:rows.length};};
 prisma.deposit.deleteMany=async({where})=>{const removed=deposits.filter(d=>matches(d,where));deposits=deposits.filter(d=>!matches(d,where));allocations=allocations.filter(a=>!removed.some(d=>d.id===a.depositId));return{count:removed.length};};
 prisma.depositAllocation.createMany=async({data})=>{allocations.push(...data.map(d=>({tenantId:'tenant',projectId:'project',...d,amount:0})));return{count:data.length};};
 prisma.depositAllocation.findMany=async({where})=>allocations.filter(a=>a.depositId===where.depositId).map(a=>({...a,due:copy(dues.find(d=>d.id===a.dueId))}));
 prisma.depositAllocation.updateMany=async({where,data})=>{const rows=allocations.filter(a=>matches(a,where));rows.forEach(a=>Object.assign(a,data));return{count:rows.length};};
 prisma.depositAllocation.deleteMany=async({where})=>{const removed=allocations.filter(a=>matches(a,where));allocations=allocations.filter(a=>!matches(a,where));return{count:removed.length};};
 prisma.receipt.create=async({data})=>{const row={id:`receipt-${receipts.length}`,...data};receipts.push(row);return copy(row);};
 prisma.accountTransaction.create=async({data})=>{const row={id:`transaction-${transactions.length}`,...data};transactions.push(row);return copy(row);};
 prisma.paymentCommitment.findFirst=async()=>null;
 prisma.whatsAppConnection.findFirst=async()=>null;
 prisma.activity.create=async({data})=>{activities.push(copy(data));return data;};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.auth={tenantId:'tenant',projectId:'project',userId:'actor',roles:[req.header('x-role')??'admin'],memberId:'member'};next();});
 app.use('/deposits',depositsRouter);app.use((e,_req,res,_next)=>res.status(e.statusCode??500).json({error:e.message,fields:e.fields}));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(reset);
after(async()=>{await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
const payment={settle_all_dues:true,member_id:'member',account_id:'account',amount:22000,method:'cash'};
async function request(path,body,role='admin') {const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-role':role},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};}
const outstanding=()=>dues.filter(d=>d.tenantId==='tenant'&&d.projectId==='project'&&d.memberId==='member').reduce((n,d)=>n+calculateDueBalance(d).total,0);
test('admin settles displayed 22,000 across imported arrears and a new schedule',async()=>{
 assert.equal(outstanding(),22000);
 const submitted=await request('/deposits',payment);assert.equal(submitted.status,201,JSON.stringify(submitted.body));
 assert.deepEqual(allocations.map(a=>a.dueId),['arrears','new']);assert.equal(account.balance,0);
 assert.equal((await request(`/deposits/${submitted.body.data.id}/confirm`,{})).status,200);
 assert.equal(outstanding(),0);assert.equal(dues[0].paidAmount,20000);assert.equal(dues[1].paidAmount,2000);
 assert.deepEqual(allocations.map(a=>a.amount),[20000,2000]);assert.equal(account.balance,22000);assert.equal(receipts.length,1);assert.equal(transactions.length,1);
 assert.ok(queries.every(q=>q.tenantId==='tenant'&&q.projectId==='project'&&q.memberId==='member'));
});
test('imported-only balances remain payable when there are no ordinary schedules',async()=>{
 dues=dues.filter(d=>d.id!=='new');const result=await request('/deposits',{...payment,amount:20000});assert.equal(result.status,201);assert.deepEqual(allocations.map(a=>a.dueId),['arrears']);
});
test('member-level partial payment applies oldest dues first',async()=>{
 const result=await request('/deposits',{...payment,amount:21000});assert.equal(result.status,201);
 await request(`/deposits/${result.body.data.id}/confirm`,{});
 assert.equal(outstanding(),1000);assert.equal(dues[0].status,'paid');assert.equal(dues[1].status,'partial');assert.deepEqual(allocations.map(a=>a.amount),[20000,1000]);
});
test('waivers and paid penalties use the same outstanding calculation for acceptance and posting',async()=>{
 Object.assign(dues[0],{paidAmount:5000,waivedAmount:1000,penaltyDue:300,penaltyPaid:100});const amount=outstanding();assert.equal(amount,16200);
 const result=await request('/deposits',{...payment,amount});assert.equal(result.status,201);
 assert.equal((await request(`/deposits/${result.body.data.id}/confirm`,{})).status,200);assert.equal(outstanding(),0);assert.equal(dues[0].penaltyPaid,300);assert.equal(account.balance,amount);
});
test('overpayment is still rejected and creates no deposit',async()=>{
 const result=await request('/deposits',{...payment,amount:22001});assert.equal(result.status,400);assert.equal(result.body.fields.outstanding,22000);assert.equal(deposits.length,0);
});
test('explicit schedule selections do not expand into imported or unselected dues',async()=>{
 const {settle_all_dues,...selected}=payment;
 assert.equal((await request('/deposits',{...selected,schedule_ids:['new-schedule']})).status,400);assert.equal(deposits.length,0);
 const valid=await request('/deposits',{...selected,schedule_ids:['new-schedule'],amount:2000});assert.equal(valid.status,201);assert.deepEqual(allocations.map(a=>a.dueId),['new']);
});
test('ambiguous or empty scope is rejected rather than settling every member due accidentally',async()=>{
 const {settle_all_dues,...empty}=payment;
 for(const body of [empty,{...empty,schedule_ids:[]},{...payment,schedule_ids:['new-schedule']}])assert.equal((await request('/deposits',body)).status,400);
 assert.equal(deposits.length,0);
});
test('owner can submit, while auditor and another member cannot',async()=>{
 assert.equal((await request('/deposits',payment,'owner')).status,201);
 assert.equal((await request('/deposits',payment,'auditor')).status,403);
 assert.equal((await request('/deposits',{...payment,member_id:'other',proof_file_id:'proof'},'member')).status,403);
});
test('another tenant, project or member cannot supply outstanding funds for this payment',async()=>{
 const result=await request('/deposits',{...payment,amount:50000});assert.equal(result.status,400);assert.equal(result.body.fields.outstanding,22000);assert.equal(deposits.length,0);
});
test('changed balance is rechecked before confirmation and successful confirmation cannot repeat',async()=>{
 const result=await request('/deposits',payment);dues[0].paidAmount=1;
 assert.equal((await request(`/deposits/${result.body.data.id}/confirm`,{})).status,400);assert.equal(account.balance,0);assert.equal(receipts.length,0);
 dues[0].paidAmount=0;assert.equal((await request(`/deposits/${result.body.data.id}/confirm`,{})).status,200);
 assert.equal((await request(`/deposits/${result.body.data.id}/confirm`,{})).status,400);assert.equal(account.balance,22000);assert.equal(receipts.length,1);
});

async function removePayment(id, role='member') {
 const res=await fetch(`${base}/deposits/${id}`,{method:'DELETE',headers:{'x-role':role}});
 return {status:res.status,body:await res.json()};
}
function pendingDeposit(extra={}) {
 const row={id:'pending-own',tenantId:'tenant',projectId:'project',memberId:'member',submittedById:'actor',amount:3000,status:'pending_accountant',accountantById:null,...extra};
 deposits.push(row);return row;
}
test('member can delete own awaiting payment at either review stage without changing ledger balances',async()=>{
 for(const status of ['submitted','pending_accountant','pending_approver']) {
  const row=pendingDeposit({id:`own-${status}`,status,accountantById:status==='pending_approver'?'accountant':null});
  allocations.push({depositId:row.id,dueId:'arrears'});
  const result=await removePayment(row.id);assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(deposits.some(d=>d.id===row.id),false);assert.equal(allocations.some(a=>a.depositId===row.id),false);
 }
 assert.equal(account.balance,0);assert.equal(outstanding(),22000);assert.equal(receipts.length,0);assert.equal(transactions.length,0);
});
test('member cannot delete confirmed or rejected payments or another submitter, tenant or project submission',async()=>{
 for(const extra of [{status:'confirmed'},{status:'rejected'},{submittedById:'someone-else'},{tenantId:'other'},{projectId:'other'}]) {
  deposits=[];const row=pendingDeposit(extra);const result=await removePayment(row.id);
  assert.ok([400,403,404].includes(result.status));assert.equal(deposits.length,1);
 }
});
test('confirmation that wins the race prevents deletion of posted payment history',async()=>{
 const row=pendingDeposit();const original=prisma.deposit.deleteMany;
 prisma.deposit.deleteMany=async args=>{row.status='confirmed';account.balance=3000;receipts.push({depositId:row.id});transactions.push({referenceId:row.id});return original(args);};
 try {assert.equal((await removePayment(row.id)).status,400);assert.equal(deposits.length,1);assert.equal(account.balance,3000);assert.equal(receipts.length,1);assert.equal(transactions.length,1);}
 finally {prisma.deposit.deleteMany=original;}
});
test('deletion that wins prevents subsequent confirmation and posting',async()=>{
 const submitted=await request('/deposits',{...payment,proof_file_id:'proof'},'member');assert.equal(submitted.status,201);
 const id=submitted.body.data.id;assert.equal((await removePayment(id)).status,200);
 assert.equal((await request(`/deposits/${id}/confirm`,{})).status,404);
 assert.equal(account.balance,0);assert.equal(receipts.length,0);assert.equal(transactions.length,0);
});

async function allocationPreview(id, role='admin', scope) {
 const res=await fetch(`${base}/deposits/${id}/allocation-preview${scope?'?scope='+scope:''}`,{headers:{'x-role':role}});
 return {status:res.status,body:await res.json()};
}
test('backend preview assigns 1,000 and 2,000 rather than equal shares, exactly matching final posting',async()=>{
 dues=[due('first','same-name-one',2000,{paidAmount:1000}),due('second','same-name-two',2000,{dueDate:new Date('2026-10-13')})];
 const submitted=await request('/deposits',{...payment,amount:3000});assert.equal(submitted.status,201);
 const id=submitted.body.data.id;const preview=await allocationPreview(id);assert.equal(preview.status,200);
 const view=preview.body.data;assert.equal(view.can_confirm,true);assert.deepEqual(view.items.map(row=>row.amount),[1000,2000]);
 assert.deepEqual(view.items.map(row=>row.principal_amount),[1000,2000]);assert.deepEqual(view.items.map(row=>row.penalty_amount),[0,0]);
 assert.deepEqual(view.items.map(row=>row.due_date),['2026-01-01T00:00:00.000Z','2026-10-13T00:00:00.000Z']);
 assert.equal(view.total_allocated,3000);assert.equal(view.unallocated_amount,0);
 assert.equal(account.balance,0);assert.deepEqual(dues.map(row=>row.paidAmount),[1000,0]);assert.equal(receipts.length,0);
 assert.equal((await request(`/deposits/${id}/confirm`,{})).status,200);
 assert.deepEqual(allocations.map(row=>row.amount),view.items.map(row=>row.amount));assert.equal(account.balance,3000);
});
test('preview includes waivers and separate late fee amounts, respecting the selected priority',async()=>{
 for(const allocate of ['penalty_first','principal_first']) {
  reset();dues=[due('first','s1',2000,{paidAmount:500,waivedAmount:500,penaltyDue:300,penaltyPaid:100})];
  const submitted=await request('/deposits',{...payment,amount:500,allocate});const id=submitted.body.data.id;
  const view=(await allocationPreview(id)).body.data;assert.equal(view.items[0].outstanding_before,1200);assert.equal(view.items[0].outstanding_after,700);
  assert.equal(view.items[0].principal_amount,allocate==='penalty_first'?300:500);assert.equal(view.items[0].penalty_amount,allocate==='penalty_first'?200:0);
  assert.equal((await request(`/deposits/${id}/confirm`,{})).status,200);
  assert.equal(dues[0].paidAmount,500+view.items[0].principal_amount);assert.equal(dues[0].penaltyPaid,100+view.items[0].penalty_amount);
 }
});
test('changed dues return a refreshed allocation and block approval when payment exceeds current dues',async()=>{
 const submitted=await request('/deposits',payment);const id=submitted.body.data.id;
 dues[0].paidAmount=10000;const view=(await allocationPreview(id)).body.data;
 assert.equal(view.can_confirm,false);assert.equal(view.total_allocated,12000);assert.equal(view.unallocated_amount,10000);assert.ok(view.reason);
 assert.equal((await request(`/deposits/${id}/confirm`,{})).status,400);assert.equal(account.balance,0);assert.equal(receipts.length,0);
});
test('preview distinguishes an advance from dues allocation without posting any money',async()=>{
 pendingDeposit({allocate:'advance',approvalRoute:'accountant',status:'pending_accountant'});
 const view=(await allocationPreview('pending-own','accountant')).body.data;
 assert.equal(view.kind,'advance');assert.equal(view.advance_amount,3000);assert.deepEqual(view.items,[]);assert.equal(view.can_confirm,true);assert.equal(account.balance,0);
});
test('preview is project scoped and respects member and approval-queue access',async()=>{
 pendingDeposit({approvalRoute:'accountant',status:'pending_accountant'});
 assert.equal((await allocationPreview('pending-own','member')).status,403);
 assert.equal((await allocationPreview('pending-own','approver')).status,403);
 assert.equal((await allocationPreview('pending-own','accountant')).status,200);
 deposits[0].projectId='other';assert.equal((await allocationPreview('pending-own')).status,404);
});
test('confirmed payments cannot be previewed as if they were still awaiting approval',async()=>{
 pendingDeposit({status:'confirmed'});assert.equal((await allocationPreview('pending-own')).status,400);
});

test('final confirmation with a preview version rejects a changed split even when the total still fits',async()=>{
 dues=[due('first','s1',2000),due('second','s2',2000,{dueDate:new Date('2026-10-13')})];
 const submitted=await request('/deposits',{...payment,amount:3000});const id=submitted.body.data.id;
 const preview=(await allocationPreview(id)).body.data;assert.match(preview.allocation_version,/^[a-f0-9]{64}$/);
 dues[0].paidAmount=500;
 const result=await request(`/deposits/${id}/confirm`,{allocation_version:preview.allocation_version});
 assert.equal(result.status,400);assert.match(result.body.error,/changed since review/);assert.equal(account.balance,0);assert.equal(receipts.length,0);
 const fresh=(await allocationPreview(id)).body.data;assert.deepEqual(fresh.items.map(row=>row.amount),[1500,1500]);
 assert.equal((await request(`/deposits/${id}/confirm`,{allocation_version:fresh.allocation_version})).status,200);
 assert.deepEqual(allocations.map(row=>row.amount),fresh.items.map(row=>row.amount));
});

test('due change between preview validation and transaction locking cannot post stale amounts',async()=>{
 dues=[due('first','s1',2000),due('second','s2',2000,{dueDate:new Date('2026-10-13')})];
 const submitted=await request('/deposits',{...payment,amount:3000});const id=submitted.body.data.id;
 const preview=(await allocationPreview(id)).body.data;
 const original=prisma.$queryRaw;prisma.$queryRaw=async()=>{dues[0].paidAmount=500;return[];};
 try {
  const result=await request(`/deposits/${id}/confirm`,{allocation_version:preview.allocation_version});
  assert.equal(result.status,400);assert.match(result.body.error,/changed since review/);assert.equal(account.balance,0);assert.equal(receipts.length,0);assert.equal(transactions.length,0);
 } finally {prisma.$queryRaw=original;}
});
test('accountant cannot approve a breakdown that has changed since preview',async()=>{
 dues=[due('first','s1',3000)];
 deposits.push({id:'accountant-payment',tenantId:'tenant',projectId:'project',memberId:'member',submittedById:'actor',amount:3000,allocate:'penalty_first',status:'pending_accountant',approvalRoute:'accountant',accountId:'account'});
 allocations.push({depositId:'accountant-payment',dueId:'first',scheduleId:'s1',amount:0});
 const view=(await allocationPreview('accountant-payment','accountant')).body.data;dues[0].paidAmount=500;
 const originalProject=prisma.project.findFirstOrThrow, originalMembership=prisma.projectMembership.findFirst;
 prisma.project.findFirstOrThrow=async()=>({portalSettings:{deposit_review:'automatic',member_shortcuts:[],accountant_shortcuts:[]}});
 prisma.projectMembership.findFirst=async()=>({id:'accountant-membership'});
 try {
  const result=await request('/deposits/accountant-payment/approve',{allocation_version:view.allocation_version},'accountant');
  assert.equal(result.status,400);assert.match(result.body.error,/changed since review/);assert.equal(deposits[0].status,'pending_accountant');assert.equal(account.balance,0);
 } finally {prisma.project.findFirstOrThrow=originalProject;prisma.projectMembership.findFirst=originalMembership;}
});

async function coveredPayment(extra={}) {
 const submitted=await request('/deposits',{...payment,amount:2000});
 assert.equal(submitted.status,201);
 const id=submitted.body.data.id;
 Object.assign(deposits.find(row=>row.id===id),extra);
 for(const row of dues.filter(row=>row.tenantId==='tenant'&&row.projectId==='project'&&row.memberId==='member'))row.paidAmount=row.amount;
 return {id,source:(await allocationPreview(id)).body.data};
}
const resolvePayment=(id,source,action,extra={})=>request(`/deposits/${id}/resolve-allocation`,{action,source_version:source.allocation_version,reason:'Verified separate cash received',...extra});
test('admin can explicitly reassign a covered payment to other member dues without posting until fresh approval',async()=>{
 const {id,source}=await coveredPayment();assert.equal(source.total_allocated,0);assert.equal(source.can_confirm,false);
 dues.push(due('replacement','replacement-schedule',3000));
 const candidate=(await allocationPreview(id,'admin','member_dues')).body.data;
 assert.equal(candidate.total_allocated,2000);assert.equal(candidate.scope,'member_dues');
 assert.equal((await request(`/deposits/${id}/confirm`,{allocation_version:candidate.allocation_version})).status,400);
 const result=await resolvePayment(id,source,'reassign',{allocation_version:candidate.allocation_version});
 assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.status,'pending_approver');
 assert.deepEqual(allocations.map(row=>row.dueId),['replacement']);assert.equal(deposits[0].amount,2000);
 assert.equal(account.balance,0);assert.equal(receipts.length,0);assert.equal(transactions.length,0);
 const audit=activities.find(row=>row.action==='deposit.allocation_resolved');assert.equal(audit.after.reason,'Verified separate cash received');assert.ok(audit.before.allocations.length>0);
 const fresh=(await allocationPreview(id)).body.data;assert.equal(fresh.can_confirm,true);
 assert.equal((await request(`/deposits/${id}/confirm`,{allocation_version:fresh.allocation_version})).status,200);
 assert.equal(account.balance,2000);assert.equal(receipts.length,1);assert.equal(dues.find(row=>row.id==='replacement').paidAmount,2000);
});
test('admin can keep the entire separately received payment as advance credit without paying the old dues twice',async()=>{
 const {id,source}=await coveredPayment();
 const result=await resolvePayment(id,source,'advance');assert.equal(result.status,200);
 assert.equal(deposits[0].allocate,'advance');assert.equal(deposits[0].amount,2000);assert.equal(allocations.length,0);
 assert.equal(account.balance,0);assert.equal(receipts.length,0);
 const fresh=(await allocationPreview(id)).body.data;assert.equal(fresh.kind,'advance');assert.equal(fresh.advance_amount,2000);
 assert.equal((await request(`/deposits/${id}/confirm`,{allocation_version:fresh.allocation_version})).status,200);
 assert.equal(account.balance,2000);assert.equal(receipts.length,1);assert.equal(outstanding(),0);
 assert.equal((await request(`/deposits/${id}/confirm`,{allocation_version:fresh.allocation_version})).status,400);
 assert.equal(account.balance,2000);assert.equal(receipts.length,1);
});
test('partial overpayment cannot be reassigned unless the whole claim fits; full advance leaves remaining dues unchanged',async()=>{
 const {id}=await coveredPayment();dues[0].paidAmount=dues[0].amount-500;
 const source=(await allocationPreview(id)).body.data;assert.equal(source.total_allocated,500);assert.equal(source.unallocated_amount,1500);
 const candidate=(await allocationPreview(id,'admin','member_dues')).body.data;
 const original=copy(allocations);assert.equal((await resolvePayment(id,source,'reassign',{allocation_version:candidate.allocation_version})).status,400);
 assert.deepEqual(allocations,original);assert.equal((await resolvePayment(id,source,'advance')).status,200);
 const fresh=(await allocationPreview(id)).body.data;await request(`/deposits/${id}/confirm`,{allocation_version:fresh.allocation_version});
 assert.equal(outstanding(),500);assert.equal(account.balance,2000);assert.equal(deposits[0].allocate,'advance');
});
test('changed source or alternative dues invalidate the resolution without changing allocations or money',async()=>{
 const {id,source}=await coveredPayment();dues.push(due('replacement','replacement-schedule',3000));
 const candidate=(await allocationPreview(id,'admin','member_dues')).body.data, original=copy(allocations);
 dues.find(row=>row.id==='replacement').paidAmount=500;
 assert.equal((await resolvePayment(id,source,'reassign',{allocation_version:candidate.allocation_version})).status,409);
 assert.deepEqual(allocations,original);
 dues[0].waivedAmount=1;
 assert.equal((await resolvePayment(id,source,'advance')).status,409);
 assert.equal(deposits[0].allocate,'penalty_first');assert.equal(account.balance,0);assert.equal(receipts.length,0);
});
test('only admins or owners can resolve allocations, with a reason and an unchanged pending payment',async()=>{
 const {id,source}=await coveredPayment();
 for(const role of ['accountant','approver','auditor','cashier','member']) {
  assert.equal((await allocationPreview(id,role,'member_dues')).status,403,role);
  assert.equal((await request(`/deposits/${id}/resolve-allocation`,{action:'advance',source_version:source.allocation_version,reason:'Verified cash'},role)).status,403,role);
 }
 for(const extra of [{reason:''},{source_version:'invalid'},{amount:1},{action:'unknown'}])assert.equal((await resolvePayment(id,source,'advance',extra)).status,400);
 deposits[0].projectId='other';assert.equal((await resolvePayment(id,source,'advance')).status,404);deposits[0].projectId='project';
 deposits[0].status='confirmed';assert.equal((await resolvePayment(id,source,'advance')).status,409);deposits[0].status='pending_approver';
 assert.equal((await request(`/deposits/${id}/resolve-allocation`,{action:'advance',source_version:source.allocation_version,reason:'Verified cash'},'owner')).status,200);
});
test('changing an accountant-reviewed payment clears the endorsement and returns it to accountant review',async()=>{
 const original=prisma.project.findFirstOrThrow,originalMembership=prisma.projectMembership.findFirst;
 prisma.project.findFirstOrThrow=async()=>({portalSettings:{deposit_review:'automatic'}});prisma.projectMembership.findFirst=async()=>({id:'accountant-membership'});
 try {
  const {id,source}=await coveredPayment({status:'pending_approver',approvalRoute:'accountant',accountantById:'previous-accountant'});
  const result=await resolvePayment(id,source,'advance');assert.equal(result.status,200);assert.equal(result.body.data.status,'pending_accountant');assert.equal(deposits[0].accountantById,null);
  assert.equal((await request(`/deposits/${id}/confirm`,{},'approver')).status,400);assert.equal(account.balance,0);
  const preview=(await allocationPreview(id,'accountant')).body.data;
  assert.equal((await request(`/deposits/${id}/approve`,{allocation_version:preview.allocation_version},'accountant')).status,200);
  assert.equal(deposits[0].status,'pending_approver');assert.equal(account.balance,0);
  const final=(await allocationPreview(id,'approver')).body.data;
  assert.equal((await request(`/deposits/${id}/confirm`,{allocation_version:final.allocation_version},'approver')).status,200);assert.equal(account.balance,2000);
 } finally {prisma.project.findFirstOrThrow=original;prisma.projectMembership.findFirst=originalMembership;}
});
test('accountant approval cannot bypass a changed balance even without a preview version',async()=>{
 const {id}=await coveredPayment({approvalRoute:'accountant',status:'pending_accountant'});
 const original=prisma.project.findFirstOrThrow,originalMembership=prisma.projectMembership.findFirst;
 prisma.project.findFirstOrThrow=async()=>({portalSettings:{deposit_review:'automatic'}});prisma.projectMembership.findFirst=async()=>({id:'accountant-membership'});
 try {assert.equal((await request(`/deposits/${id}/approve`,{},'accountant')).status,400);assert.equal(deposits[0].status,'pending_accountant');assert.equal(account.balance,0);}
 finally {prisma.project.findFirstOrThrow=original;prisma.projectMembership.findFirst=originalMembership;}
});
test('two pending payments competing for the same dues post only one deposit',async()=>{
 const first=await request('/deposits',payment), second=await request('/deposits',payment);
 const a=first.body.data.id,b=second.body.data.id;
 const av=(await allocationPreview(a)).body.data,bv=(await allocationPreview(b)).body.data;
 const results=await Promise.all([request(`/deposits/${a}/confirm`,{allocation_version:av.allocation_version}),request(`/deposits/${b}/confirm`,{allocation_version:bv.allocation_version})]);
 assert.deepEqual(results.map(row=>row.status).sort(),[200,400]);assert.equal(account.balance,22000);assert.equal(receipts.length,1);assert.equal(transactions.length,1);
});
test('rejection cannot overwrite a payment that another reviewer just confirmed',async()=>{
 const {id}=await coveredPayment();const original=prisma.deposit.updateMany;
 prisma.deposit.updateMany=async args=>{deposits[0].status='confirmed';return original(args);};
 try {assert.equal((await request(`/deposits/${id}/reject`,{reason:'Duplicate submission'})).status,409);assert.equal(deposits[0].status,'confirmed');}
 finally {prisma.deposit.updateMany=original;}
});
test('a payment changed after the initial read cannot be posted using its former account or amount',async()=>{
 const submitted=await request('/deposits',payment),id=submitted.body.data.id;
 const preview=(await allocationPreview(id)).body.data,original=prisma.$queryRaw;
 prisma.$queryRaw=async()=>{deposits[0].amount=100;return[];};
 try {assert.equal((await request(`/deposits/${id}/confirm`,{allocation_version:preview.allocation_version})).status,409);assert.equal(receipts.length,0);assert.equal(account.balance,0);}
 finally {prisma.$queryRaw=original;}
});

test('explicit verified administrator submission finalizes atomically with proof, receipt, balance and actual before/after dues',async()=>{
 const result=await request('/deposits',{...payment,amount:2000,method:'bank',proof_file_id:'original-proof',finalize:true});
 assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.data.status,'confirmed');assert.equal(result.body.data.member_due_before,22000);assert.equal(result.body.data.member_due_after,20000);assert.ok(result.body.data.receipt_no);
 assert.equal(deposits.length,1);assert.equal(deposits[0].proofFileId,'original-proof');assert.equal(deposits[0].approverById,'actor');assert.equal(account.balance,2000);assert.equal(outstanding(),20000);assert.equal(receipts.length,1);assert.equal(transactions.length,1);
 assert.equal((await request(`/deposits/${result.body.data.id}/confirm`,{})).status,400);assert.equal(account.balance,2000);assert.equal(receipts.length,1);assert.equal(transactions.length,1);
});
test('owner can finalize; accountant submissions remain awaiting approval without reducing dues',async()=>{
 let result=await request('/deposits',{...payment,amount:2000,finalize:true},'owner');assert.equal(result.status,201,JSON.stringify(result.body));assert.equal(result.body.data.status,'confirmed');assert.equal(account.balance,2000);
 reset();result=await request('/deposits',{...payment,amount:2000,proof_file_id:'proof'},'accountant');assert.equal(result.status,201);assert.equal(result.body.data.status,'pending_approver');assert.equal(result.body.data.member_due_before,22000);assert.equal(result.body.data.member_due_after,22000);assert.equal(account.balance,0);assert.equal(receipts.length,0);
});
test('non-admins cannot forge immediate finalization and unsupported/overpaid requests never post',async()=>{
 for(const role of ['accountant','member','cashier','approver','auditor']){const result=await request('/deposits',{...payment,finalize:true,proof_file_id:'proof'},role);assert.equal(result.status,403,role);}
 assert.equal((await request('/deposits',{...payment,finalize:true,amount:22001})).status,400);
 assert.equal(deposits.length,0);assert.equal(account.balance,0);assert.equal(receipts.length,0);assert.equal(transactions.length,0);
});
test('failure during administrator finalization rolls back the new deposit, allocations, dues, receipt and balance',async()=>{
 const create=prisma.accountTransaction.create;prisma.accountTransaction.create=async()=>{throw Error('transaction write failed');};
 try{const result=await request('/deposits',{...payment,finalize:true,amount:2000});assert.equal(result.status,500);assert.equal(deposits.length,0);assert.equal(allocations.length,0);assert.equal(receipts.length,0);assert.equal(transactions.length,0);assert.equal(account.balance,0);assert.equal(outstanding(),22000);}finally{prisma.accountTransaction.create=create;}
});
test('concurrent full administrator payments cannot settle the same dues or credit the balance twice',async()=>{
 const results=await Promise.all([request('/deposits',{...payment,finalize:true}),request('/deposits',{...payment,finalize:true})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,400]);assert.equal(deposits.length,1);assert.equal(receipts.length,1);assert.equal(transactions.length,1);assert.equal(account.balance,22000);assert.equal(outstanding(),0);
});
