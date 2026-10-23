import assert from 'node:assert/strict';
import {test,before,after,beforeEach} from 'node:test';
import {randomUUID} from 'node:crypto';
import express from 'express';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'expense-submit-isolated-tests'});
const {prisma}=await import('../dist/core/prisma/client.js');
const {expensesRouter}=await import('../dist/modules/expenses/expenses.routes.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
let db,server,base,queue=Promise.resolve(),failAudit=false;
const copy=value=>structuredClone(value);
const matches=(row,where)=>!!row&&Object.entries(where).every(([key,value])=>value===undefined||value instanceof Date?value===undefined||row[key]?.getTime()===value.getTime():value&&typeof value==='object'&&'gte'in value?row[key]>=value.gte:row[key]===value);
const draft=()=>({id:'draft',tenantId:'tenant',projectId:'project',createdById:'creator',status:'draft',title:'Buffet meal',amount:6567,category:'services',vendor:'Buffet Lounge',accountId:null,docFileId:'receipt',expenseDate:new Date('2025-03-24'),paidAt:null,updatedAt:new Date('2026-10-01T08:00:00.000Z'),createdAt:new Date('2026-10-01T08:00:00.000Z')});
beforeEach(()=>{failAudit=false;db={expenses:[draft()],accounts:[{id:'cash',tenantId:'tenant',projectId:'project',balance:10000}],activity:[],ledger:[]};});
before(async()=>{
 prisma.$queryRaw=async()=>[];
 prisma.expense.findFirst=async({where})=>copy(db.expenses.find(row=>matches(row,where))??null);
 prisma.expense.findFirstOrThrow=async({where})=>{const row=db.expenses.find(row=>matches(row,where));assert.ok(row);return copy(row);};
 prisma.expense.updateMany=async({where,data})=>{const rows=db.expenses.filter(row=>matches(row,where));rows.forEach(row=>Object.assign(row,data,{updatedAt:new Date()}));return{count:rows.length};};
 prisma.account.findFirst=async({where})=>copy(db.accounts.find(row=>matches(row,where))??null);
 prisma.account.findFirstOrThrow=async({where})=>{const row=db.accounts.find(row=>matches(row,where));assert.ok(row);return copy(row);};
 prisma.account.updateMany=async({where,data})=>{const rows=db.accounts.filter(row=>matches(row,where));rows.forEach(row=>row.balance-=data.balance.decrement);return{count:rows.length};};
 prisma.accountTransaction.create=async({data})=>{const row={id:'transaction-'+db.ledger.length,...data};db.ledger.push(row);return copy(row);};
 prisma.activity.findFirst=async({where})=>copy(db.activity.find(row=>matches(row,where))??null);
 prisma.activity.create=async({data})=>{if(failAudit)throw Error('Injected audit failure');const row={id:'audit-'+db.activity.length,...data};db.activity.push(row);return copy(row);};
 prisma.$transaction=async fn=>{const previous=queue;let release;queue=new Promise(resolve=>release=resolve);await previous;const saved=copy(db);try{return await fn(prisma);}catch(error){db=saved;throw error;}finally{release();}};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.auth={tenantId:'tenant',projectId:'project',userId:req.header('x-user')??'creator',roles:[req.header('x-role')??'owner']};next();});app.use('/expenses',expensesRouter);app.use(errorHandler);
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/expenses`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
const body=()=>({account_id:'cash',expected_updated_at:'2026-10-01T08:00:00.000Z',request_key:randomUUID()});
async function request(data=body(),role='owner',id='draft',user='creator'){const response=await fetch(`${base}/${id}/submit`,{method:'POST',headers:{'Content-Type':'application/json','x-role':role,'x-user':user},body:JSON.stringify(data)});return{status:response.status,data:await response.json()};}
test('paying a saved draft updates the same expense, retains its receipt/date and debits once under concurrent retries',async()=>{
 const b=body();const responses=await Promise.all([request(b),request(b)]);assert.ok(responses.every(row=>row.status===200));assert.equal(db.expenses.length,1);const row=db.expenses[0];assert.equal(row.id,'draft');assert.equal(row.status,'paid');assert.equal(row.docFileId,'receipt');assert.equal(row.expenseDate.toISOString().slice(0,10),'2025-03-24');assert.ok(row.paidAt);assert.equal(row.paidAccountId,'cash');assert.equal(db.accounts[0].balance,3433);assert.equal(db.ledger.length,1);assert.equal(db.ledger[0].referenceId,'draft');
 assert.equal((await request(body())).status,409);assert.equal((await request({...b,account_id:'other'})).status,409);assert.equal(db.ledger.length,1);
});
test('accountant/cashier draft submissions enter approval without paying or debiting',async()=>{
 for(const role of ['accountant','cashier']){
  db.expenses=[draft()];db.accounts[0].balance=0;db.activity=[];const r=await request(body(),role);assert.equal(r.status,200);assert.equal(db.expenses[0].status,'pending');assert.equal(db.expenses[0].approvedById,null);assert.equal(db.accounts[0].balance,0);assert.equal(db.ledger.length,0);
 }
});
test('foreign records, stale revisions, unauthorized roles and someone else’s draft cannot be submitted',async()=>{
 assert.equal((await request(body(),'member')).status,403);assert.equal((await request(body(),'auditor')).status,403);assert.equal((await request(body(),'accountant','draft','other-user')).status,403);
 assert.equal((await request({...body(),expected_updated_at:'2026-09-01T08:00:00.000Z'})).status,409);
 db.expenses[0].projectId='foreign';assert.equal((await request()).status,404);db.expenses[0].projectId='project';db.accounts[0].projectId='foreign';assert.equal((await request()).status,404);assert.equal(db.ledger.length,0);
});
test('insufficient funds or an audit failure rolls back the status, debit and ledger; safe retry still pays once',async()=>{
 db.accounts[0].balance=6566;assert.equal((await request()).status,400);assert.equal(db.expenses[0].status,'draft');assert.equal(db.accounts[0].balance,6566);assert.equal(db.ledger.length,0);
 db.accounts[0].balance=10000;const b=body();failAudit=true;assert.equal((await request(b)).status,500);assert.equal(db.expenses[0].status,'draft');assert.equal(db.accounts[0].balance,10000);assert.equal(db.ledger.length,0);failAudit=false;assert.equal((await request(b)).status,200);assert.equal(db.ledger.length,1);
});
test('the saved amount is authoritative and cannot be replaced in the payment body',async()=>{
 assert.equal((await request({...body(),amount:1})).status,400);assert.equal(db.expenses[0].status,'draft');assert.equal(db.accounts[0].balance,10000);
});
