import { fixtureTransactionClient, normalizedAccountRelations } from './helpers/normalized-fixtures.mjs';
import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'billing-isolated-test';
const { prisma } = await import('../dist/core/prisma/client.js');
const { Prisma } = await import('@prisma/client');
const { fixedAssetsRouter } = await import('../dist/modules/fixed-assets/fixed-assets.routes.js');
const { postAsset } = await import('../dist/modules/fixed-assets/fixed-assets.service.js');
const { purchaseSchema, valuation, monthlyCharge, completedMonth, monthLabel, monthIndex } = await import('../dist/modules/fixed-assets/fixed-assets.policy.js');
const { authenticate } = await import('../dist/core/security/auth.middleware.js');
const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');
const { errorHandler } = await import('../dist/core/http/error-handler.js');
const { today } = await import('../dist/modules/billing/billing.policy.js');
let db, counter, server, base, failAudit, retry, queue = Promise.resolve();
const copy = value => structuredClone(value);
const models = { fixedAsset:'assets', fixedAssetOperation:'operations', fixedAssetEvent:'events', fixedAssetJournal:'journals', upload:'uploads', project:'projects', account:'accounts', activity:'activity', accountTransaction:'transactions', session:'sessions', projectMembership:'memberships' };
function reset() {
  counter = 0; failAudit = false; retry = false;
  db = Object.fromEntries(Object.values(models).map(t => [t, []]));
  db.projects = [{ id: 'p', tenantId: 't', projectType: 'construction', name: 'Community', isActive: true, billingSettings: null }, { id: 'fund', tenantId: 't', projectType: 'fund_shares', isActive: true }, { id: 'foreign', tenantId: 'other', projectType: 'construction', isActive: true }];

  db.projects.push({id:'dest',tenantId:'t',projectType:'accounting',isActive:true});
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
function decorate(_table, row) { return row ? copy(row) : null; }
function mutate(row, data) {
  for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v && typeof v === 'object' && 'decrement' in v ? row[k] - v.decrement : copy(v);
  return row;
}
function defaults(table) { return table==='assets' ? {status:'active',disposedAt:null,disposal:null,postedThrough:null,warrantyUntil:null,nextServiceDate:null,invoiceUploadId:null} : {}; }
function mock(table) {
  const findMany = async ({ where = {}, orderBy = [], take = 100000, skip = 0, include } = {}) => {
    const order = Array.isArray(orderBy) ? orderBy : [orderBy];
    const rows = db[table].filter(r => match(r, where));
    rows.sort((a, b) => { for (const o of order) for (const [k, direction] of Object.entries(o)) { const diff = a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0; if (diff) return direction === 'desc' ? -diff : diff; } return 0; });
    return rows.slice(skip, skip + take).map(r => decorate(table, r, include));
  };
  return {
    createMany: async ({data}) => { for(const row of data) await prisma.fixedAssetJournal.create({data:row}); return {count:data.length}; },
    findMany, findFirst: async args => (await findMany({ ...args, take: 1 }))[0] ?? null,
    findFirstOrThrow: async args => { const row = (await findMany({ ...args, take: 1 }))[0]; assert.ok(row, `${table} missing`); return row; },
    count: async ({ where }) => db[table].filter(r => match(r, where)).length,
    create: async ({ data, include }) => {
      if (table === 'activity' && failAudit) throw new Error('Injected audit failure');
      if (db[table].some(r => (data.requestKey && data.requestKey === r.requestKey && data.projectId === r.projectId) || (table==='journals' && r.assetId===data.assetId && r.kind===data.kind && r.period===data.period && r.projectId===data.projectId))) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
      const row = { id: `${table}-${++counter}`, createdAt: new Date(), updatedAt: new Date(), ...defaults(table) }; mutate(row, data); db[table].push(row); return decorate(table, row, include);
    },
    update: async ({ where, data, include }) => { const row = db[table].find(r => match(r, where)); assert.ok(row); mutate(row, data); return decorate(table, row, include); },
    updateMany: async ({ where, data }) => { const rows = db[table].filter(r => match(r, where)); rows.forEach(row => mutate(row, data)); return { count: rows.length }; },

  };
}
before(async () => {
  for (const [model, table] of Object.entries(models)) Object.assign(prisma[model], mock(table));
  prisma.$transaction = async fn => {
    const previous = queue; let release; queue = new Promise(r => release = r); await previous;
    const snapshot = copy(db);
    try { if (retry) { retry = false; throw new Prisma.PrismaClientKnownRequestError('serialization', { code: 'P2034', clientVersion: 'test' }); } return await fn(fixtureTransactionClient(prisma)); }
    catch (e) { db = snapshot; throw e; } finally { release(); }
  };
  const app = express(); app.use(express.json({ limit: '2mb' })); app.use(authenticate); app.use('/assets', fixedAssetsRouter); app.use(errorHandler);
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
  const response = await fetch(base + '/assets' + path, { method, headers: { authorization: `Bearer ${token(role, project, userId)}`, 'x-project-id': project, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: response.headers.get('content-type')?.includes('pdf') ? Buffer.from(await response.arrayBuffer()) : await response.json() };
}

const body=(extra={})=>({name:'Dell Latitude',category:'computers',cost:100000,residual:8000,life_months:60,purchase_date:'2025-01-15',in_use_date:'2025-02-01',supplier:'Computer shop',invoice:'INV-1',account_id:'a',quantity:1,units:[{location:'Office',assigned_to:'Rina',serial:'SN-1'}],request_key:randomUUID(),...extra});
async function buy(extra={}){const r=await request('/assets',body(extra));assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data[0];}
const disposeBody=(extra={})=>({kind:'sell',date:today(),proceeds:90000,buyer:'Buyer',account_id:'a',request_key:randomUUID(),...extra});
const transferBody=(extra={})=>({kind:'location',target:'Site office',condition:'Good',note:'Moved safely',request_key:randomUUID(),...extra});
const sum=(kind)=>db.journals.filter(j=>j.kind===kind).reduce((n,j)=>n+j.amount,0);

test('straight-line rounding reaches residual exactly, starts in-use month and excludes disposal month',()=>{
 const a={cost:100,residual:1,lifeMonths:7,inUseDate:'2026-01-15'};
 assert.equal(valuation(a,'2025-12').accumulated,0);
 assert.equal(valuation(a,'2026-01').accumulated,14);
 assert.equal(valuation(a,'2027-01').book_value,1);
 assert.equal(Array.from({length:7},(_,i)=>monthlyCharge(a,monthLabel(monthIndex('2026-01')+i))).reduce((a,b)=>a+b,0),99);
 assert.equal(valuation({...a,disposedAt:'2026-03-01'},'2026-12').accumulated,28);
 assert.equal(completedMonth('2026-01-01'),'2025-12');
});
for(const role of ['member','cashier','approver'])test(`${role} cannot read asset register or create purchases`,async()=>{assert.equal((await request('/overview',undefined,role)).status,403);assert.equal((await request('/assets',body(),role)).status,403);});
test('auditors read but cannot change cash or assets; admins can purchase',async()=>{assert.equal((await request('/overview',undefined,'auditor')).status,200);assert.equal((await request('/assets',body(),'auditor')).status,403);assert.equal((await request('/assets',body(),'admin')).status,201);});
test('purchase posts cash, balanced journals and completed months once on retry',async()=>{
 const b=body(),r=await request('/assets',b);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(db.accounts[0].balance,4900000);assert.equal(db.transactions.length,1);assert.equal(db.transactions[0].direction,'money_out');
 assert.deepEqual((await request('/assets',b)).body.data,r.body.data);assert.equal(db.assets.length,1);assert.equal(db.transactions.length,1);
 assert.equal((await request('/assets',{...b,cost:110000})).status,409);
 for(const j of db.journals)assert.equal(j.lines.reduce((n,l)=>n+l.debit-l.credit,0),0);
 const before=db.journals.length;await request('/depreciation/post',{});await request('/depreciation/post',{});assert.equal(db.journals.length,before);
 assert.equal(sum('depreciation'),valuation(db.assets[0],completedMonth(today())).accumulated);
});
test('bulk allocates each unit, charges invoice once, rejects duplicates and rolls back on insufficient cash',async()=>{
 const b=body({quantity:3,units:[{location:'Office',assigned_to:'',serial:'B1'},{location:'Site',assigned_to:'',serial:'B2'},{location:'Store',assigned_to:'',serial:'B3'}]});
 const r=await request('/assets',b);assert.equal(r.status,201);assert.equal(new Set(r.body.data.map(a=>a.code)).size,3);assert.equal(db.transactions.length,1);assert.equal(db.transactions[0].amount,300000);assert.equal(db.accounts[0].balance,4700000);
 assert.equal((await request('/assets',body({units:[{location:'Office',assigned_to:'',serial:'B1'}]}))).status,409);
 const count=db.assets.length;db.accounts[0].balance=1;assert.equal((await request('/assets',body({units:[{location:'Office',assigned_to:'',serial:'new'}]}))).status,409);assert.equal(db.assets.length,count);
 assert.equal((await request('/assets',{...b,units:b.units.slice(0,1),request_key:randomUUID()})).status,400);
});
test('cross-tenant account, attachment and asset IDs cannot escape project scope',async()=>{
 assert.equal((await request('/assets',body({account_id:'foreign-a'}))).status,404);assert.equal(db.assets.length,0);
 assert.equal((await request('/assets',body({invoice_upload_id:'missing'}))).status,404);
 const a=await buy();db.assets[0].tenantId='other';assert.equal((await request(`/assets/${a.id}`)).status,404);assert.equal((await request(`/assets/${a.id}/transfer`,transferBody())).status,404);
});
test('audit failure rolls back journals, assets and cash; serialization retries stay idempotent',async()=>{
 failAudit=true;assert.equal((await request('/assets',body())).status,500);assert.equal(db.assets.length,0);assert.equal(db.journals.length,0);assert.equal(db.accounts[0].balance,5000000);
 failAudit=false;retry=true;await buy();assert.equal(db.assets.length,1);assert.equal(db.transactions.length,1);
});
test('maintenance records service expense and reminder without capitalizing cost',async()=>{
 const a=await buy(),b={service_date:today(),description:'Battery replacement',provider:'Service center',cost:1000,account_id:'a',next_service_date:'2099-01-01',request_key:randomUUID()};
 assert.equal((await request(`/assets/${a.id}/maintenance`,b)).status,201);assert.equal((await request(`/assets/${a.id}/maintenance`,b)).status,201);assert.equal(db.accounts[0].balance,4899000);assert.equal(db.assets[0].cost,100000);assert.equal(db.events.filter(e=>e.kind==='maintenance').length,1);
 assert.equal((await request(`/assets/${a.id}/maintenance`,{...b,request_key:randomUUID(),account_id:'foreign-a'})).status,404);
});
test('transfers retain value and require same-tenant destination membership',async()=>{
 const a=await buy(),b=transferBody();assert.equal((await request(`/assets/${a.id}/transfer`,b)).status,200);assert.equal(db.assets[0].location,'Site office');assert.equal(db.transactions.length,1);
 assert.equal((await request(`/assets/${a.id}/transfer`,transferBody({kind:'project',target:'foreign'}))).status,404);
 assert.equal((await request(`/assets/${a.id}/transfer`,transferBody({kind:'project',target:'dest'}))).status,403);
 db.memberships.push({tenantId:'t',projectId:'dest',userId:'user-accountant',role:'accountant',isActive:true});const t=transferBody({kind:'project',target:'dest'});
 assert.equal((await request(`/assets/${a.id}/transfer`,t)).status,200);assert.equal((await request(`/assets/${a.id}/transfer`,t)).status,200);assert.equal(db.assets[0].projectId,'dest');assert.equal((await request(`/assets/${a.id}`)).status,404);
 assert.equal(db.journals.filter(j=>j.kind==='transfer_in').length,1);assert.equal(db.journals.filter(j=>j.kind==='transfer_out').length,1);
 assert.equal((await request(`/assets/${a.id}`,undefined,'accountant','GET','dest')).status,200);
});
test('sale uses server book value, credits proceeds once and permanently stops depreciation',async()=>{
 const a=await buy(),old=sum('depreciation'),b=disposeBody();const r=await request(`/assets/${a.id}/dispose`,b);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(db.accounts[0].balance,4990000);assert.equal(r.body.data.disposal.gain_loss,90000-(100000-old));
 assert.equal((await request(`/assets/${a.id}/dispose`,b)).status,200);assert.equal(db.accounts[0].balance,4990000);assert.equal((await request(`/assets/${a.id}/dispose`,disposeBody())).status,409);
 await request('/depreciation/post',{});assert.equal(sum('depreciation'),old);assert.equal((await request(`/assets/${a.id}/transfer`,transferBody())).status,409);
 const overview=(await request('/overview')).body.data;assert.equal(overview.count,0);assert.equal(overview.book_value,0);assert.equal(overview.assets[0].status,'disposed');
});
test('competing disposal requests cannot credit sale proceeds twice',async()=>{
 const a=await buy();const results=await Promise.all([request(`/assets/${a.id}/dispose`,disposeBody()),request(`/assets/${a.id}/dispose`,disposeBody())]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(db.accounts[0].balance,4990000);
});
test('scrap produces a loss without a cash credit, rejects backdated disposal',async()=>{
 const a=await buy();assert.equal((await request(`/assets/${a.id}/dispose`,disposeBody({date:'2025-01-01'}))).status,400);
 const r=await request(`/assets/${a.id}/dispose`,{kind:'scrap',date:today(),reason:'Obsolete',request_key:randomUUID()});assert.equal(r.status,200);assert.equal(db.transactions.length,1);assert.ok(r.body.data.disposal.gain_loss<0);
});
test('Excel and PDF exports are real files and contain current register data',async()=>{
 await buy();for(const format of ['xlsx','pdf']){const r=await request(`/reports/export?format=${format}`);assert.equal(r.status,200,JSON.stringify(r.body));const file=Buffer.from(r.body.data.base64,'base64');assert.equal(file.subarray(0,format==='pdf'?4:2).toString(),format==='pdf'?'%PDF':'PK');}
 assert.equal((await request('/journals',undefined,'auditor')).status,403);
});

test('project transfer leaves current-month depreciation with sender, next month with recipient',async()=>{
 const a=await buy();db.memberships.push({tenantId:'t',projectId:'dest',userId:'user-accountant',role:'accountant',isActive:true});
 await request(`/assets/${a.id}/transfer`,transferBody({kind:'project',target:'dest'}));
 const month=today().slice(0,7),next=monthLabel(monthIndex(month)+1);await prisma.$transaction(tx=>postAsset(tx,db.assets[0],next));
 const sender=db.journals.find(j=>j.kind==='depreciation'&&j.period===month),recipient=db.journals.find(j=>j.kind==='depreciation'&&j.period===next);
 assert.equal(sender.projectId,'p');assert.equal(recipient.projectId,'dest');
 assert.equal(db.journals.find(j=>j.kind==='transferred_depreciation'&&j.period===month).projectId,'dest');
 for(const j of db.journals)assert.equal(j.lines.reduce((n,l)=>n+l.debit-l.credit,0),0);
});
