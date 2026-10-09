import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import express from 'express';
import { prisma } from '../dist/core/prisma/client.js';
import { expensesRouter } from '../dist/modules/expenses/expenses.routes.js';
import { dhakaToday, toExpenseDate } from '../dist/modules/expenses/expense-input.js';

let rows, account, vendor, server, url;
const fields = { title: 'Site materials', amount: 1500, category: 'materials', vendor_id: 'vendor', account_id: 'account' };
function reset() {
  rows=[];
  account={ id:'account', tenantId:'tenant', projectId:'project', balance:100000, name:'Cash' };
  vendor={ id:'vendor', tenantId:'tenant', projectId:'project', name:'Supply Co', phone:'+8801711000000' };
}
const matches=(row,where)=>Object.entries(where).every(([key,value])=>row[key]===value);
before(async()=>{
  prisma.onboardingProgress.findUnique=async()=>({expenseApprovalFlow:'accountant_only'});
  prisma.vendor.findFirst=async({where})=>matches(vendor,where)?vendor:null;
  prisma.account.findFirst=async({where})=>matches(account,where)?account:null;
  prisma.account.updateMany=async({where,data})=>{if(account.balance<where.balance.gte)return {count:0};account.balance-=data.balance.decrement;return {count:1}};
  prisma.account.findUniqueOrThrow=async()=>account;
  prisma.accountTransaction.create=async({data})=>({id:'transaction',...data});
  prisma.expense.create=async({data})=>{const row={id:'expense-'+rows.length,createdAt:new Date(),updatedAt:new Date(),paidAt:null,...data};rows.push(row);return row};
  prisma.expense.findMany=async({where})=>rows.filter(row=>matches(row,where));
  prisma.activity.create=async({data})=>data;
  prisma.projectMembership.findMany=async()=>[];
  prisma.whatsAppConnection.findFirst=async()=>null;
  prisma.$transaction=async callback=>callback(prisma);
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.auth={tenantId:'tenant',projectId:'project',userId:'actor',roles:[req.header('x-test-role')??'accountant']};next()});
  app.use('/expenses',expensesRouter);
  app.use((error,_req,res,_next)=>res.status(error.statusCode??500).json({error:error.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await prisma.$disconnect()});
async function request(body,role='accountant',path='') {
  const response=await fetch(url+'/expenses'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-test-role':role},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
}

test('expense date defaults to the Dhaka day for older clients',async()=>{
  reset();const response=await request(fields);assert.equal(response.status,201);
  assert.equal(response.body.data.expenseDate.slice(0,10),dhakaToday());
  assert.equal(response.body.data.vendorPhone,vendor.phone);
});
test('backdated expenses preserve posting and payment timestamps',async()=>{
  reset();const before=Date.now();const response=await request({...fields,expense_date:'2024-02-29'},'admin');
  assert.equal(response.status,201);const result=response.body.data;
  assert.equal(result.expenseDate,'2024-02-29T00:00:00.000Z');
  assert.ok(Date.parse(result.createdAt)>=before);assert.ok(Date.parse(result.paidAt)>=before);
  assert.equal(account.balance,98500);
});
test('invalid and future expense dates are rejected before any writes',async()=>{
  reset();const future=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
  for(const value of ['2026-02-30','2025-02-29','2026-13-01','10/09/2026','',future]) assert.equal((await request({...fields,expense_date:value})).status,400,value);
  assert.equal(rows.length,0);assert.equal(account.balance,100000);
});
test('vendor phone is optional and explicit numbers are normalized and snapshotted',async()=>{
  reset();const response=await request({...fields,vendor_phone:'+880 (1711) 222-333'});
  assert.equal(response.status,201);assert.equal(response.body.data.vendorPhone,'+8801711222333');
  assert.equal(vendor.phone,'+8801711000000');
  const cleared=await request({...fields,vendor_phone:null});assert.equal(cleared.status,201);assert.equal(cleared.body.data.vendorPhone,null);
  const without=await request({...fields,vendor_id:undefined,vendor:undefined});assert.equal(without.status,201);assert.equal(without.body.data.vendorPhone,null);
});
test('malformed vendor numbers fail before persistence',async()=>{
  reset();for(const value of ['hello','++8801711000000','123','+1234567890123456','']) assert.equal((await request({...fields,vendor_phone:value})).status,400,value);
  assert.equal(rows.length,0);
});
test('foreign project vendor cannot be referenced by a new expense',async()=>{
  reset();vendor.projectId='foreign';assert.equal((await request(fields)).status,404);assert.equal(rows.length,0);
});
test('grouping reports the chosen business date without changing approved status',async()=>{
  reset();await request({...fields,expense_date:'2024-02-29'});
  const response=await request(undefined,'accountant','/by-category');assert.equal(response.status,200);
  assert.equal(response.body.data[0].items[0].occurred_at,'2024-02-29T00:00:00.000Z');
  assert.equal(response.body.data[0].items[0].status,'approved');assert.equal(account.balance,100000);
});
test('Dhaka default crosses month and year boundaries and creates a UTC date-only value',()=>{
  assert.equal(dhakaToday(new Date('2026-12-31T17:59:00Z')),'2026-12-31');
  assert.equal(dhakaToday(new Date('2026-12-31T18:00:00Z')),'2027-01-01');
  assert.equal(toExpenseDate(undefined,new Date('2026-12-31T18:00:00Z')).toISOString(),'2027-01-01T00:00:00.000Z');
});
