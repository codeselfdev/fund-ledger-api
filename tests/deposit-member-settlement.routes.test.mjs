import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import express from 'express';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'member-settlement-isolated-test-secret';
process.env.WHATSAPP_ENABLED = 'false';
const { prisma } = await import('../dist/core/prisma/client.js');
const { depositsRouter } = await import('../dist/modules/deposits/deposits.routes.js');
const { calculateDueBalance } = await import('../dist/modules/members/member-settlement.service.js');
let server, base, dues, deposits, allocations, receipts, transactions, account, queries;
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
function due(id,scheduleId,amount,extra={}) {return {id,scheduleId,amount,tenantId:'tenant',projectId:'project',memberId:'member',paidAmount:0,waivedAmount:0,penaltyDue:0,penaltyPaid:0,status:'due',paidAt:null,dueDate:new Date('2026-01-01'),...extra};}
function reset() {
 dues=[due('arrears','imported-schedule',20000),due('new','new-schedule',2000,{dueDate:new Date('2026-10-15')}),due('foreign','foreign-schedule',99999,{tenantId:'other'}),due('other-project','other-project-schedule',99999,{projectId:'other'}),due('other-member','other-member-schedule',99999,{memberId:'other'})];
 deposits=[];allocations=[];receipts=[];transactions=[];queries=[];account={id:'account',tenantId:'tenant',projectId:'project',balance:0};
}
before(async()=>{
 prisma.$transaction=async fn=>fn(prisma);
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
 prisma.depositAllocation.createMany=async({data})=>{allocations.push(...data.map(d=>({...d,amount:0})));return{count:data.length};};
 prisma.depositAllocation.findMany=async({where})=>allocations.filter(a=>a.depositId===where.depositId).map(a=>({...a,due:copy(dues.find(d=>d.id===a.dueId))}));
 prisma.depositAllocation.updateMany=async({where,data})=>{const rows=allocations.filter(a=>matches(a,where));rows.forEach(a=>Object.assign(a,data));return{count:rows.length};};
 prisma.receipt.create=async({data})=>{const row={id:`receipt-${receipts.length}`,...data};receipts.push(row);return copy(row);};
 prisma.accountTransaction.create=async({data})=>{const row={id:`transaction-${transactions.length}`,...data};transactions.push(row);return copy(row);};
 prisma.paymentCommitment.findFirst=async()=>null;
 prisma.whatsAppConnection.findFirst=async()=>null;
 prisma.activity.create=async({data})=>data;
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
