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
const models = { inventoryLocation: 'locations', project: 'projects', customer: 'customers', account: 'accounts', constructionPhase:'phases', constructionCostHead:'heads', constructionBoq:'boq', constructionCostAllocation:'allocations', constructionContractor:'contractors', constructionContract:'contracts', constructionRunningBill:'bills', constructionSupplierBill:'supplierBills', constructionLaborEntry:'labor', constructionMaterialEntry:'materials', constructionSiteLog:'siteLogs', constructionWasteLimit:'wasteLimits', upload:'uploads', constructionPayment:'payments', constructionChangeOrder:'changes', expense:'expenses', vendor:'vendors', purchase:'purchases', inventoryItem:'inventory', stockMovement:'stock', due:'dues', deposit:'deposits', member:'members', schedule:'schedules', activity: 'activity', accountTransaction: 'transactions', session: 'sessions', projectMembership: 'memberships' };
function reset() {
  counter = 0; failAudit = false; retry = false;
  db = Object.fromEntries(Object.values(models).map(t => [t, []]));
  db.locations = [{id:'main',tenantId:'t',projectId:'p',name:'Main store',isDefault:true,isActive:true}];
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
      if ('has' in v) return Array.isArray(row[k]) && row[k].includes(v.has);
      if ('in' in v) return v.in.includes(row[k]);
      return Object.entries(v).every(([op, n]) => op === 'gt' ? row[k] > n : op === 'gte' ? row[k] >= n : op === 'lt' ? row[k] < n : op === 'lte' ? row[k] <= n : op === 'not' ? row[k] !== n : false);
    }
    return row[k] === v;
  });
}
function decorate(table, row, include) {
  if (!row) return null;
  const r = copy(row);
  if (table==='memberships' && !r.user) r.user={id:row.userId,name:row.userId,isActive:true};
  if (include?.responsibleUser) r.responsibleUser=copy(db.memberships.find(m=>m.userId===row.responsibleUserId&&m.projectId===row.projectId)?.user??null);
  if (include?.item) r.item=copy(db.inventory.find(i=>i.id===row.itemId));
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
  if (table==='siteLogs') return {version:1,status:'draft',laborIds:[],materialIds:[],submittedAt:null};
  if (table==='phases') return {revision:1,status:'draft',plannedStart:null,plannedEnd:null,actualStart:null,actualEnd:null,responsibleUserId:null};
  if (table==='heads')return {status:'pending',decidedById:null};
  if (table==='contracts')return {certifiedAmount:0,advancePaid:0,advanceRecovered:0,retentionHeld:0,retentionReleased:0,status:'active'};
  if (['bills','supplierBills','labor','changes'].includes(table))return {status:'pending',paidAmount:0,decidedAt:null,purchaseId:null,boqId:null,receivedAt:null,wastageDeduction:0,wasteEntryIds:[]};
  if(table==='materials')return {returnedQuantity:0,boqId:null,chargeBillId:null};
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
    groupBy:async({where,by})=>{const groups=new Map();for(const row of db[table].filter(r=>match(r,where))){const key=JSON.stringify(by.map(k=>row[k]??null));if(!groups.has(key))groups.set(key,{...Object.fromEntries(by.map(k=>[k,row[k]??null])),_sum:{quantity:0}});groups.get(key)._sum.quantity+=row.quantity??0;}return [...groups.values()];},
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

const siteContent = (head, extra={}) => ({ labor:[{cost_head_id:head.id,role:'Mason',workers:8,rate:950}],materials:[],expense_ids:[],photo_ids:[],note:'Slab work',...extra });
async function siteDraft(head,extra={}) { const r=await request('/site-logs',{work_date:'2026-01-01',version:0,content:siteContent(head,extra)},'accountant','PUT');assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data; }
test('daily site logs persist drafts, reject stale edits, and submit labor exactly once',async()=>{
 const h=await newHead(),draft=await siteDraft(h);
 assert.equal((await request('/overview')).body.data.actual_cost,0);
 assert.equal((await request('/site-logs',{work_date:'2026-01-01',version:0,content:siteContent(h)},'accountant','PUT')).status,409);
 const body={version:draft.version};const submitted=await request(`/site-logs/${draft.id}/submit`,body);assert.equal(submitted.status,201,JSON.stringify(submitted.body));
 const again=await request(`/site-logs/${draft.id}/submit`,body);assert.equal(again.body.data.id,draft.id);assert.equal(db.labor.length,1);assert.equal(db.labor[0].amount,7600);
 assert.equal((await request(`/site-logs/${draft.id}/decision`,{decision:'approve'},'admin','POST','p','user-accountant')).status,409);
 assert.equal((await request(`/labor/${db.labor[0].id}/decision`,{decision:'approve'},'approver')).status,409);
 assert.equal((await request('/site-logs',{work_date:'2026-01-01',version:2,content:siteContent(h)},'accountant','PUT')).status,409);
 assert.equal((await request(`/site-logs/${draft.id}/decision`,{decision:'approve'},'approver')).status,200);
 assert.equal((await request('/overview')).body.data.actual_cost,7600);assert.equal(db.accounts[0].balance,5000000);
 const listed=await request('/site-logs?from=2026-01-01&to=2026-01-07');assert.equal(listed.status,200);assert.equal(listed.body.data.length,1);
});
test('site submission atomically rolls back wages and stock on insufficient materials',async()=>{
 const h=await newHead();db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bags',quantity:10,costPrice:560,isActive:true});
 const draft=await siteDraft(h,{materials:[{item_id:'i',quantity:11}]});
 assert.equal((await request(`/site-logs/${draft.id}/submit`,{version:draft.version})).status,409);assert.equal(db.labor.length,0);assert.equal(db.inventory[0].quantity,10);assert.equal(db.siteLogs[0].status,'draft');
});
test('site submission and approval retries never duplicate physical stock movements',async()=>{
 const h=await newHead();db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bags',quantity:100,costPrice:560,isActive:true});
 const draft=await siteDraft(h,{materials:[{item_id:'i',quantity:42}]});
 for(let i=0;i<2;i++)assert.equal((await request(`/site-logs/${draft.id}/submit`,{version:draft.version})).status,201);
 assert.equal(db.inventory[0].quantity,58);assert.equal(db.materials.length,1);
 for(let i=0;i<2;i++)assert.equal((await request(`/site-logs/${draft.id}/decision`,{decision:'reject'},'approver')).status,200);
 assert.equal(db.labor[0].status,'rejected');assert.equal(db.inventory[0].quantity,58);assert.equal((await request('/overview')).body.data.actual_cost,0);
});
test('site logs reject future dates, foreign materials/photos/expenses, and unauthorized roles',async()=>{
 const h=await newHead();const base={work_date:'2026-01-01',version:0,content:siteContent(h)};
 assert.equal((await request('/site-logs',{...base,work_date:'2999-01-01'},'accountant','PUT')).status,400);
 for(const extra of [{materials:[{item_id:'foreign',quantity:1}]},{photo_ids:['foreign']},{expense_ids:['foreign']}])assert.ok((await request('/site-logs',{...base,content:siteContent(h,extra)},'accountant','PUT')).status>=400);
 for(const role of ['auditor','cashier','approver','member'])assert.equal((await request('/site-logs',base,role,'PUT')).status,403);
 assert.equal((await request('/site-logs?from=2026-01-01&to=2026-12-31')).status,400);
 assert.equal((await request('/site-logs?from=2026-01-01&to=2026-01-07',undefined,'member')).status,403);
});
test('wastage report uses saved valuation, explicit allowances and net consumption',async()=>{
 const h=await newHead(),contract=await newContract(h);db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bags',quantity:1000,costPrice:560,isActive:true});
 assert.equal((await request('/wastage/allowance',{item_id:'i',allowance_bps:200},'accountant','PUT')).status,403);
 assert.equal((await request('/wastage/allowance',{item_id:'i',allowance_bps:200},'admin','PUT')).status,200);
 await request('/materials',{item_id:'i',kind:'consume',quantity:100,entry_date:'2026-01-01',reason:'Slab work',request_key:randomUUID()});
 const body={item_id:'i',kind:'waste',quantity:6,entry_date:'2026-01-01',reason:'Rain damage',charge_contract_id:contract.id,request_key:randomUUID()};
 assert.equal((await request('/materials',body)).status,201);assert.equal((await request('/materials',body)).status,201);db.inventory[0].costPrice=900;
 const r=(await request('/wastage')).body.data;assert.equal(r.total,3360);assert.equal(r.chargeable,3360);assert.equal(r.excess,2240);assert.equal(r.materials[0].percent,6);assert.equal(r.materials[0].over,true);assert.equal(db.inventory[0].quantity,894);
 assert.equal((await request('/materials',{...body,charge_contract_id:'foreign',request_key:randomUUID()})).status,400);
 assert.equal((await request('/overview')).body.data.actual_cost,0);
});

test('chargeable wastage is reserved once, independently approved and recovered from a running bill',async()=>{
 const h=await newHead(),ct=await newContract(h);db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bags',quantity:100,costPrice:560,isActive:true});
 const waste=(await request('/materials',{item_id:'i',kind:'waste',quantity:6,entry_date:'2026-01-01',reason:'Breakage',charge_contract_id:ct.id,request_key:randomUUID()})).body.data;
 const body=billBody(ct,800000,{waste_entry_ids:[waste.id]}),bill=(await request('/running-bills',body)).body.data;
 assert.equal(bill.wastageDeduction,3360);assert.equal(bill.netPayable,756640);
 assert.equal((await request('/running-bills',body)).body.data.id,bill.id);
 assert.equal((await request('/running-bills',{...body,request_key:randomUUID()})).status,409);
 await approve('running-bills',bill);assert.equal((await request('/overview')).body.data.actual_cost,796640);
 assert.equal((await request('/wastage')).body.data.chargeable,0);
});
test('rejecting a running bill releases its proposed wastage deductions',async()=>{
 const ct=await newContract(await newHead());db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bags',quantity:100,costPrice:560,isActive:true});
 const w=(await request('/materials',{item_id:'i',kind:'waste',quantity:6,entry_date:'2026-01-01',reason:'Breakage',charge_contract_id:ct.id,request_key:randomUUID()})).body.data;
 const body=billBody(ct,800000,{waste_entry_ids:[w.id]}),b=(await request('/running-bills',body)).body.data;
 assert.equal((await request(`/running-bills/${b.id}/decision`,{decision:'reject'},'approver')).status,200);
 assert.equal((await request('/running-bills',{...body,request_key:randomUUID()})).status,201);
});

const phaseBody = (extra={}) => ({name:'Foundation',planned_start:'2026-01-01',planned_end:'2026-01-30',actual_start:null,actual_end:null,responsible_user_id:null,status:'planned',request_key:randomUUID(),...extra});
const phaseUpdate = (extra={}) => ({planned_start:'2026-01-01',planned_end:'2026-01-30',actual_start:null,actual_end:null,responsible_user_id:null,status:'planned',revision:1,...extra});
test('phase plans preserve calendar dates and inclusive duration, with safe create retries and shared budgets',async()=>{
 const body=phaseBody(),first=await request('/phases',body);assert.equal(first.status,201,JSON.stringify(first.body));
 assert.equal(first.body.data.plannedStart,'2026-01-01');assert.equal(first.body.data.plannedDays,30);
 assert.equal((await request('/phases',body)).body.data.id,first.body.data.id);
 assert.equal((await request('/phases',{...body,planned_end:'2026-02-01'})).status,409);
 assert.equal((await request('/phases',phaseBody())).status,409);
 const budget=await request('/cost-heads',headBody({phase:undefined,phase_id:first.body.data.id}));assert.equal(budget.status,201,JSON.stringify(budget.body));assert.equal(budget.body.data.phase,'Foundation');assert.equal(budget.body.data.phaseId,first.body.data.id);
 await newHead({name:'Foundation labor',category:'labor'});assert.equal(db.phases.length,1);
 assert.equal((await request('/cost-heads',headBody({phase_id:'foreign'}))).status,404);
 assert.equal((await request('/cost-heads',headBody({phase:'Wrong phase',phase_id:first.body.data.id}))).status,400);
});
test('legacy budget creation creates a draft phase without inventing dates',async()=>{
 await newHead();assert.equal(db.phases.length,1);const phase=(await request('/phases')).body.data[0];assert.equal(phase.status,'draft');assert.equal(phase.plannedDays,null);assert.equal(phase.actualStart,null);
});
test('phase updates reject stale and simultaneous saves, and require real actual dates for completion',async()=>{
 const phase=(await request('/phases',phaseBody())).body.data;
 const attempts=await Promise.all([request(`/phases/${phase.id}`,phaseUpdate({actual_start:'2026-01-02',status:'active'}),'accountant','PUT'),request(`/phases/${phase.id}`,phaseUpdate({actual_start:'2026-01-03',status:'active'}),'accountant','PUT')]);
 assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);assert.equal(db.phases[0].revision,2);
 const completed=await request(`/phases/${phase.id}`,phaseUpdate({revision:2,actual_start:'2026-01-02',actual_end:'2026-02-02',status:'completed'}),'accountant','PUT');
 assert.equal(completed.status,200,JSON.stringify(completed.body));assert.equal(completed.body.data.actualDays,32);assert.equal(completed.body.data.delayDays,3);assert.equal(completed.body.data.overdueDays,0);
 assert.equal((await request(`/phases/${phase.id}`,phaseUpdate({revision:3,name:'Rename'}),'accountant','PUT')).status,400);
});
test('phase plans reject invalid dates, unsupported statuses and incomplete actual records',async()=>{
 for(const extra of [{planned_start:'2026-02-30'},{planned_end:'2025-12-31'},{planned_start:null},{status:'active'},{status:'completed'},{status:'approved'},{actual_start:'2999-01-01',status:'active'},{actual_start:'2026-01-03',actual_end:'2026-01-02',status:'completed'},{actual_end:'2026-01-03'},{actual_start:'2026-01-01',status:'planned'}])assert.equal((await request('/phases',phaseBody(extra))).status,400,JSON.stringify(extra));
 assert.equal((await request('/phases',phaseBody({planned_start:null,planned_end:null,status:'draft'}))).status,201);
});
test('phase assignment accepts active project staff and rejects other projects, inactive users and member-only users',async()=>{
 db.memberships.push({tenantId:'t',projectId:'p',userId:'engineer',role:'accountant',isActive:true,user:{id:'engineer',name:'Site engineer',isActive:true}});
 const assigned=await request('/phases',phaseBody({responsible_user_id:'engineer'}));assert.equal(assigned.status,201,JSON.stringify(assigned.body));
 db.memberships.push({tenantId:'t',projectId:'foreign',userId:'foreign-user',role:'accountant',isActive:true});
 db.memberships.push({tenantId:'t',projectId:'p',userId:'inactive',role:'accountant',isActive:false});
 db.memberships.push({tenantId:'t',projectId:'p',userId:'inactive-user',role:'accountant',isActive:true,user:{isActive:false}});
 db.memberships.push({tenantId:'t',projectId:'p',userId:'investor',role:'member',customRoleId:null,isActive:true});
 for(const person of ['foreign-user','inactive','inactive-user','investor'])assert.equal((await request('/phases',phaseBody({name:person,responsible_user_id:person}))).status,400,person);
 assert.equal((await request(`/phases/${assigned.body.data.id}`,phaseUpdate({responsible_user_id:'foreign-user'}),'accountant','PUT')).status,400);
 assert.equal((await request(`/phases/${assigned.body.data.id}`,phaseUpdate(),'accountant','PUT','foreign')).status,403);
 assert.equal((await request('/phases',phaseBody(), 'admin','POST','fund')).status,403);
});
test('phase plan writes and assignee directory are restricted while authorized auditors can read plans',async()=>{
 const phase=(await request('/phases',phaseBody())).body.data;
 for(const role of ['auditor','cashier','approver','member']) {
  assert.equal((await request('/phases',phaseBody({name:role}),role)).status,403);
  assert.equal((await request(`/phases/${phase.id}`,phaseUpdate(),role,'PUT')).status,403);
  assert.equal((await request('/phases/assignees',undefined,role)).status,403);
 }
 assert.equal((await request('/phases',undefined,'auditor')).status,200);assert.equal((await request('/phases',undefined,'member')).status,403);
});
test('phase changes roll back when the audit cannot be written',async()=>{
 const phase=(await request('/phases',phaseBody())).body.data;failAudit=true;const old=console.error;console.error=()=>{};
 try{assert.equal((await request(`/phases/${phase.id}`,phaseUpdate({status:'active',actual_start:'2026-01-01'}),'accountant','PUT')).status,500);}finally{console.error=old;}
 assert.equal(db.phases[0].revision,1);assert.equal(db.phases[0].status,'planned');
});

test('phase assignee directory returns distinct active project staff without contact details',async()=>{
 const user={id:'engineer',name:'Site engineer',isActive:true};
 db.memberships.push({tenantId:'t',projectId:'p',userId:user.id,role:'accountant',isActive:true,user},{tenantId:'t',projectId:'p',userId:user.id,role:'approver',isActive:true,user});
 const r=await request('/phases/assignees');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.filter(u=>u.id===user.id).length,1);
 const {canChoosePhaseAssignee}=await import('../dist/modules/construction/construction.phases.js');
 assert.equal(canChoosePhaseAssignee({roles:['auditor'],menuPermissions:{construction_budgets:{read:true,write:true}}}),true);
 assert.equal(canChoosePhaseAssignee({roles:['auditor'],menuPermissions:{construction_budgets:{read:true,write:false}}}),false);
});
