import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'billing-isolated-test';
const { prisma } = await import('../dist/core/prisma/client.js');
const { Prisma } = await import('@prisma/client');
const { constructionRouter } = await import('../dist/modules/construction/construction.routes.js');
const { purchasesRouter } = await import('../dist/modules/purchases/purchases.routes.js');
const { authenticate } = await import('../dist/core/security/auth.middleware.js');
const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');
const { errorHandler } = await import('../dist/core/http/error-handler.js');
const { runningBill } = await import('../dist/modules/construction/construction.policy.js');
const { cycleAmount, aging, today } = await import('../dist/modules/billing/billing.policy.js');
const { normalizePortalSettings, portalSettingsSchema } = await import('../dist/core/projects/project-settings.js');
let db, counter, server, base, failAudit, retry, queue = Promise.resolve();
const copy = value => structuredClone(value);
const models = { project: 'projects', customer: 'customers', account: 'accounts', constructionCostHead:'heads', constructionBoq:'boq', constructionCostAllocation:'allocations', constructionContractor:'contractors', constructionContract:'contracts', constructionRunningBill:'bills', constructionSupplierBill:'supplierBills', constructionLaborEntry:'labor', constructionMaterialEntry:'materials', constructionPayment:'payments', constructionChangeOrder:'changes', expense:'expenses', vendor:'vendors', purchase:'purchases', inventoryItem:'inventory', stockMovement:'stock', due:'dues', deposit:'deposits', member:'members', schedule:'schedules', activity: 'activity', accountTransaction: 'transactions', session: 'sessions', projectMembership: 'memberships' };
function reset() {
  counter = 0; failAudit = false; retry = false;
  db = Object.fromEntries(Object.values(models).map(t => [t, []]));
  db.projects = [{ id: 'p', tenantId: 't', projectType: 'construction', name: 'Community', isActive: true, billingSettings: null }, { id: 'fund', tenantId: 't', projectType: 'fund_shares', isActive: true }, { id: 'foreign', tenantId: 'other', projectType: 'construction', isActive: true }];
  db.customers = [{ id: 'c', tenantId: 't', projectId: 'p', name: 'Customer', isActive: true, email: 'customer@example.test', mobile: null, address: null }, { id: 'c2', tenantId: 't', projectId: 'p', name: 'Second', isActive: true, email: null }, { id: 'foreign-c', tenantId: 'other', projectId: 'foreign', name: 'Private', isActive: true }];
  db.accounts = [{ id: 'a', tenantId: 't', projectId: 'p', name: 'Cash', balance: 5000000 }, { id: 'foreign-a', tenantId: 'other', projectId: 'foreign', balance: 1000 }];
}
function match(row, where = {}) {
  if (!row) return false;
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === 'OR') return v.some(w => match(row, w));
    if (k === 'AND') return v.every(w => match(row, w));
    if (v instanceof Date) return row[k]?.getTime() === v.getTime();
    if (v && typeof v === 'object') {
      if (k === 'project') return match(db.projects.find(p => p.id === row.projectId), v);
      if (k === 'user') return match(row.user ?? { isActive: true }, v);
      if ('in' in v) return v.in.includes(row[k]);
      return Object.entries(v).every(([op, n]) => op === 'gt' ? row[k] > n : op === 'gte' ? row[k] >= n : op === 'lt' ? row[k] < n : op === 'lte' ? row[k] <= n : op === 'not' ? row[k] !== n : false);
    }
    return row[k] === v;
  });
}
function decorate(table, row, include) {
  if (!row) return null;
  const r = copy(row);
  if (include?.expense) r.expense=copy(db.expenses.find(e=>e.id===row.expenseId));
  if (include?.contractor)r.contractor=copy(db.contractors.find(c=>c.id===row.contractorId));
  if (include?.costHead)r.costHead=copy(db.heads.find(h=>h.id===row.costHeadId));
  if (include?.contract)r.contract=decorate('contracts',db.contracts.find(c=>c.id===row.contractId),include.contract.include);
  if (include?.constructionSupplierBill)r.constructionSupplierBill=copy(db.supplierBills.find(b=>b.purchaseId===row.id)??null);
  if (include?.lines)r.lines=copy(row.lines??[]);
  if (include?.plan) r.plan = copy(db.plans.find(p => p.id === row.planId));
  if (include?.unit) r.unit = copy(db.units.find(u => u.id === row.unitId) ?? null);
  if (include?.customer) r.customer = copy(db.customers.find(c => c.id === row.customerId));
  if (include?.tenant) r.tenant = { currency: 'BDT', contact: null };
  if (include?.allocations) r.allocations = db.allocations.filter(a => table === 'invoices' ? a.invoiceId === row.id : a.paymentId === row.id).map(a => ({ ...copy(a), ...(include.allocations.include?.invoice ? { invoice: copy(db.invoices.find(i => i.id === a.invoiceId)) } : {}) }));
  if (include?.adjustments) r.adjustments = db.adjustments.filter(a => a.invoiceId === row.id).map(copy);
  return r;
}
function mutate(row, data) {
  for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v && typeof v === 'object' && 'decrement' in v ? row[k] - v.decrement : copy(v);
  return row;
}
function defaults(table) {
  if (table==='heads')return {status:'pending',decidedById:null};
  if (table==='contracts')return {certifiedAmount:0,advancePaid:0,advanceRecovered:0,retentionHeld:0,retentionReleased:0,status:'active'};
  if (['bills','supplierBills','labor','changes'].includes(table))return {status:'pending',paidAmount:0,decidedAt:null,purchaseId:null,boqId:null,receivedAt:null};
  if(table==='materials')return {returnedQuantity:0,boqId:null};
  return table === 'invoices' ? { status: 'issued', paidAmount: 0, creditAmount: 0, debitAmount: 0, lateFeeAmount: 0, lateFeeAppliedAt: null, assignmentId: null, periodStart: null } : table === 'payments' ? { refundedAmount: 0, reference: null } : table === 'allocations' ? { releasedAt: null } : table === 'assignments' ? { status: 'active', endDate: null, unitId: null } : table === 'adjustments' ? { status: 'pending', decidedAt: null, decidedById: null, invoiceId: null, paymentId: null } : table === 'runs' ? { cursor: 0, status: 'queued' } : table === 'messages' ? { status: 'queued', attempts: 0, leaseUntil: null } : table === 'customers' ? { isActive: true, email: null } : {};
}
function mock(table) {
  const findMany = async ({ where = {}, orderBy = [], take = 100000, skip = 0, include } = {}) => {
    const order = Array.isArray(orderBy) ? orderBy : [orderBy];
    const rows = db[table].filter(r => match(r, where));
    rows.sort((a, b) => { for (const o of order) for (const [k, direction] of Object.entries(o)) { const diff = a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0; if (diff) return direction === 'desc' ? -diff : diff; } return 0; });
    return rows.slice(skip, skip + take).map(r => decorate(table, r, include));
  };
  return {
    aggregate:async({where})=>({_sum:{amount:db[table].filter(r=>match(r,where)).reduce((n,r)=>n+r.amount,0)}}),
    findMany, findFirst: async args => (await findMany({ ...args, take: 1 }))[0] ?? null,
    findFirstOrThrow: async args => { const row = (await findMany({ ...args, take: 1 }))[0]; assert.ok(row, `${table} missing`); return row; },
    count: async ({ where }) => db[table].filter(r => match(r, where)).length,
    create: async ({ data, include }) => {
      if (table === 'activity' && failAudit) throw new Error('Injected audit failure');
      if (db[table].some(r => data.requestKey && data.requestKey === r.requestKey && data.projectId === r.projectId || table === 'invoices' && data.assignmentId && data.assignmentId === r.assignmentId && data.periodStart.getTime() === r.periodStart.getTime())) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      const row = { id: `${table}-${++counter}`, createdAt: new Date(), updatedAt: new Date(), ...defaults(table) }; mutate(row, data); db[table].push(row); return decorate(table, row, include);
    },
    update: async ({ where, data, include }) => { const row = db[table].find(r => match(r, where)); assert.ok(row); mutate(row, data); return decorate(table, row, include); },
    updateMany: async ({ where, data }) => { const rows = db[table].filter(r => match(r, where)); rows.forEach(row => mutate(row, data)); return { count: rows.length }; },
    upsert: async ({ where, create, update }) => { const nested = Object.values(where)[0]; const row = db[table].find(r => match(r, nested)); return row ? copy(mutate(row, update)) : prisma.billingMessage.create({ data: create }); }
  };
}
before(async () => {
  prisma.businessConfiguration.findFirst = async () => null;
  prisma.businessField.findMany = async () => [];
  prisma.$queryRaw = async () => [];

  for (const [model, table] of Object.entries(models)) Object.assign(prisma[model], mock(table));
  prisma.$transaction = async fn => {
    const previous = queue; let release; queue = new Promise(r => release = r); await previous;
    const snapshot = copy(db);
    try { if (retry) { retry = false; throw new Prisma.PrismaClientKnownRequestError('serialization', { code: 'P2034', clientVersion: 'test' }); } return await fn(prisma); }
    catch (e) { db = snapshot; throw e; } finally { release(); }
  };
  const app = express(); app.use(express.json({ limit: '2mb' })); app.use(authenticate); app.use('/construction', constructionRouter); app.use('/purchases', purchasesRouter); app.use(errorHandler);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(reset);
after(async () => { await new Promise(r => server.close(r)); await prisma.$disconnect(); });
function token(role, project, userId) {
  const sessionId = randomUUID(), value = signAccessToken({ sessionId, tenantId: 't', userId });
  db.sessions.push({ id: sessionId, tenantId: 't', userId, tokenHash: hashToken(value), revokedAt: null, expiresAt: new Date(Date.now() + 60000), activeProjectId: project, user: { isActive: true, lastActiveAt: new Date() } });
  db.memberships.push({ tenantId: 't', projectId: project, userId, role, isActive: true, memberId: role === 'member' ? 'member' : null }); return value;
}
async function request(path, body, role = 'accountant', method = body ? 'POST' : 'GET', project = 'p', userId = `user-${role}`) {
  const response = await fetch(base + (path.startsWith('/purchases') ? path : '/construction' + path), { method, headers: { authorization: `Bearer ${token(role, project, userId)}`, 'x-project-id': project, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: response.headers.get('content-type')?.includes('pdf') ? Buffer.from(await response.arrayBuffer()) : await response.json() };
}
const headBody = (extra={})=>({name:'Foundation materials',phase:'Foundation',category:'materials',budget:5000000,...extra});
async function newHead(extra={}){const r=await request('/cost-heads',headBody(extra));assert.equal(r.status,201,JSON.stringify(r.body));const h=r.body.data;assert.equal((await request(`/cost-heads/${h.id}/decision`,{decision:'approve'},'approver')).status,200);return h;}
async function newContract(head){const c=await request('/contractors',{name:'Contractor'});assert.equal(c.status,201);const r=await request('/contracts',{contractor_id:c.body.data.id,cost_head_id:head.id,title:'Structure contract',amount:2000000,retention_bps:500,request_key:randomUUID()});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
const billBody=(c,cumulative=800000,extra={})=>({contract_id:c.id,cumulative_certified:cumulative,advance_recovery:0,bill_date:'2026-01-01',request_key:randomUUID(),...extra});
const payBody=(kind,target,amount)=>({kind,...target,account_id:'a',amount,payment_date:'2026-01-01',request_key:randomUUID()});
async function approve(path,row){const r=await request(`/${path}/${row.id}/decision`,{decision:'approve'},'approver');assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;}

test('construction type/menu configuration is project scoped with independent budget approval',async()=>{
 assert.equal((await request('/configuration')).status,200);assert.equal((await request('/overview',undefined,'member')).status,403);assert.equal((await request('/overview',undefined,'admin','GET','fund')).status,403);assert.equal((await request('/overview',undefined,'admin','GET','foreign')).status,403);
 const r=await request('/cost-heads',headBody());assert.equal((await request(`/cost-heads/${r.body.data.id}/decision`,{decision:'approve'},'admin','POST','p','user-accountant')).status,409);assert.equal((await request(`/cost-heads/${r.body.data.id}/decision`,{decision:'approve'},'accountant','POST','p','accountant-only')).status,403);await approve('cost-heads',r.body.data);
});
for(const role of ['member','auditor','cashier','approver'])test(`${role} cannot create construction financial records`,async()=>{assert.equal((await request('/cost-heads',headBody(),role)).status,403);assert.equal((await request('/payments',payBody('advance',{contract_id:'x'},100),role)).status,403);});
test('saved BOQ reproduces the requested 18,80,000 estimate and allocation reduces item budget',async()=>{
 const h=await newHead();const inputs=[['Cement','bags',500,520],['Rod','tons',10,90000],['Sand','CFT',2000,60],['Bricks','pcs',50000,12]];let total=0,cement;
 for(const [name,unit,quantity,rate]of inputs){const r=await request('/boq',{cost_head_id:h.id,name,unit,quantity,rate});assert.equal(r.status,201);total+=r.body.data.estimated;if(name==='Cement')cement=r.body.data;}assert.equal(total,1880000);
 db.expenses.push({id:'e',tenantId:'t',projectId:'p',amount:200000,status:'approved'});const body={expense_id:'e',cost_head_id:h.id,boq_id:cement.id,amount:200000,request_key:randomUUID()};assert.equal((await request('/allocations',body)).status,201);assert.equal((await request('/allocations',body)).status,201);assert.equal((await request('/allocations',{...body,request_key:randomUUID(),amount:1})).status,409);
 const report=(await request('/overview')).body.data;assert.equal(report.actual_cost,200000);assert.equal(report.boq.find(b=>b.id===cement.id).remaining,60000);assert.equal(report.unpaid_liabilities,200000);assert.equal(report.unallocated_cost,0);
});
test('running bill uses saved cumulative certification, retention and actual advance recovery',async()=>{
 const h=await newHead(),c=await newContract(h);assert.equal((await request('/payments',payBody('advance',{contract_id:c.id},100000))).status,201);
 const b=billBody(c,800000,{advance_recovery:100000}),first=await request('/running-bills',b);assert.equal(first.status,201);assert.equal(first.body.data.retention,40000);assert.equal(first.body.data.netPayable,660000);assert.equal(first.body.data.previousCertified,0);assert.equal((await request('/running-bills',b)).body.data.id,first.body.data.id);assert.equal((await request('/running-bills',{...b,cumulative_certified:900000})).status,409);
 await approve('running-bills',first.body.data);const payment=payBody('running_bill',{running_bill_id:first.body.data.id},660000);assert.equal((await request('/payments',payment)).status,201);assert.equal((await request('/payments',payment)).status,201);assert.equal(db.accounts[0].balance,4240000);
 const second=(await request('/running-bills',billBody(c,1200000))).body.data;assert.equal(second.previousCertified,800000);assert.equal(second.currentCertified,400000);assert.equal(second.retention,20000);assert.equal(second.netPayable,380000);await approve('running-bills',second);
 const report=(await request('/overview')).body.data;assert.equal(report.actual_cost,1200000);assert.equal(report.cash_paid,760000);assert.equal(report.retention_payable,60000);assert.equal(report.unpaid_liabilities,440000);assert.equal(report.cost_heads[0].commitments,800000);
});
test('competing certification approvals cannot certify the same cumulative work twice',async()=>{
 const c=await newContract(await newHead()),first=(await request('/running-bills',billBody(c))).body.data,second=(await request('/running-bills',billBody(c,900000))).body.data;
 const results=await Promise.all([request(`/running-bills/${first.id}/decision`,{decision:'approve'},'approver'),request(`/running-bills/${second.id}/decision`,{decision:'approve'},'approver')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(db.contracts[0].certifiedAmount,800000);
});
test('uncertified, foreign and excessive payments cannot debit cash',async()=>{
 const c=await newContract(await newHead());const b=(await request('/running-bills',billBody(c))).body.data;assert.equal((await request('/payments',payBody('running_bill',{running_bill_id:b.id},1))).status,404);await approve('running-bills',b);assert.equal((await request('/payments',payBody('running_bill',{running_bill_id:b.id},760001))).status,409);assert.equal((await request('/payments',{...payBody('running_bill',{running_bill_id:b.id},1),account_id:'foreign-a'})).status,404);assert.equal(db.accounts[0].balance,5000000);
 assert.equal((await request('/running-bills',billBody(c,800000))).status,400);assert.equal((await request('/running-bills',billBody(c,2100000))).status,400);assert.equal((await request('/running-bills',billBody(c,900000,{advance_recovery:1}))).status,400);
});
test('contract closure gates retention releases and new advances cannot exceed unexecuted work',async()=>{
 const c=await newContract(await newHead());assert.equal((await request(`/contracts/${c.id}/status`,{status:'closed'},'admin','PATCH')).status,409);const b=(await request('/running-bills',billBody(c,2000000))).body.data;await approve('running-bills',b);assert.equal((await request('/payments',payBody('advance',{contract_id:c.id},1))).status,409);
 assert.equal((await request('/payments',payBody('retention',{contract_id:c.id},100000))).status,409);assert.equal((await request(`/contracts/${c.id}/status`,{status:'closed'},'admin','PATCH')).status,200);assert.equal((await request('/payments',payBody('retention',{contract_id:c.id},100000))).status,201);assert.equal((await request('/payments',payBody('retention',{contract_id:c.id},1))).status,409);
});
test('approved change orders revise budgets and contracts without rewriting the original amounts',async()=>{
 const h=await newHead(),c=await newContract(h);const r=await request('/change-orders',{cost_head_id:h.id,contract_id:c.id,budget_change:500000,contract_change:200000,reason:'Additional structural works',request_key:randomUUID()});assert.equal(r.status,201);await approve('change-orders',r.body.data);assert.equal(db.heads[0].budget,5000000);assert.equal(db.heads[0].revisedBudget,5500000);assert.equal(db.contracts[0].amount,2000000);assert.equal(db.contracts[0].revisedAmount,2200000);
 const report=(await request('/overview')).body.data;assert.equal(report.projected_final_cost,2200000);assert.equal(report.unspent_budget,5500000);assert.equal(report.projected_variance,3300000);
});
test('supplier bills post liabilities once and linked purchases receive stock without a second cash payment',async()=>{
 const h=await newHead();db.vendors.push({id:'v',tenantId:'t',projectId:'p',name:'Supplier',isActive:true});db.inventory.push({id:'i',tenantId:'t',projectId:'p',quantity:0,costPrice:0,isActive:true});db.purchases.push({id:'purchase',tenantId:'t',projectId:'p',vendorId:'v',status:'ordered',totalAmount:260000,lines:[{itemId:'i',quantity:500,unitCost:520}]});
 const b={vendor_id:'v',cost_head_id:h.id,purchase_id:'purchase',number:'SUP-1',description:'Cement purchase',amount:260000,bill_date:'2026-01-01',request_key:randomUUID()};const r=await request('/supplier-bills',b);assert.equal(r.status,201);await approve('supplier-bills',r.body.data);
 assert.equal((await request('/purchases/purchase/receive',{account_id:'a'})).status,400);assert.equal((await request(`/supplier-bills/${r.body.data.id}/receive`,{})).status,200);assert.equal((await request(`/supplier-bills/${r.body.data.id}/receive`,{})).status,200);assert.equal(db.inventory[0].quantity,500);assert.equal(db.accounts[0].balance,5000000);
 assert.equal((await request('/payments',payBody('supplier_bill',{supplier_bill_id:r.body.data.id},260000))).status,201);const report=(await request('/overview')).body.data;assert.equal(report.actual_cost,260000);assert.equal(report.cash_paid,260000);assert.equal(report.unpaid_liabilities,0);
});
test('daily labor records calculate wages and approval/payment remain separate',async()=>{
 const h=await newHead();const b={cost_head_id:h.id,worker_name:'Worker One',work_date:'2026-01-01',units:1.5,rate:1000,request_key:randomUUID()};const r=await request('/labor',b);assert.equal(r.status,201);assert.equal(r.body.data.amount,1500);assert.equal((await request('/labor',b)).body.data.id,r.body.data.id);await approve('labor',r.body.data);assert.equal((await request('/payments',payBody('labor',{labor_entry_id:r.body.data.id},1000))).status,201);const report=(await request('/overview')).body.data;assert.equal(report.actual_cost,1500);assert.equal(report.unpaid_liabilities,500);
});
test('material consumption, source-linked returns and wastage preserve stock and do not double-count cost',async()=>{
 const h=await newHead(),boq=(await request('/boq',{cost_head_id:h.id,name:'Cement',unit:'bags',quantity:500,rate:520})).body.data;db.inventory.push({id:'i',tenantId:'t',projectId:'p',quantity:100,isActive:true});
 const b={item_id:'i',boq_id:boq.id,kind:'consume',quantity:30,entry_date:'2026-01-01',reason:'Foundation work',request_key:randomUUID()};const r=await request('/materials',b);assert.equal(r.status,201);assert.equal((await request('/materials',b)).status,201);assert.equal(db.inventory[0].quantity,70);
 assert.equal((await request('/materials',{...b,kind:'return',quantity:10,source_id:r.body.data.id,request_key:randomUUID()})).status,201);assert.equal(db.inventory[0].quantity,80);assert.equal((await request('/materials',{...b,kind:'return',quantity:21,source_id:r.body.data.id,request_key:randomUUID()})).status,409);assert.equal((await request('/materials',{...b,kind:'waste',quantity:5,request_key:randomUUID()})).status,201);assert.equal(db.inventory[0].quantity,75);assert.equal((await request('/overview')).body.data.actual_cost,0);
});
test('audit failures roll back contractor cash payments and their contract advance together',async()=>{
 const c=await newContract(await newHead());failAudit=true;const old=console.error;console.error=()=>{};try{assert.equal((await request('/payments',payBody('advance',{contract_id:c.id},100000))).status,500);}finally{console.error=old;}assert.equal(db.accounts[0].balance,5000000);assert.equal(db.contracts[0].advancePaid,0);assert.equal(db.payments.length,0);
});
test('member-funded construction reuses the current project shares, dues and confirmed deposits',async()=>{
 db.members.push({id:'m',tenantId:'t',projectId:'p',name:'Investor',shares:10,status:'active'});db.dues.push({id:'d',tenantId:'t',projectId:'p',memberId:'m',amount:10000,paidAmount:5000,waivedAmount:0,penaltyDue:100,penaltyPaid:0});db.deposits.push({id:'deposit',tenantId:'t',projectId:'p',memberId:'m',status:'confirmed',amount:5000,refundedAmount:0});db.deposits.push({id:'pending',tenantId:'t',projectId:'p',memberId:'m',status:'submitted',amount:5000,refundedAmount:0});
 const funding=(await request('/funding')).body.data;assert.equal(funding.members[0].contributed,5000);assert.equal(funding.members[0].outstanding,5100);const r=(await request('/overview')).body.data;assert.equal(r.funding_collected,5000);assert.equal(r.contribution_dues,5100);
});

test('cash forecasts deduct prepaid advances rather than requesting the same construction funds twice',async()=>{
 db.accounts[0].balance=1000000;const c=await newContract(await newHead());await request('/payments',payBody('advance',{contract_id:c.id},500000));const r=(await request('/overview')).body.data;assert.equal(r.cost_to_complete,2000000);assert.equal(r.forecast_cash_to_complete,1500000);assert.equal(r.cash_available,500000);assert.equal(r.cash_requirement,1000000);
});
test('contract creation fingerprints retry payloads, and a linked supplier invoice blocks purchase cancellation',async()=>{
 const h=await newHead();const contractor=(await request('/contractors',{name:'Retry Contractor'})).body.data;const body={contractor_id:contractor.id,cost_head_id:h.id,title:'Same contract',amount:2000000,retention_bps:500,request_key:randomUUID()};const first=await request('/contracts',body);assert.equal((await request('/contracts',body)).body.data.id,first.body.data.id);assert.equal((await request('/contracts',{...body,amount:3000000})).status,409);
 db.purchases.push({id:'purchase',tenantId:'t',projectId:'p',status:'ordered',totalAmount:100});db.supplierBills.push({id:'bill',tenantId:'t',projectId:'p',purchaseId:'purchase',status:'pending'});assert.equal((await request('/purchases/purchase/cancel',{})).status,400);assert.equal(db.purchases[0].status,'ordered');
});
