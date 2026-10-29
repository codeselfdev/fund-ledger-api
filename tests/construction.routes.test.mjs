import { fixtureTransactionClient, normalizedAccountRelations } from './helpers/normalized-fixtures.mjs';
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
const models = { constructionRequisition:'requisitions',constructionSupplierQuote:'quotes',constructionProcurementAward:'awards',constructionDelivery:'deliveries',constructionPurchaseInvoice:'purchaseInvoices',constructionScopeChange:'scopeChanges',purchaseItem:'purchaseLines', constructionControlSetting:'controlSettings',constructionControlVersion:'controlVersions',constructionMeasurement:'measurements',constructionValuationLayer:'valuationLayers',constructionValuationEntry:'valuationEntries',constructionReclassification:'reclassifications', inventoryLocation: 'locations', project: 'projects', customer: 'customers', account: 'accounts', constructionWorkLocation:'workLocations', constructionWorkPackage:'workPackages', constructionTask:'workTasks', constructionPhase:'phases', constructionCostHead:'heads', constructionBoq:'boq', constructionCostAllocation:'allocations', constructionContractor:'contractors', constructionContract:'contracts', constructionRunningBill:'bills', constructionSupplierBill:'supplierBills', constructionLaborEntry:'labor', constructionMaterialEntry:'materials', constructionSiteLog:'siteLogs', constructionWasteLimit:'wasteLimits', upload:'uploads', constructionPayment:'payments', constructionChangeOrder:'changes', expense:'expenses', vendor:'vendors', purchase:'purchases', inventoryItem:'inventory', stockMovement:'stock', due:'dues', deposit:'deposits', member:'members', schedule:'schedules', activity: 'activity', accountTransaction: 'transactions', session: 'sessions', projectMembership: 'memberships' };
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
  if (include?.lines)r.lines=copy(row.lines??(table==='purchases'?db.purchaseLines.filter(l=>l.purchaseId===row.id):[]));
  if (include?.vendor)r.vendor=copy(db.vendors.find(v=>v.id===row.vendorId)??null);
  if (include?.plan) r.plan = copy(db.plans.find(p => p.id === row.planId));
  if (include?.unit) r.unit = copy(db.units.find(u => u.id === row.unitId) ?? null);
  if (include?.customer) r.customer = copy(db.customers.find(c => c.id === row.customerId));
  if (include?.tenant) r.tenant = { currency: 'BDT', contact: null };
  if (include?.allocations) r.allocations = db.allocations.filter(a => table === 'invoices' ? a.invoiceId === row.id : a.paymentId === row.id).map(a => ({ ...copy(a), ...(include.allocations.include?.invoice ? { invoice: copy(db.invoices.find(i => i.id === a.invoiceId)) } : {}) }));
  if (include?.adjustments) r.adjustments = db.adjustments.filter(a => a.invoiceId === row.id).map(copy);
  return normalizedAccountRelations(r);
}
function mutate(row, data) {
  for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v && typeof v === 'object' && 'decrement' in v ? row[k] - v.decrement : copy(v);
  return row;
}
function defaults(table) {
  if(['requisitions','awards','deliveries','purchaseInvoices','scopeChanges'].includes(table))return {status:'pending',decidedById:null,decidedAt:null,checkedLines:null,purchaseId:null};
  if(table==='controlSettings')return {revision:1,valuationActivation:null};
  if(table==='controlVersions'||table==='measurements')return {status:'pending',decidedById:null,decidedAt:null};
  if(table==='valuationLayers')return {sortAt:new Date()};
  if (table==='siteLogs') return {version:1,status:'draft',laborIds:[],materialIds:[],submittedAt:null};
  if (['workLocations','workPackages','workTasks'].includes(table))return {isActive:true,revision:1,description:'',parentId:null,locationId:null};
  if (table==='phases') return {revision:1,status:'draft',plannedStart:null,plannedEnd:null,actualStart:null,actualEnd:null,responsibleUserId:null};
  if (table==='heads')return {status:'pending',decidedById:null};
  if (table==='contracts')return {billingMode:'lump_sum',workItems:null,workTerms:null,certifiedQuantities:null,agreementFileIds:[],decidedById:null,decidedAt:null,certifiedAmount:0,advancePaid:0,advanceRecovered:0,retentionHeld:0,retentionReleased:0,status:'active'};
  if (['bills','supplierBills','labor','changes'].includes(table))return {measurementLines:null,evidenceFileIds:[],status:'pending',paidAmount:0,decidedAt:null,purchaseId:null,boqId:null,receivedAt:null,wastageDeduction:0,wasteEntryIds:[]};
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
    try { if (retry) { retry = false; throw new Prisma.PrismaClientKnownRequestError('serialization', { code: 'P2034', clientVersion: 'test' }); } return await fn(fixtureTransactionClient(prisma)); }
    catch (e) { db = snapshot; throw e; } finally { release(); }
  };
  const app = express(); app.use(express.json({ limit: '2mb' })); app.use(authenticate); app.use('/construction', constructionRouter); app.use('/purchases', purchasesRouter); app.use(errorHandler);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(reset);
after(async () => { await new Promise(r => server.close(r)); await prisma.$disconnect(); });
function token(role, project, userId) {
  const sessionId = randomUUID(), value = signAccessToken({ sessionId, tenantId: 't', userId });
  db.sessions.push(normalizedAccountRelations({ id: sessionId, tenantId: 't', userId, tokenHash: hashToken(value), revokedAt: null, expiresAt: new Date(Date.now() + 60000), activeProjectId: project, user: { isActive: true, lastActiveAt: new Date() } }));
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

const workKey=()=>randomUUID();
async function workLocation(name='Building A',kind='building',parent=null){const r=await request('/locations',{name,kind,parent_id:parent,request_key:workKey()});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
async function workPackage(phaseId,locationId=null,name='Ground floor brickwork'){const r=await request('/work-packages',{name,phase_id:phaseId,location_id:locationId,description:'Work scope',request_key:workKey()});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
async function workTask(pack,name='Lay bricks'){const r=await request('/tasks',{name,description:'Task scope',work_package_id:pack.id,request_key:workKey()});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
const workUpdate=(row,extra={})=>({name:row.name,description:row.description??'',is_active:row.isActive,revision:row.revision,...extra});
test('work hierarchy creates Building, Block, Floor and Zone plus phase packages and tasks',async()=>{
 const h=await newHead(),building=await workLocation(),block=await workLocation('East block','block',building.id),floor=await workLocation('Ground floor','floor',block.id),zone=await workLocation('North zone','zone',floor.id);
 const pack=await workPackage(h.phaseId,floor.id),task=await workTask(pack);
 const r=await request('/structure');assert.equal(r.status,200);assert.equal(r.body.data.locations.length,4);assert.equal(r.body.data.work_packages[0].phaseId,h.phaseId);assert.equal(r.body.data.tasks[0].workPackageId,pack.id);
 assert.deepEqual(Object.keys(r.body.data.phases[0]).sort(),['id','name']);assert.equal(r.body.data.tasks[0].requestHash,undefined);
 const budget=await request('/cost-heads',headBody({name:'Scoped materials',phase_id:h.phaseId,work_package_id:pack.id,task_id:task.id,location_id:zone.id}));assert.equal(budget.status,201,JSON.stringify(budget.body));assert.equal(budget.body.data.locationId,zone.id);assert.match(budget.body.data.workContextLabel,/Building A.*East block.*Ground floor.*North zone/);
 const inherited=await request('/cost-heads',headBody({name:'Task materials',phase_id:h.phaseId,task_id:task.id}));assert.equal(inherited.status,201);assert.equal(inherited.body.data.workPackageId,pack.id);assert.equal(inherited.body.data.locationId,floor.id);
 const otherPack=await workPackage(h.phaseId,zone.id,'North zone brickwork');const other=await request('/cost-heads',headBody({name:'Scoped materials',phase_id:h.phaseId,work_package_id:otherPack.id}));assert.equal(other.status,201);assert.notEqual(other.body.data.workScopeKey,budget.body.data.workScopeKey);
});
test('work structure rejects foreign references, reversed location nesting, duplicate names and task/package mismatch',async()=>{
 const h=await newHead(),building=await workLocation(),floor=await workLocation('Floor one','floor',building.id),pack=await workPackage(h.phaseId,floor.id),task=await workTask(pack),pack2=await workPackage(h.phaseId,null,'Second package');
 for(const b of [{name:'Wrong',kind:'building',parent_id:floor.id},{name:'Wrong',kind:'floor',parent_id:'foreign'}])assert.ok((await request('/locations',{...b,request_key:workKey()})).status>=400);
 assert.equal((await request('/work-packages',{name:'Foreign phase',description:'',phase_id:'foreign',location_id:null,request_key:workKey()})).status,404);
 assert.equal((await request('/work-packages',{name:'Foreign location',description:'',phase_id:h.phaseId,location_id:'foreign',request_key:workKey()})).status,404);
 assert.equal((await request('/tasks',{name:'Foreign package',description:'',work_package_id:'foreign',request_key:workKey()})).status,404);
 assert.equal((await request('/locations',{name:building.name,kind:'building',parent_id:null,request_key:workKey()})).status,409);
 assert.equal((await request('/cost-heads',headBody({phase_id:h.phaseId,work_package_id:pack2.id,task_id:task.id}))).status,400);
 const otherHead=await newHead({phase:'Roof',name:'Roof materials'});
 assert.equal((await request('/cost-heads',headBody({phase:undefined,phase_id:otherHead.phaseId,work_package_id:pack.id}))).status,400);
 const anotherBuilding=await workLocation('Building B');assert.equal((await request('/cost-heads',headBody({phase_id:h.phaseId,work_package_id:pack.id,location_id:anotherBuilding.id}))).status,400);
});
test('structure creates bind retry keys to actor and payload; edits reject stale revisions and parent changes',async()=>{
 const b={name:'Building A',kind:'building',parent_id:null,request_key:workKey()},first=await request('/locations',b);
 assert.equal((await request('/locations',b)).body.data.id,first.body.data.id);assert.equal((await request('/locations',{...b,name:'Changed'})).status,409);
 assert.equal((await request('/locations',b,'admin')).status,409);
 const row=first.body.data,attempts=await Promise.all([request(`/locations/${row.id}`,workUpdate(row,{name:'Updated'}),'accountant','PUT'),request(`/locations/${row.id}`,workUpdate(row,{name:'Other update'}),'accountant','PUT')]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
 assert.equal((await request(`/locations/${row.id}`,{...workUpdate(row),revision:2,parent_id:'other'},'accountant','PUT')).status,400);
});
test('archiving preserves history, blocks new work and requires archiving children before parents',async()=>{
 const h=await newHead(),building=await workLocation(),floor=await workLocation('Floor one','floor',building.id),pack=await workPackage(h.phaseId,floor.id),task=await workTask(pack);
 assert.equal((await request(`/locations/${building.id}`,workUpdate(building,{is_active:false}),'accountant','PUT')).status,409);
 assert.equal((await request(`/work-packages/${pack.id}`,workUpdate(pack,{is_active:false}),'accountant','PUT')).status,409);
 assert.equal((await request(`/tasks/${task.id}`,workUpdate(task,{is_active:false}),'accountant','PUT')).status,200);
 assert.equal((await request('/cost-heads',headBody({task_id:task.id}))).status,400);
 assert.equal((await request(`/work-packages/${pack.id}`,workUpdate(pack,{is_active:false}),'accountant','PUT')).status,200);
 assert.equal((await request(`/tasks/${task.id}`,workUpdate(task,{revision:2}),'accountant','PUT')).status,400);
 assert.equal((await request(`/locations/${floor.id}`,workUpdate(floor,{is_active:false}),'accountant','PUT')).status,200);
 assert.equal((await request(`/work-packages/${pack.id}`,workUpdate(pack,{revision:2}),'accountant','PUT')).status,400);
 assert.equal((await request('/structure')).body.data.tasks.length,1);
});
test('site log scope is canonical, rejects inconsistent phase budgets and revalidates before posting',async()=>{
 const h=await newHead(),floor=await workLocation('Floor one','floor'),pack=await workPackage(h.phaseId,floor.id),task=await workTask(pack);
 const r=await request('/site-logs',{work_date:'2026-01-01',version:0,content:siteContent(h,{task_id:task.id,context_label:'untrusted label'})},'accountant','PUT');assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.data.content.work_package_id,pack.id);assert.equal(r.body.data.content.phase_id,h.phaseId);assert.match(r.body.data.content.context_label,/Foundation.*Lay bricks.*Floor one/);
 const other=await newHead({phase:'Roof',name:'Roof materials'});
 assert.equal((await request('/site-logs',{work_date:'2026-01-02',version:0,content:siteContent(other,{work_package_id:pack.id})},'accountant','PUT')).status,400);
 assert.equal((await request(`/tasks/${task.id}`,workUpdate(task,{is_active:false}),'accountant','PUT')).status,200);
 assert.equal((await request(`/site-logs/${r.body.data.id}/submit`,{version:r.body.data.version})).status,400);assert.equal(db.labor.length,0);
});
test('site scope rejects cost heads in another package or task and keeps the original label after rename',async()=>{
 const h=await newHead(),pack=await workPackage(h.phaseId),task=await workTask(pack),other=await workPackage(h.phaseId,null,'Other package');
 const scoped=await newHead({name:'Package wages',phase_id:h.phaseId,work_package_id:other.id});
 assert.equal((await request('/site-logs',{work_date:'2026-01-01',version:0,content:siteContent(scoped,{task_id:task.id})},'accountant','PUT')).status,400);
 const saved=await request('/site-logs',{work_date:'2026-01-01',version:0,content:siteContent(h,{task_id:task.id})},'accountant','PUT');assert.equal(saved.status,200);
 assert.equal((await request(`/tasks/${task.id}`,workUpdate(task,{name:'Renamed task'}),'accountant','PUT')).status,200);
 const logs=await request('/site-logs?from=2026-01-01&to=2026-01-01');assert.match(logs.body.data[0].content.context_label,/Lay bricks/);
 const submitted=await request(`/site-logs/${saved.body.data.id}/submit`,{version:saved.body.data.version});assert.equal(submitted.status,201,JSON.stringify(submitted.body));assert.match(submitted.body.data.content.context_label,/Lay bricks/);assert.equal((await request(`/site-logs/${saved.body.data.id}/submit`,{version:saved.body.data.version})).status,201);assert.equal(db.labor.length,1);
});
test('structure writes require financial writer access; reads stay project scoped and audited writes roll back',async()=>{
 const b={name:'Building A',kind:'building',parent_id:null,request_key:workKey()};
 for(const role of ['auditor','cashier','approver','member'])assert.equal((await request('/locations',b,role)).status,403);
 assert.equal((await request('/structure',undefined,'auditor')).status,200);assert.equal((await request('/structure',undefined,'member')).status,403);assert.equal((await request('/structure',undefined,'admin','GET','foreign')).status,403);
 failAudit=true;const old=console.error;console.error=()=>{};try{assert.equal((await request('/locations',b)).status,500);}finally{console.error=old;}assert.equal(db.workLocations.length,0);
});

const controlConfig={scheduling:true,progress:true,advanced_boq:true,calendar:{weekdays:[1,2,3,4,5],holidays:['2026-01-05']}};
async function configureControls(config=controlConfig){const current=(await request('/control')).body.data.settings;const r=await request('/control/settings',{revision:current.revision,config},'owner','PUT');assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;}
const lineBody=(head,extra={})=>({id:randomUUID(),cost_head_id:head.id,name:'Foundation concrete',unit:'m3',quantity:10,rate:100,rate_mode:'manual',resources:[],...extra});
async function controlBaseline(head,extra={}){const lines=[lineBody(head,extra)],r=await request('/control/boq',{base_id:null,lines,note:'First work baseline',request_key:randomUUID()});assert.equal(r.status,201,JSON.stringify(r.body));await controlDecision(r.body.data.id);return {version:r.body.data,line:lines[0]};}
async function controlDecision(id,kind='versions',decision='approve'){const r=await request(`/control/${kind}/${id}/decision`,{decision,note:'Engineer independently checked'},'approver');assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;}
const measurementBody=(line,quantity,extra={})=>({boq_id:line.id,quantity,measurement_date:'2026-01-06',evidence_file_ids:[],note:'Measured on site',request_key:randomUUID(),...extra});
test('site controls default off; configuration is owner-only, revision checked, and reads make no writes',async()=>{
 const first=await request('/control');assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data.settings.revision,0);assert.equal(first.body.data.settings.config.progress,false);assert.equal(db.controlSettings.length,0);
 const b={revision:0,config:controlConfig};for(const role of ['accountant','approver','auditor','member'])assert.equal((await request('/control/settings',b,role,'PUT')).status,403);
 assert.equal((await request('/control/settings',{...b,config:{...controlConfig,advanced_boq:false}},'owner','PUT')).status,400);
 await configureControls();assert.equal((await request('/control/settings',b,'owner','PUT')).status,409);
 const {canConfigureControl}=await import('../dist/modules/construction/construction.control.routes.js');assert.equal(canConfigureControl({roles:['admin'],builtinRoles:[],menuPermissions:{construction_control:{write:true}}}),false);
 assert.equal((await request('/control',undefined,'member')).status,403);assert.equal((await request('/control',undefined,'owner','GET','foreign')).status,403);
});
test('schedule proposals require enabled controls, scoped tasks, independent approval and current calendar',async()=>{
 const h=await newHead(),pack=await workPackage(h.phaseId),a=await workTask(pack,'Excavate'),b=await workTask(pack,'Concrete');
 const body={base_id:null,anchor:'2026-01-02',tasks:[{task_id:a.id,duration:2,dependencies:[]},{task_id:b.id,duration:2,dependencies:[{task_id:a.id,type:'FS',lag:0}],delay_reason:'Rain allowance'}],note:'Initial sequence',request_key:randomUUID()};
 assert.equal((await request('/control/schedule',body)).status,400);await configureControls();
 assert.equal((await request('/control/schedule',{...body,tasks:[{...body.tasks[0],task_id:'foreign'}]})).status,404);
 const first=await request('/control/schedule',body);assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(first.body.data.payload.plan.finish,'2026-01-08');assert.equal((await request('/control/schedule',body)).body.data.id,first.body.data.id);
 assert.equal((await request(`/control/versions/${first.body.data.id}/decision`,{decision:'approve',note:'Checked myself'},'admin','POST','p','user-accountant')).status,409);
 const second=await request('/control/schedule',{...body,request_key:randomUUID()});await controlDecision(first.body.data.id);assert.equal((await request(`/control/versions/${second.body.data.id}/decision`,{decision:'approve',note:'Checked scope'},'approver')).status,409);
 const fresh=await request('/control/schedule',{...body,base_id:first.body.data.id,request_key:randomUUID()});await configureControls({...controlConfig,calendar:{weekdays:[0,1,2,3,4,5,6],holidays:[]}});
 assert.equal((await request(`/control/versions/${fresh.body.data.id}/decision`,{decision:'approve',note:'Checked scope'},'approver')).status,409);
});
test('approved BOQ recipes and imports preserve IDs, show comparisons and protect direct edits',async()=>{
 await configureControls();const h=await newHead();db.inventory.push({id:'cement',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:0,costPrice:500,isActive:true});
 const {line,version}=await controlBaseline(h,{rate_mode:'recipe',rate:0,resources:[{kind:'material',item_id:'cement',name:'Cement',unit:'bag',quantity_per_unit:1.25,rate:500},{kind:'labor',name:'Mason',unit:'day',quantity_per_unit:.5,rate:800}]});
 assert.equal(db.boq[0].rate,1025);assert.equal(db.boq[0].estimated,10250);
 const preview=await request('/control/boq/import-preview',{rows:[{id:'',name:line.name,cost_head:h.name,unit:'m3',quantity:'12',rate:'1100'}]});assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.data.valid,true);assert.equal(preview.body.data.lines[0].id,line.id);assert.equal(preview.body.data.comparison[0].quantity_change,2);
 const bad=await request('/control/boq/import-preview',{rows:[{name:'New',cost_head_id:'foreign',unit:'m3',quantity:'1',rate:'2'}]});assert.equal(bad.body.data.valid,false);assert.equal(bad.body.data.issues[0].row,2);
 assert.equal((await request('/boq',{cost_head_id:h.id,name:'Direct',unit:'m3',quantity:1,rate:1})).status,409);assert.equal((await request('/boq')).body.data[0].baselineProtected,true);
 assert.equal((await request('/control/boq',{base_id:null,lines:[line],note:'Stale revision',request_key:randomUUID()})).status,409);
 assert.equal((await request('/control/boq',{base_id:version.id,lines:[{...line,resources:[{kind:'material',item_id:'cement',name:'Cement',unit:'kg',quantity_per_unit:1,rate:1}]}],note:'Wrong unit',request_key:randomUUID()})).status,400);
});
test('only independent certified quantities count; competing approvals cannot over-certify',async()=>{
 await configureControls();const h=await newHead(),pack=await workPackage(h.phaseId),task=await workTask(pack),{line,version}=await controlBaseline(h,{task_id:task.id});
 const body=measurementBody(line,7),a=await request('/control/measurements',body),b=await request('/control/measurements',measurementBody(line,6));assert.equal(a.status,201,JSON.stringify(a.body));assert.equal((await request('/control/measurements',body)).body.data.id,a.body.data.id);assert.equal((await request('/control')).body.data.progress.percent,0);
 assert.equal((await request(`/control/measurements/${a.body.data.id}/decision`,{decision:'approve',note:'Own work'},'admin','POST','p','user-accountant')).status,409);
 const decisions=await Promise.all([request(`/control/measurements/${a.body.data.id}/decision`,{decision:'approve',note:'Measured check'},'approver'),request(`/control/measurements/${b.body.data.id}/decision`,{decision:'approve',note:'Measured check'},'approver')]);assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
 let p=(await request('/control')).body.data.progress;assert.equal(p.percent,70);assert.equal(p.planned_percent,null);
 assert.equal((await request('/control/completions',{phase_id:h.phaseId,measurement_date:'2026-01-06',evidence_file_ids:[],note:'Complete scope',request_key:randomUUID()})).status,409);
 const extra=await request('/control/measurements',measurementBody(line,3));await controlDecision(extra.body.data.id,'measurements');
 const cert=await request('/control/completions',{phase_id:h.phaseId,measurement_date:'2026-01-06',evidence_file_ids:[],note:'Complete scope',request_key:randomUUID()});assert.equal(cert.status,201);await controlDecision(cert.body.data.id,'measurements');assert.equal((await request('/control')).body.data.progress.phases[0].certified_complete,true);
 const correction=await request('/control/measurements',measurementBody(line,1,{reverses_id:a.body.data.id}));assert.equal(correction.status,201,JSON.stringify(correction.body));assert.equal(correction.body.data.quantity,-1);await controlDecision(correction.body.data.id,'measurements');p=(await request('/control')).body.data.progress;assert.equal(p.percent,90);assert.equal(p.phases[0].certified_complete,false);
 assert.equal((await request('/control/boq',{base_id:version.id,lines:[{...line,quantity:8}],note:'Reduce certified work',request_key:randomUUID()})).status,409);
 assert.equal((await request('/control/measurements',measurementBody(line,7,{reverses_id:a.body.data.id}))).status,409);
 assert.equal((await request('/control/measurements',measurementBody(line,1,{evidence_file_ids:['foreign-file']}))).status,404);
});
for(const method of ['weighted_average','fifo'])test(`${method} values consumption, partial returns and wastage once while cash is unchanged`,async()=>{
 const h=await newHead();db.inventory.push({id:'cement',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:10,costPrice:100,isActive:true});db.expenses.push({id:'e',tenantId:'t',projectId:'p',title:'Opening materials',status:'paid',amount:1000});db.allocations.push({id:'allocation',tenantId:'t',projectId:'p',expenseId:'e',costHeadId:h.id,boqId:null,amount:1000});
 const snapshot=(await request('/control')).body.data,b={method,revision:0,preview_hash:snapshot.valuation.opening.preview_hash,opening:[{item_id:'cement',location_id:'main',quantity:10,unit_cost:100,cost_head_id:h.id}],request_key:randomUUID()};
 assert.equal((await request('/control/valuation/activate',b,'accountant')).status,403);
 const activation=await request('/control/valuation/activate',b,'owner');assert.equal(activation.status,200,JSON.stringify(activation.body));assert.equal((await request('/control/valuation/activate',b,'owner')).status,200);assert.equal(db.valuationLayers.length,1);
 let report=(await request('/overview')).body.data;assert.equal(report.actual_cost,0);assert.equal(report.cash_paid,1000);assert.equal(report.material_valuation.inventory_value,1000);
 const consume={item_id:'cement',kind:'consume',quantity:3,cost_head_id:h.id,entry_date:'2026-01-06',reason:'Concrete pour',request_key:randomUUID()},used=await request('/materials',consume);assert.equal(used.status,201,JSON.stringify(used.body));assert.equal((await request('/materials',consume)).body.data.id,used.body.data.id);
 report=(await request('/overview')).body.data;assert.equal(report.actual_cost,300);assert.equal(report.material_valuation.wip_value,300);assert.equal(report.material_valuation.inventory_value,700);assert.equal(report.cash_paid,1000);
 const ret=await request('/materials',{item_id:'cement',kind:'return',source_id:used.body.data.id,quantity:1,entry_date:'2026-01-07',reason:'Unused cement',request_key:randomUUID()});assert.equal(ret.status,201,JSON.stringify(ret.body));
 const waste=await request('/materials',{item_id:'cement',kind:'waste',cost_head_id:h.id,quantity:1,entry_date:'2026-01-07',reason:'Damaged bag',request_key:randomUUID()});assert.equal(waste.status,201,JSON.stringify(waste.body));
 report=(await request('/overview')).body.data;assert.equal(report.actual_cost,300);assert.equal(report.material_valuation.wip_value,200);assert.equal(report.material_valuation.loss_value,100);assert.equal(report.material_valuation.inventory_value,700);assert.equal(report.cash_paid,1000);assert.equal(db.accounts[0].balance,5000000);
 assert.equal((await request('/materials',{...consume,request_key:randomUUID(),cost_head_id:undefined})).status,400);
 assert.equal((await request('/control/valuation/activate',{...b,request_key:randomUUID()},'owner')).status,409);
});
test('opening review rejects stale stock, unknown stores, duplicate rows and excessive source value without mutations',async()=>{
 const h=await newHead();db.inventory.push({id:'cement',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:10,costPrice:100,isActive:true});db.expenses.push({id:'e',tenantId:'t',projectId:'p',status:'approved',amount:1000});
 let snapshot=(await request('/control')).body.data;const b={method:'fifo',revision:0,preview_hash:snapshot.valuation.opening.preview_hash,opening:[{item_id:'cement',location_id:'main',quantity:10,unit_cost:101,cost_head_id:null}],request_key:randomUUID()};
 assert.equal((await request('/control/valuation/activate',b,'owner')).status,400);assert.equal(db.valuationLayers.length,0);
 db.inventory[0].quantity=9;assert.equal((await request('/control/valuation/activate',{...b,opening:[{...b.opening[0],unit_cost:100}]},'owner')).status,409);
 snapshot=(await request('/control')).body.data;const refreshed={...b,preview_hash:snapshot.valuation.opening.preview_hash,opening:[{...b.opening[0],quantity:9,unit_cost:100,location_id:'foreign'}]};assert.equal((await request('/control/valuation/activate',refreshed,'owner')).status,409);assert.equal(db.reclassifications.length,0);
});
test('FIFO and weighted-average distinguish receipt costs and restore exact values across multiple returns',async()=>{
 const {recordStockValue,valuationAdjustments}=await import('../dist/modules/construction/construction.valuation.js');
 const a={tenantId:'t',projectId:'p',userId:'owner'},h=await newHead();db.inventory.push({id:'i',tenantId:'t',projectId:'p',costPrice:999,isActive:true});
 for(const method of ['fifo','weighted_average']){
  db.projects[0].constructionValuationMethod=method;db.valuationLayers=[];db.valuationEntries=[];
  const move=(id,quantity,ref='receipt')=>({id,itemId:'i',locationId:'main',quantity,referenceType:ref,referenceId:id,createdAt:new Date(`2026-01-0${id==='r1'?1:2}T00:00:00Z`)});
  await recordStockValue(prisma,a,move('r1',3),{unitCost:1});await recordStockValue(prisma,a,move('r2',3),{unitCost:2});
  const used=await recordStockValue(prisma,a,move('use',-4,'construction_consume'),{costHeadId:h.id});assert.equal(used.valueMicro,method==='fifo'?'-5000000':'-6000000');
  let total=0n;for(let i=0;i<4;i++){const ret=await recordStockValue(prisma,a,move(`ret${i}`,1,'construction_return'),{sourceReferenceId:'use'});total+=BigInt(ret.valueMicro);}assert.equal(total,-BigInt(used.valueMicro));
  const adj=await valuationAdjustments(prisma,a);assert.equal(adj.inventory,9000000n);assert.equal(adj.wip,0n);assert.equal((await recordStockValue(prisma,a,move('use',-4,'construction_consume'),{costHeadId:h.id})).journalId,used.journalId);
  await assert.rejects(recordStockValue(prisma,a,move('extra',1,'construction_return'),{sourceReferenceId:'use'}),/exceeds/);
 }
});

test('valued purchase-linked supplier bills move acquisition into goods in transit, inventory and BOQ WIP once',async()=>{
 const h=await newHead(),boq=(await request('/boq',{cost_head_id:h.id,name:'Concrete work',unit:'m3',quantity:10,rate:100})).body.data;
 const snapshot=(await request('/control')).body.data;assert.equal((await request('/control/valuation/activate',{method:'fifo',revision:0,preview_hash:snapshot.valuation.opening.preview_hash,opening:[],request_key:randomUUID()},'owner')).status,200);
 db.vendors.push({id:'v',tenantId:'t',projectId:'p',name:'Supplier',isActive:true});db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:0,costPrice:0,isActive:true});db.purchases.push({id:'purchase',tenantId:'t',projectId:'p',vendorId:'v',status:'ordered',totalAmount:1000,lines:[{itemId:'i',quantity:10,unitCost:100}]});
 const r=await request('/supplier-bills',{vendor_id:'v',cost_head_id:h.id,boq_id:boq.id,purchase_id:'purchase',number:'SUP-VALUED',description:'Cement purchase',amount:1000,bill_date:'2026-01-01',request_key:randomUUID()});assert.equal(r.status,201,JSON.stringify(r.body));await approve('supplier-bills',r.body.data);
 let report=(await request('/overview')).body.data;assert.equal(report.actual_cost,0);assert.equal(report.boq[0].actual,0);assert.equal(report.material_valuation.in_transit_value,1000);assert.equal(report.unpaid_liabilities,1000);
 await request(`/supplier-bills/${r.body.data.id}/receive`,{});await request(`/supplier-bills/${r.body.data.id}/receive`,{});
 report=(await request('/overview')).body.data;assert.equal(report.material_valuation.in_transit_value,0);assert.equal(report.material_valuation.inventory_value,1000);assert.equal(report.cash_paid,0);assert.equal(db.stock.length,1);
 const used=await request('/materials',{item_id:'i',boq_id:boq.id,kind:'consume',quantity:4,entry_date:'2026-01-06',reason:'Concrete pour',request_key:randomUUID()});assert.equal(used.status,201,JSON.stringify(used.body));
 report=(await request('/overview')).body.data;assert.equal(report.actual_cost,400);assert.equal(report.boq[0].actual,400);assert.equal(report.boq[0].acquisition_cost,1000);assert.equal(report.material_valuation.wip_value,400);assert.equal(report.material_valuation.inventory_value,600);assert.equal(report.cash_paid,0);
 await request('/payments',payBody('supplier_bill',{supplier_bill_id:r.body.data.id},1000));report=(await request('/overview')).body.data;assert.equal(report.actual_cost,400);assert.equal(report.cash_paid,1000);assert.equal(report.unpaid_liabilities,0);
});
test('valued stock and WIP roll back together when audit fails',async()=>{
 const h=await newHead();db.projects[0].constructionValuationMethod='fifo';db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:10,costPrice:100,isActive:true});db.valuationLayers.push({id:'layer',tenantId:'t',projectId:'p',itemId:'i',locationId:'main',remainingQuantity:10,valueMicro:'1000000000',sortAt:new Date()});
 failAudit=true;const old=console.error;console.error=()=>{};try{assert.equal((await request('/materials',{item_id:'i',cost_head_id:h.id,kind:'consume',quantity:4,entry_date:'2026-01-06',reason:'Concrete pour',request_key:randomUUID()})).status,500);}finally{console.error=old;}
 assert.equal(db.inventory[0].quantity,10);assert.equal(db.stock.length,0);assert.equal(db.materials.length,0);assert.equal(db.valuationEntries.length,0);assert.equal(db.valuationLayers[0].remainingQuantity,10);assert.equal(db.valuationLayers[0].valueMicro,'1000000000');
});
test('planned and physical progress are BOQ value weighted and a revised baseline invalidates prior completion',async()=>{
 await configureControls();const h=await newHead(),pack=await workPackage(h.phaseId),task=await workTask(pack),lines=[lineBody(h,{task_id:task.id,quantity:10,rate:100}),lineBody(h,{task_id:task.id,name:'Second work',quantity:10,rate:300})];
 const b=await request('/control/boq',{base_id:null,lines,note:'Weighted baseline',request_key:randomUUID()});await controlDecision(b.body.data.id);
 const s=await request('/control/schedule',{base_id:null,anchor:'2026-01-02',tasks:[{task_id:task.id,duration:2,dependencies:[]}],note:'Planned task',request_key:randomUUID()});await controlDecision(s.body.data.id);
 const m=await request('/control/measurements',measurementBody(lines[0],10));await controlDecision(m.body.data.id,'measurements');let p=(await request('/control')).body.data.progress;assert.equal(p.percent,25);assert.equal(p.planned_percent,100);
 const m2=await request('/control/measurements',measurementBody(lines[1],10));await controlDecision(m2.body.data.id,'measurements');const cert=await request('/control/completions',{task_id:task.id,measurement_date:'2026-01-06',evidence_file_ids:[],note:'Task complete',request_key:randomUUID()});assert.equal(cert.status,201);await controlDecision(cert.body.data.id,'measurements');p=(await request('/control')).body.data.progress;assert.equal(p.tasks[0].certified_complete,true);
 const revised=await request('/control/boq',{base_id:b.body.data.id,lines:lines.map(l=>({...l,quantity:12})),note:'Extra approved work',request_key:randomUUID()});await controlDecision(revised.body.data.id);p=(await request('/control')).body.data.progress;assert.equal(p.tasks[0].certified_complete,false);assert.ok(p.percent<100);
});

test('reviewed opening BOQ credits stay fixed when later costs are allocated',async()=>{
 const h=await newHead(),boq=(await request('/boq',{cost_head_id:h.id,name:'Concrete work',unit:'m3',quantity:10,rate:100})).body.data;
 db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:10,costPrice:100,isActive:true});db.expenses.push({id:'old',tenantId:'t',projectId:'p',status:'paid',amount:1000});db.allocations.push({id:'allocation',tenantId:'t',projectId:'p',expenseId:'old',costHeadId:h.id,boqId:boq.id,amount:1000});
 const p=(await request('/control')).body.data.valuation.opening;assert.equal((await request('/control/valuation/activate',{method:'fifo',revision:0,preview_hash:p.preview_hash,opening:[{item_id:'i',location_id:'main',quantity:10,unit_cost:100,cost_head_id:h.id}],request_key:randomUUID()},'owner')).status,200);
 assert.equal((await request('/overview')).body.data.boq[0].actual,0);
 db.expenses.push({id:'later',tenantId:'t',projectId:'p',status:'paid',amount:200});assert.equal((await request('/allocations',{expense_id:'later',cost_head_id:h.id,boq_id:boq.id,amount:200,request_key:randomUUID()})).status,201);
 const r=(await request('/overview')).body.data;assert.equal(r.boq[0].actual,200);assert.equal(r.actual_cost,200);assert.equal(r.material_valuation.inventory_value,1000);
});
test('historical unallocated opening sources cannot be reallocated after activation',async()=>{
 const h=await newHead();db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:10,costPrice:100,isActive:true});db.expenses.push({id:'old',tenantId:'t',projectId:'p',status:'paid',amount:1000});
 const p=(await request('/control')).body.data.valuation.opening;assert.equal((await request('/control/valuation/activate',{method:'fifo',revision:0,preview_hash:p.preview_hash,opening:[{item_id:'i',location_id:'main',quantity:10,unit_cost:100,cost_head_id:null}],request_key:randomUUID()},'owner')).status,200);
 assert.equal((await request('/allocations',{expense_id:'old',cost_head_id:h.id,amount:100,request_key:randomUUID()})).status,409);assert.equal((await request('/overview')).body.data.actual_cost,0);
});

const workflowConfig={...controlConfig,procurement:true,receipt_checks:true,scope_changes:true};
async function workflowSetup(){await configureControls(workflowConfig);token('approver','p','engineer');}
const workflowDecision=(kind,id,decision='approve',user='engineer')=>request(`/control/${kind}/${id}/decision`,{decision,note:'Independently reviewed on site'},'approver','POST','p',user);
async function makeRequest(head,extra={}){db.inventory.push({id:'material',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:0,costPrice:0,isActive:true});db.vendors.push({id:'supplier',tenantId:'t',projectId:'p',name:'Supplier A',isActive:true});const body={title:'Footing materials',cost_head_id:head.id,required_by:'2026-11-10',urgency:'urgent',approver_id:'engineer',note:'Material for footing work',evidence_file_ids:[],lines:[{id:randomUUID(),item_id:'material',quantity:10,note:'Dry sealed bags'}],request_key:randomUUID(),...extra};const r=await request('/control/requisitions',body);assert.equal(r.status,201,JSON.stringify(r.body));return {row:r.body.data,body};}
async function makeQuote(req,extra={}){const body={requisition_id:req.id,vendor_id:'supplier',number:`QUOTE-${randomUUID()}`,lines:req.lines.map(l=>({requisition_line_id:l.id,unit_cost:100})),charges:0,delivery_date:'2026-11-09',valid_until:'2099-01-01',terms:'Delivery and unloading included',evidence_file_ids:[],request_key:randomUUID(),...extra};const r=await request('/control/quotes',body);assert.equal(r.status,201,JSON.stringify(r.body));return {row:r.body.data,body};}
async function controlledFixture({charges=0,valued=false}={}){await workflowSetup();const h=await newHead();if(valued){const preview=(await request('/control')).body.data;assert.equal((await request('/control/valuation/activate',{method:'fifo',revision:preview.settings.revision,preview_hash:preview.valuation.opening.preview_hash,opening:[],request_key:randomUUID()},'owner')).status,200);}
 const req=await makeRequest(h);assert.equal((await workflowDecision('requisitions',req.row.id)).status,200);const q=await makeQuote(req.row,{charges}),award=await request('/control/awards',{requisition_id:req.row.id,quote_id:q.row.id,location_id:'main',approver_id:'engineer',note:'Best valid delivered quote',request_key:randomUUID()});assert.equal(award.status,201,JSON.stringify(award.body));const approved=await workflowDecision('awards',award.body.data.id);assert.equal(approved.status,200,JSON.stringify(approved.body));const snapshot=await request('/control/workflows');assert.equal(snapshot.status,200,JSON.stringify(snapshot.body));return {h,req:req.row,quote:q.row,award:approved.body.data,order:snapshot.body.data.orders.find(o=>o.id===approved.body.data.purchaseId)};
}
async function logDelivery(order,quantity=6,extra={}){const r=await request('/control/deliveries',{purchase_id:order.id,challan_number:`CH-${randomUUID()}`,delivery_date:'2026-01-06',location_id:'main',lines:[{purchase_line_id:order.lines[0].id,delivered:quantity,note:'Sealed bags on vehicle'}],approver_id:'engineer',note:'Transport and quantity noted',evidence_file_ids:[],request_key:randomUUID(),...extra});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
const qualityBody=(delivery,accepted,extra={})=>({decision:'approve',note:'Quantity and quality independently checked',lines:delivery.lines.map(l=>({purchase_line_id:l.purchase_line_id,accepted,rejected:l.delivered-accepted,quality:accepted?'pass':'fail',quantity_checked:true,specification_checked:true,damage_checked:true,note:l.delivered>accepted?'Damaged bags rejected':'Good condition'})),...extra});
const checkReceipt=(d,accepted,extra={},who='engineer')=>request(`/control/deliveries/${d.id}/check`,qualityBody(d,accepted,extra),'approver','POST','p',who);
async function logInvoice(order,quantity,extra={}){const r=await request('/control/invoices',{purchase_id:order.id,number:`INV-${randomUUID()}`,invoice_date:'2026-01-06',lines:quantity?[{purchase_line_id:order.lines[0].id,quantity,unit_cost:order.lines[0].unitCost}]:[],charges:0,note:'Supplier invoice evidence checked',approver_id:'engineer',evidence_file_ids:[],request_key:randomUUID(),...extra});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
test('requisitions are optional, date/urgency scoped, retry safe and routed to a named independent approver',async()=>{
 const h=await newHead();token('approver','p','engineer');db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',unit:'bag',quantity:0,isActive:true});const b={title:'Materials request',cost_head_id:h.id,required_by:'2026-11-01',urgency:'critical',note:'Required for footing',evidence_file_ids:[],approver_id:'engineer',lines:[{id:'line',item_id:'i',quantity:5,note:''}],request_key:randomUUID()};
 assert.equal((await request('/control/requisitions',b)).status,400);await workflowSetup();const r=await request('/control/requisitions',b);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.data.requiredBy.slice(0,10),b.required_by);assert.equal((await request('/control/requisitions',b)).body.data.id,r.body.data.id);assert.equal((await request('/control/requisitions',{...b,urgency:'routine'})).status,409);
 assert.equal((await request('/control/requisitions',{...b,request_key:randomUUID(),approver_id:'user-accountant'})).status,400);assert.equal((await request('/control/requisitions',{...b,request_key:randomUUID(),approver_id:'foreign'})).status,400);assert.equal((await request('/control/requisitions',{...b,request_key:randomUUID(),lines:[{...b.lines[0],item_id:'foreign'}]})).status,404);
 assert.equal((await workflowDecision('requisitions',r.body.data.id,'approve','other-approver')).status,403);assert.equal((await workflowDecision('requisitions',r.body.data.id)).status,200);assert.equal((await request('/control/requisitions',b,'auditor')).status,403);assert.equal((await request('/control/workflows',undefined,'member')).status,403);
});
test('supplier comparison is like-for-like and competing award approvals create only one PO',async()=>{
 await workflowSetup();const h=await newHead(),req=await makeRequest(h);assert.equal((await request('/control/quotes',{requisition_id:req.row.id,vendor_id:'supplier',number:'EARLY',lines:[{requisition_line_id:req.row.lines[0].id,unit_cost:100}],charges:0,delivery_date:'2026-11-12',valid_until:'2099-01-01',terms:'Payment on receipt',evidence_file_ids:[],request_key:randomUUID()})).status,404);await workflowDecision('requisitions',req.row.id);
 const q=await makeQuote(req.row,{delivery_date:'2026-11-12',charges:50});assert.equal((await request('/control/quotes',q.body)).body.data.id,q.row.id);assert.equal((await request('/control/quotes',{...q.body,request_key:randomUUID(),lines:[...q.body.lines,...q.body.lines]})).status,400);
 const compare=(await request('/control/workflows')).body.data;assert.equal(compare.requisitions[0].quotes[0].late_days,2);assert.equal(compare.requisitions[0].quotes[0].total,1050);assert.equal(compare.requisitions[0].quotes[0].expired,false);
 const b={requisition_id:req.row.id,quote_id:q.row.id,location_id:'main',approver_id:'engineer',note:'Best available supplier',request_key:randomUUID()},first=await request('/control/awards',b),second=await request('/control/awards',{...b,request_key:randomUUID()});const decisions=await Promise.all([workflowDecision('awards',first.body.data.id),workflowDecision('awards',second.body.data.id)]);assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);assert.equal(db.purchases.length,1);assert.equal(db.purchaseLines.length,1);assert.equal(db.inventory[0].quantity,0);assert.equal(db.accounts[0].balance,5000000);
});
test('partial challans add only accepted stock; rejected quantities stay outstanding and legacy shortcuts are blocked',async()=>{
 const {order,h}=await controlledFixture(),d=await logDelivery(order,6);assert.equal(db.inventory[0].quantity,0);const body=qualityBody(d,4),unchecked={...body,lines:body.lines.map(l=>({...l,damage_checked:false}))};assert.equal((await request(`/control/deliveries/${d.id}/check`,unchecked,'approver','POST','p','engineer')).status,400);assert.equal((await checkReceipt(d,4,{},'other-reviewer')).status,403);
 assert.equal((await checkReceipt(d,4)).status,200);assert.equal((await checkReceipt(d,4)).status,200);assert.equal(db.inventory[0].quantity,4);assert.equal(db.stock.length,1);let snapshot=(await request('/control/workflows')).body.data;assert.equal(snapshot.orders[0].receipts[0].outstanding,6);assert.equal(snapshot.orders[0].receipts[0].rejected,2);
 assert.equal((await request(`/purchases/${order.id}/receive`,{account_id:'a'})).status,400);assert.equal((await request(`/purchases/${order.id}/cancel`,{})).status,400);assert.equal((await request('/supplier-bills',{vendor_id:'supplier',cost_head_id:h.id,purchase_id:order.id,number:'BYPASS',description:'Old receipt route',amount:1000,bill_date:'2026-01-06',request_key:randomUUID()})).status,409);
 const more=await logDelivery(order,7);assert.equal((await checkReceipt(more,7)).status,409);assert.equal(db.inventory[0].quantity,4);assert.equal((await checkReceipt(more,6)).status,200);assert.equal(db.inventory[0].quantity,10);snapshot=(await request('/control/workflows')).body.data;assert.equal(snapshot.orders[0].status,'received');assert.equal(snapshot.orders[0].receipts[0].outstanding,0);assert.equal(db.accounts[0].balance,5000000);
});
test('competing quality checks cannot accept more than the purchase balance',async()=>{
 const {order}=await controlledFixture(),a=await logDelivery(order,7),b=await logDelivery(order,7);const results=await Promise.all([checkReceipt(a,7),checkReceipt(b,7)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(db.inventory[0].quantity,7);assert.equal(db.stock.length,1);
});
test('line-level invoice matching blocks prices and unreceived quantities, accrues partial receipts and pays separately',async()=>{
 const {order}=await controlledFixture({charges:100}),d=await logDelivery(order,6);await checkReceipt(d,4);let report=(await request('/overview')).body.data;assert.equal(report.actual_cost,400);assert.equal(report.unpaid_liabilities,400);assert.equal(report.received_not_invoiced,400);assert.equal(report.cash_paid,0);
 const bad=await logInvoice(order,5),wrongPrice=await logInvoice(order,4,{lines:[{purchase_line_id:order.lines[0].id,quantity:4,unit_cost:101}]});assert.equal((await workflowDecision('invoices',bad.id)).status,409);assert.equal((await workflowDecision('invoices',wrongPrice.id)).status,409);
 assert.equal((await request(`/supplier-bills/${bad.supplierBillId}/decision`,{decision:'approve'},'approver')).status,409);assert.equal((await request('/payments',payBody('supplier_bill',{supplier_bill_id:bad.supplierBillId},100))).status,404);
 const bill=await logInvoice(order,4,{charges:40});assert.equal((await workflowDecision('invoices',bill.id)).status,200);assert.equal((await workflowDecision('invoices',bill.id)).status,200);report=(await request('/overview')).body.data;assert.equal(report.actual_cost,440);assert.equal(report.unpaid_liabilities,440);assert.equal(report.received_not_invoiced,0);assert.equal(report.cash_paid,0);
 const last=await logDelivery(order,6);await checkReceipt(last,6);const final=await logInvoice(order,6,{charges:60});assert.equal((await workflowDecision('invoices',final.id)).status,200);report=(await request('/overview')).body.data;assert.equal(report.actual_cost,1100);assert.equal(report.unpaid_liabilities,1100);assert.equal(report.procurement_commitments,0);assert.equal(report.cash_paid,0);
 const payment=payBody('supplier_bill',{supplier_bill_id:bill.supplierBillId},440);assert.equal((await request('/payments',payment)).status,201);assert.equal((await request('/payments',payment)).status,201);report=(await request('/overview')).body.data;assert.equal(report.cash_paid,440);assert.equal(report.unpaid_liabilities,660);assert.equal(db.accounts[0].balance,4999560);
});
test('competing matched invoices cannot bill the same accepted quantity twice',async()=>{
 const {order}=await controlledFixture(),d=await logDelivery(order,10);await checkReceipt(d,10);const a=await logInvoice(order,7),b=await logInvoice(order,7);const results=await Promise.all([workflowDecision('invoices',a.id),workflowDecision('invoices',b.id)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(db.supplierBills.filter(b=>b.status==='approved').length,1);assert.equal((await request('/overview')).body.data.actual_cost,1000);
});
test('controlled receipts and matched invoices preserve FIFO WIP without purchase-cost duplication',async()=>{
 const {order,h}=await controlledFixture({valued:true}),d=await logDelivery(order,4);await checkReceipt(d,4);let report=(await request('/overview')).body.data;assert.equal(report.actual_cost,0);assert.equal(report.material_valuation.inventory_value,400);assert.equal(report.unpaid_liabilities,400);
 const used=await request('/materials',{item_id:'material',cost_head_id:h.id,kind:'consume',quantity:2,entry_date:'2026-01-06',reason:'Footing concrete',request_key:randomUUID()});assert.equal(used.status,201,JSON.stringify(used.body));const bill=await logInvoice(order,4);await workflowDecision('invoices',bill.id);report=(await request('/overview')).body.data;assert.equal(report.actual_cost,200);assert.equal(report.material_valuation.inventory_value,200);assert.equal(report.material_valuation.wip_value,200);assert.equal(report.unpaid_liabilities,400);assert.equal(report.cash_paid,0);
});
test('receipt and invoice posting rolls stock, tax/cost journals and payables back on audit failure',async()=>{
 const {order}=await controlledFixture({valued:true}),d=await logDelivery(order,4);failAudit=true;const old=console.error;console.error=()=>{};try{assert.equal((await checkReceipt(d,4)).status,500);}finally{console.error=old;failAudit=false;}assert.equal(db.inventory[0].quantity,0);assert.equal(db.valuationEntries.length,0);assert.equal(db.deliveries[0].status,'pending');await checkReceipt(d,4);
 const bill=await logInvoice(order,4);failAudit=true;console.error=()=>{};try{assert.equal((await workflowDecision('invoices',bill.id)).status,500);}finally{console.error=old;failAudit=false;}assert.equal(db.supplierBills[0].status,'pending');assert.equal(db.reclassifications.length,0);assert.equal(db.purchaseInvoices[0].status,'pending');
});
async function scopeFixture(){await workflowSetup();const h=await newHead(),pack=await workPackage(h.phaseId),task=await workTask(pack),contract=await newContract(h),baseline=await controlBaseline(h,{task_id:task.id});const schedule=await request('/control/schedule',{base_id:null,anchor:'2026-01-01',tasks:[{task_id:task.id,duration:3,dependencies:[]}],note:'Original work sequence',request_key:randomUUID()});await controlDecision(schedule.body.data.id);const body={cost_head_id:h.id,contract_id:contract.id,title:'Drawing revision C',note:'Additional footing depth and curing period',drawing_file_ids:[],budget_change:1000,contract_change:500,base_budget:h.revisedBudget,base_contract_amount:contract.revisedAmount,boq_base_id:baseline.version.id,schedule_base_id:schedule.body.data.id,quantity_revisions:[{boq_id:baseline.line.id,quantity:12}],schedule_impacts:[{task_id:task.id,duration_delta:2,reason:'Additional depth and curing'}],approver_id:'engineer',request_key:randomUUID()};return {h,task,contract,baseline,schedule:schedule.body.data,body};}
test('scope approval applies BOQ quantities, budget, contract and schedule together and blocks separate child approvals',async()=>{
 const f=await scopeFixture(),r=await request('/control/scope-changes',f.body);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal((await request('/control/scope-changes',f.body)).body.data.id,r.body.data.id);const p=r.body.data.payload;assert.equal((await request(`/control/versions/${p.boq_version_id}/decision`,{decision:'approve',note:'Split approval'},'approver')).status,409);assert.equal((await request(`/change-orders/${p.financial_change_id}/decision`,{decision:'approve'},'approver')).status,409);
 assert.equal((await workflowDecision('scope-changes',r.body.data.id)).status,200);assert.equal((await workflowDecision('scope-changes',r.body.data.id)).status,200);assert.equal(db.heads[0].revisedBudget,f.h.revisedBudget+1000);assert.equal(db.contracts[0].revisedAmount,f.contract.revisedAmount+500);assert.equal(Number(db.boq[0].quantity),12);assert.equal(db.controlVersions.find(v=>v.id===p.schedule_version_id).status,'approved');assert.equal(db.controlVersions.find(v=>v.id===p.schedule_version_id).payload.plan.tasks[0].duration,5);
});
test('scope stale-baseline approval cannot partially change budgets or work quantities',async()=>{
 const f=await scopeFixture(),r=await request('/control/scope-changes',f.body);assert.equal(r.status,201,JSON.stringify(r.body));const independent=await request('/control/boq',{base_id:f.baseline.version.id,lines:[{...f.baseline.line,quantity:11}],note:'Separately revised scope',request_key:randomUUID()});await controlDecision(independent.body.data.id);
 assert.equal((await workflowDecision('scope-changes',r.body.data.id)).status,409);assert.equal(db.heads[0].revisedBudget,f.h.revisedBudget);assert.equal(db.contracts[0].revisedAmount,f.contract.revisedAmount);assert.equal(Number(db.boq[0].quantity),11);assert.equal(db.scopeChanges[0].status,'pending');assert.equal(db.changes[0].status,'pending');
 assert.equal((await request('/control/scope-changes',{...f.body,request_key:randomUUID()})).status,409);
});
test('scope rejects foreign drawings and protects certified work; rejecting a request rejects every linked revision',async()=>{
 const f=await scopeFixture();assert.equal((await request('/control/scope-changes',{...f.body,drawing_file_ids:['foreign']})).status,404);const m=await request('/control/measurements',measurementBody(f.baseline.line,9));await controlDecision(m.body.data.id,'measurements');assert.equal((await request('/control/scope-changes',{...f.body,quantity_revisions:[{boq_id:f.baseline.line.id,quantity:8}]})).status,409);
 const r=await request('/control/scope-changes',f.body);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal((await workflowDecision('scope-changes',r.body.data.id,'reject')).status,200);assert.ok(db.controlVersions.filter(v=>v.scopeChangeId===r.body.data.id).every(v=>v.status==='rejected'));assert.equal(db.changes[0].status,'rejected');assert.equal(db.heads[0].revisedBudget,f.h.revisedBudget);
});

test('rejected invoice and challan corrections retain original numbers as new immutable revisions',async()=>{
 const {order}=await controlledFixture(),bad=await logDelivery(order,6,{challan_number:'CH-CORRECT'});assert.equal((await request(`/control/deliveries/${bad.id}/check`,{decision:'reject',note:'Incorrect transport quantities',lines:[]},'approver','POST','p','engineer')).status,200);const corrected=await logDelivery(order,4,{challan_number:'CH-CORRECT'});assert.equal(corrected.revision,2);assert.equal((await checkReceipt(corrected,4)).status,200);
 // PostgreSQL jsonb key ordering is different from the request object's ordering.
 db.deliveries.find(d=>d.id===corrected.id).checkedLines=db.deliveries.find(d=>d.id===corrected.id).checkedLines.map(l=>Object.fromEntries(Object.entries(l).reverse()));assert.equal((await checkReceipt(corrected,4)).status,200);assert.equal(db.stock.length,1);
 const inv=await logInvoice(order,4,{number:'INV-CORRECT',lines:[{purchase_line_id:order.lines[0].id,quantity:4,unit_cost:101}]});await workflowDecision('invoices',inv.id,'reject');const revised=await logInvoice(order,4,{number:'INV-CORRECT'});assert.equal(revised.revision,2);assert.equal((await workflowDecision('invoices',revised.id)).status,200);assert.equal(db.purchaseInvoices.filter(i=>i.number==='INV-CORRECT').length,2);assert.equal(db.supplierBills.filter(i=>i.status==='approved').length,1);
});
test('existing unreceived POs can opt into checked receipts; tax/charges-only balance invoices remain bounded',async()=>{
 await workflowSetup();const h=await newHead();db.vendors.push({id:'v',tenantId:'t',projectId:'p',name:'Supplier',isActive:true});db.inventory.push({id:'i',tenantId:'t',projectId:'p',name:'Cement',quantity:0,costPrice:100,isActive:true});db.purchases.push({id:'existing',tenantId:'t',projectId:'p',vendorId:'v',status:'ordered',totalAmount:1100,lines:[{id:'line',itemId:'i',quantity:10,unitCost:100,lineTotal:1000}]});
 const b={cost_head_id:h.id,required_by:'2026-11-01',request_key:randomUUID()};assert.equal((await request('/control/orders/existing/enroll',b)).status,200);assert.equal((await request('/control/orders/existing/enroll',b)).status,200);const order=(await request('/control/workflows')).body.data.orders[0],d=await logDelivery(order,10);await checkReceipt(d,10);const first=await logInvoice(order,10);await workflowDecision('invoices',first.id);const extras=await logInvoice(order,0,{charges:100});assert.equal((await workflowDecision('invoices',extras.id)).status,200);const tooMuch=await logInvoice(order,0,{charges:1});assert.equal((await workflowDecision('invoices',tooMuch.id)).status,409);assert.equal((await request('/overview')).body.data.actual_cost,1100);
});
test('scope audit failure leaves all quantities, schedule, financial amounts and child approvals unchanged',async()=>{
 const f=await scopeFixture(),r=await request('/control/scope-changes',f.body);assert.equal(r.status,201,JSON.stringify(r.body));failAudit=true;const old=console.error;console.error=()=>{};try{assert.equal((await workflowDecision('scope-changes',r.body.data.id)).status,500);}finally{console.error=old;failAudit=false;}assert.equal(db.heads[0].revisedBudget,f.h.revisedBudget);assert.equal(db.contracts[0].revisedAmount,f.contract.revisedAmount);assert.equal(Number(db.boq[0].quantity),10);assert.ok(db.controlVersions.filter(v=>v.scopeChangeId===r.body.data.id).every(v=>v.status==='pending'));
});


test('a late financial failure rolls back coordinated BOQ and schedule approvals too',async()=>{
 const f=await scopeFixture();assert.equal((await request('/payments',payBody('advance',{contract_id:f.contract.id},1000))).status,201);const r=await request('/control/scope-changes',{...f.body,contract_change:-(f.contract.revisedAmount-500)});assert.equal(r.status,201,JSON.stringify(r.body));assert.equal((await workflowDecision('scope-changes',r.body.data.id)).status,409);assert.equal(Number(db.boq[0].quantity),10);assert.equal(db.heads[0].revisedBudget,f.h.revisedBudget);assert.ok(db.controlVersions.filter(v=>v.scopeChangeId===r.body.data.id).every(v=>v.status==='pending'));assert.equal(db.contracts[0].revisedAmount,f.contract.revisedAmount);
});


test('requesters can reroute pending work to another independent approver; other writers and stale changes cannot',async()=>{
 await workflowSetup();const h=await newHead(),req=await makeRequest(h);token('approver','p','second-engineer');const body={approver_id:'second-engineer',expected_approver_id:'engineer',note:'Assigned engineer is unavailable'};
 assert.equal((await request(`/control/routes/requisitions/${req.row.id}`,body,'accountant','POST','p','other-writer')).status,403);assert.equal((await request(`/control/routes/requisitions/${req.row.id}`,{...body,approver_id:'user-accountant'})).status,400);assert.equal((await request(`/control/routes/requisitions/${req.row.id}`,body)).status,200);assert.equal((await request(`/control/routes/requisitions/${req.row.id}`,body)).status,200);
 assert.equal((await workflowDecision('requisitions',req.row.id)).status,403);assert.equal((await workflowDecision('requisitions',req.row.id,'approve','second-engineer')).status,200);assert.equal((await request(`/control/routes/requisitions/${req.row.id}`,{...body,approver_id:'engineer'})).status,409);
});

// Contractor work agreements and measured subcontract bills share the existing payment ledger.
const workItems=()=>[{id:randomUUID(),name:'Steel binding',unit:'tonne',quantity:10,rate:1000}];
async function workFixture(extra={},activate=true){const h=await newHead(),contractor=(await request('/contractors',{name:'Steel fixing team'})).body.data,body={contractor_id:contractor.id,cost_head_id:h.id,title:'Floor 2 steel binding',trade:'Reinforcement binding',supply_mode:'labour_only',scope_note:'Project supplies steel; contractor cuts, bends and binds reinforcement.',items:workItems(),retention_bps:500,file_ids:[],request_key:randomUUID(),...extra},r=await request('/contracts/measured',body);assert.equal(r.status,201,JSON.stringify(r.body));const c=activate?await approve('contracts',r.body.data):r.body.data;return {h,c,body,contractor};}
const measuredBody=(c,quantity=2.5,extra={})=>({contract_id:c.id,quantities:c.workItems.map(i=>({item_id:i.id,cumulative_quantity:quantity})),advance_recovery:0,waste_entry_ids:[],bill_date:'2026-01-01',note:'Engineer measured completed reinforcement on the second floor.',file_ids:[],request_key:randomUUID(),...extra});

test('item-rate agreement derives its amount, remains pending until independent approval and does not inflate commitments',async()=>{
 const {c,body}=await workFixture({items:[{...workItems()[0],quantity:2.125,rate:1234.56}]},false);assert.equal(c.amount,2623);assert.equal(c.billingMode,'item_rate');assert.equal(c.status,'pending');assert.equal((await request('/overview')).body.data.cost_heads[0].commitments,0);
 assert.equal((await request('/payments',payBody('advance',{contract_id:c.id},10))).status,409);assert.equal((await request(`/contracts/${c.id}/status`,{status:'active'},'admin','PATCH')).status,409);assert.equal((await request(`/contracts/${c.id}/decision`,{decision:'approve'},'admin','POST','p','user-accountant')).status,409);
 assert.equal((await request('/contracts/measured',body)).body.data.id,c.id);assert.equal((await request('/contracts/measured',{...body,title:'Altered'})).status,409);assert.equal((await request('/contracts/measured',body,'admin')).status,409);
 await approve('contracts',c);assert.equal((await request('/overview')).body.data.cost_heads[0].commitments,2623);assert.equal((await request(`/contracts/${c.id}/decision`,{decision:'approve'},'approver')).status,200);assert.equal(db.contracts.length,1);
});
test('rejected work agreements cannot be activated or billed, and agreement reviewers need approval access',async()=>{
 const {c}=await workFixture({},false);assert.equal((await request(`/contracts/${c.id}/decision`,{decision:'approve'})).status,403);assert.equal((await request(`/contracts/${c.id}/decision`,{decision:'reject'},'approver')).status,200);assert.equal((await request(`/contracts/${c.id}/status`,{status:'active'},'admin','PATCH')).status,409);assert.equal((await request('/running-bills/measured',measuredBody(c))).status,404);assert.equal((await request('/overview')).body.data.cost_heads[0].commitments,0);
});
test('work scopes, precision, identifiers and file evidence are scoped and validated before creating an agreement',async()=>{
 const {body}=await workFixture();const fresh=extra=>({...body,request_key:randomUUID(),...extra});
 for(const extra of [{cost_head_id:'foreign-head'},{contractor_id:'foreign-contractor'},{file_ids:['foreign-file']}])assert.equal((await request('/contracts/measured',fresh(extra))).status,404);
 for(const extra of [{items:[body.items[0],body.items[0]]},{items:[{...body.items[0],id:'__proto__'}]},{items:[{...body.items[0],rate:1.234}]},{items:[{...body.items[0],quantity:1.0001}]},{items:[{...body.items[0],quantity:0.001,rate:0.01}]},{amount:1}])assert.equal((await request('/contracts/measured',fresh(extra))).status,400,JSON.stringify(extra));
 db.heads.push({...db.heads[0],id:'foreign-head',projectId:'foreign',tenantId:'other'});assert.ok(!(await request('/contracts/options')).body.data.heads.some(h=>h.id==='foreign-head'));
});
test('measured billing certifies quantities once and uses existing advance, retention, liability and payment accounting',async()=>{
 const {c}=await workFixture();await request('/payments',payBody('advance',{contract_id:c.id},500));const body=measuredBody(c,2.5,{advance_recovery:500}),r=await request('/running-bills/measured',body);assert.equal(r.status,201,JSON.stringify(r.body));const bill=r.body.data;assert.equal(bill.currentCertified,2500);assert.equal(bill.retention,125);assert.equal(bill.netPayable,1875);assert.equal(bill.measurementLines[0].current_quantity,2.5);assert.equal(db.contracts[0].certifiedAmount,0);
 assert.equal((await request('/running-bills/measured',body)).body.data.id,bill.id);assert.equal((await request('/running-bills/measured',{...body,note:'Changed measured scope'})).status,409);assert.equal((await request('/running-bills/measured',body,'admin')).status,409);
 assert.equal((await request(`/running-bills/${bill.id}/decision`,{decision:'approve'},'admin','POST','p','user-accountant')).status,409);await approve('running-bills',bill);assert.equal(db.contracts[0].certifiedQuantities[c.workItems[0].id],2.5);assert.equal(db.contracts[0].advanceRecovered,500);assert.equal(db.contracts[0].retentionHeld,125);
 await request('/payments',payBody('running_bill',{running_bill_id:bill.id},1875));const report=(await request('/overview')).body.data;assert.equal(report.actual_cost,2500);assert.equal(report.cash_paid,2375);assert.equal(report.unpaid_liabilities,125);assert.equal(report.cost_heads[0].commitments,7500);assert.equal(db.accounts[0].balance,4997625);assert.equal(db.labor.length,0);assert.equal(db.supplierBills.length,0);
 const next=(await request('/running-bills/measured',measuredBody(db.contracts[0],4))).body.data;assert.equal(next.currentCertified,1500);assert.equal(next.measurementLines[0].previous_quantity,2.5);assert.equal(next.measurementLines[0].current_quantity,1.5);assert.equal(next.retention,75);
});
test('manual amount billing and amount-only change orders cannot bypass an agreed measured schedule',async()=>{
 const {c,h}=await workFixture();assert.equal((await request('/running-bills',billBody(c,100))).status,409);assert.equal((await request('/change-orders',{contract_id:c.id,contract_change:100,budget_change:0,reason:'Extra work',request_key:randomUUID()})).status,409);
 db.changes.push({id:'bypass',tenantId:'t',projectId:'p',contractId:c.id,costHeadId:h.id,contractChange:100,budgetChange:100,status:'pending',createdById:'user-accountant'});assert.equal((await request('/change-orders/bypass/decision',{decision:'approve'},'approver')).status,409);assert.equal(db.heads[0].revisedBudget,h.revisedBudget);assert.equal(db.contracts[0].revisedAmount,10000);
 await workflowSetup();const change={cost_head_id:h.id,contract_id:c.id,title:'Additional binding',note:'Extra reinforcement scope',drawing_file_ids:[],budget_change:0,contract_change:100,base_budget:h.revisedBudget,base_contract_amount:c.revisedAmount,quantity_revisions:[],schedule_impacts:[],approver_id:'engineer',request_key:randomUUID()};assert.equal((await request('/control/scope-changes',change)).status,409);
});
test('measured bills validate all item bounds and serialize concurrent submissions against one pending certificate',async()=>{
 const {c}=await workFixture();for(const quantity of [0,10.001,-1,1.0001])assert.equal((await request('/running-bills/measured',measuredBody(c,quantity))).status,400);
 assert.equal((await request('/running-bills/measured',measuredBody(c,2,{quantities:[]}))).status,400);assert.equal((await request('/running-bills/measured',measuredBody(c,2,{quantities:[{item_id:randomUUID(),cumulative_quantity:2}]}))).status,400);
 const results=await Promise.all([request('/running-bills/measured',measuredBody(c,2)),request('/running-bills/measured',measuredBody(c,3))]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(db.bills.length,1);await request(`/running-bills/${db.bills[0].id}/decision`,{decision:'reject'},'approver');assert.deepEqual(db.contracts[0].certifiedQuantities,{});assert.equal((await request('/running-bills/measured',measuredBody(c,3))).status,201);
});
test('approved quantities cannot decrease and a stale or altered measured certificate cannot be approved',async()=>{
 const {c}=await workFixture(),first=(await request('/running-bills/measured',measuredBody(c,3))).body.data;await approve('running-bills',first);assert.equal((await request('/running-bills/measured',measuredBody(c,2))).status,400);const next=(await request('/running-bills/measured',measuredBody(c,4))).body.data;
 db.contracts[0].certifiedQuantities[c.workItems[0].id]=3.1;assert.equal((await request(`/running-bills/${next.id}/decision`,{decision:'approve'},'approver')).status,409);db.contracts[0].certifiedQuantities[c.workItems[0].id]=3;db.bills[1].measurementLines[0].rate=900;assert.equal((await request(`/running-bills/${next.id}/decision`,{decision:'approve'},'approver')).status,409);db.bills[1].measurementLines[0].rate=1000;
 // PostgreSQL JSONB can reorder object keys; snapshots must compare values, not serialization order.
 db.bills[1].measurementLines=db.bills[1].measurementLines.map(l=>Object.fromEntries(Object.entries(l).reverse()));await approve('running-bills',next);assert.equal(db.contracts[0].certifiedAmount,4000);
});
test('whole-currency rounding permits independently approved quantity-only completion and requires full quantities to close',async()=>{
 const {c}=await workFixture({items:[{...workItems()[0],quantity:1,rate:1}],retention_bps:0}),first=(await request('/running-bills/measured',measuredBody(c,0.5))).body.data;assert.equal(first.currentCertified,1);await approve('running-bills',first);assert.equal((await request(`/contracts/${c.id}/status`,{status:'closed'},'admin','PATCH')).status,409);const final=(await request('/running-bills/measured',measuredBody(c,1))).body.data;assert.equal(final.currentCertified,0);assert.equal(final.netPayable,0);await approve('running-bills',final);assert.equal(db.contracts[0].certifiedAmount,1);assert.equal(db.contracts[0].certifiedQuantities[c.workItems[0].id],1);assert.equal((await request(`/contracts/${c.id}/status`,{status:'closed'},'admin','PATCH')).status,200);assert.equal((await request(`/contracts/${c.id}/status`,{status:'active'},'admin','PATCH')).status,409);
});
test('measured advances reserve final retention and retention rounds cumulatively across repeated small bills',async()=>{
 const {c}=await workFixture({items:[{...workItems()[0],quantity:3,rate:10}],retention_bps:500});assert.equal((await request('/payments',payBody('advance',{contract_id:c.id},29))).status,409);assert.equal((await request('/payments',payBody('advance',{contract_id:c.id},28))).status,201);
 for(const [quantity,recovery,retention] of [[1,9,1],[2,10,0],[3,9,1]]){const r=await request('/running-bills/measured',measuredBody(c,quantity,{advance_recovery:recovery}));assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.data.retention,retention);await approve('running-bills',r.body.data);}
 assert.equal(db.contracts[0].advanceRecovered,28);assert.equal(db.contracts[0].retentionHeld,2);assert.equal((await request(`/contracts/${c.id}/status`,{status:'closed'},'admin','PATCH')).status,200);assert.equal((await request('/payments',payBody('retention',{contract_id:c.id},2))).status,201);assert.equal(db.contracts[0].retentionReleased,2);
});
test('measured wastage deductions reserve source losses once and release rejected bill reservations',async()=>{
 const {c}=await workFixture();db.materials.push({id:'loss',tenantId:'t',projectId:'p',kind:'waste',quantity:1,unitRate:100,chargeContractId:c.id,chargeBillId:null});const body=measuredBody(c,2,{waste_entry_ids:['loss']}),bill=(await request('/running-bills/measured',body)).body.data;assert.equal(bill.wastageDeduction,100);assert.equal(bill.netPayable,1800);assert.equal(db.materials[0].chargeBillId,bill.id);await request(`/running-bills/${bill.id}/decision`,{decision:'reject'},'approver');assert.equal(db.materials[0].chargeBillId,null);const second=(await request('/running-bills/measured',{...body,request_key:randomUUID()})).body.data;await approve('running-bills',second);assert.equal((await request('/running-bills/measured',measuredBody(c,3,{waste_entry_ids:['loss']}))).status,409);assert.equal((await request('/overview')).body.data.actual_cost,1900);
});
test('measured agreement and bill evidence is rechecked at review and other projects cannot submit bills',async()=>{
 const {c}=await workFixture();db.uploads.push({id:'sheet',tenantId:'t',projectId:'p',deletedAt:null});const bill=(await request('/running-bills/measured',measuredBody(c,2,{file_ids:['sheet']}))).body.data;db.uploads[0].deletedAt=new Date();assert.equal((await request(`/running-bills/${bill.id}/decision`,{decision:'approve'},'approver')).status,404);assert.equal(db.contracts[0].certifiedAmount,0);assert.equal((await request('/running-bills/measured',measuredBody({...c,id:'foreign-contract'}))).status,404);
});
test('contractor work creation and certification roll back together with a failed audit',async()=>{
 const {c,body}=await workFixture(),bill=(await request('/running-bills/measured',measuredBody(c,2))).body.data;failAudit=true;const old=console.error;console.error=()=>{};try{assert.equal((await request('/contracts/measured',{...body,request_key:randomUUID()})).status,500);assert.equal((await request(`/running-bills/${bill.id}/decision`,{decision:'approve'},'approver')).status,500);}finally{failAudit=false;console.error=old;}assert.equal(db.contracts.length,1);assert.equal(db.contracts[0].certifiedAmount,0);assert.deepEqual(db.contracts[0].certifiedQuantities,{});assert.equal(db.bills[0].status,'pending');assert.equal(db.payments.length,0);
});
