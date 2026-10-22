import assert from 'node:assert/strict';
import { before,after,beforeEach,test } from 'node:test';
import { randomUUID } from 'node:crypto';
import express from 'express';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';process.env.JWT_SECRET='accounting-isolated-test';
const { prisma }=await import('../dist/core/prisma/client.js');
const { Prisma }=await import('@prisma/client');
const { accountingRouter }=await import('../dist/modules/accounting/accounting.routes.js');
const { customersRouter }=await import('../dist/modules/customers/customers.routes.js');
const { incomesRouter }=await import('../dist/modules/incomes/incomes.routes.js');
const { authenticate }=await import('../dist/core/security/auth.middleware.js');
const { signAccessToken,hashToken }=await import('../dist/core/security/jwt.js');
const { errorHandler }=await import('../dist/core/http/error-handler.js');
const { calculate,dateSchema }=await import('../dist/modules/accounting/workflow.js');
let db,nextId,server,base,queue=Promise.resolve(),failAudit=false,retryConflict=false,incomeFlow='accountant_only';
const copy=v=>structuredClone(v);
function compare(actual,op){if('not'in op)return actual!==op.not;if('equals'in op)return String(actual).toLowerCase()===op.equals.toLowerCase();if('in'in op)return op.in.includes(actual);return ['gte','gt','lt','lte'].every(k=>op[k]===undefined||(k==='gte'?actual>=op[k]:k==='gt'?actual>op[k]:k==='lt'?actual<op[k]:actual<=op[k]));}

function match(row,where={}){return !!row&&Object.entries(where).every(([k,v])=>v===undefined||(k==='OR'?v.some(w=>match(row,w)):v instanceof Date?row[k]?.getTime()===v.getTime():v&&typeof v==='object'?(['gte','gt','lt','lte','in','equals','not'].some(key=>key in v)?compare(row[k],v):k==='project'?match(db.projects.find(p=>p.id===row.projectId),v):match(row[k],v)):row[k]===v));}

function reset(){incomeFlow='accountant_only';nextId=0;failAudit=false;retryConflict=false;db={users:[{id:'user-admin',tenantId:'t',name:'Test administrator',mobile:'+8801711000009',email:'admin@example.com',professionalProfile:null,isActive:true}],tenants:[{id:'t',name:'Test Company',currency:'BDT',documentPrefix:'TST',documentPrefixRevision:0}],sequences:[],contacts:[{id:'person',tenantId:'t',projectId:'p',name:'Original buyer',designation:'Manager',mobile:'+8801700000001',email:'buyer@example.com',isActive:true}],contactLinks:[{tenantId:'t',projectId:'p',customerId:'c',contactPersonId:'person'}],locations:[{id:'main',tenantId:'t',projectId:'p',name:'Main store',isDefault:true,isActive:true}],categories:[{id:'cat',tenantId:'t',projectId:'p',name:'Interest',isActive:true},{id:'foreign-cat',tenantId:'other',projectId:'foreign',name:'Private',isActive:true}],projects:[{id:'p',tenantId:'t',projectType:'accounting',isActive:true,commerceSettings:null},{id:'fund',tenantId:'t',projectType:'fund_shares',isActive:true},{id:'billing',tenantId:'t',projectType:'billing',isActive:true},{id:'foreign',tenantId:'other',projectType:'accounting',isActive:true}],customers:[{id:'c',tenantId:'t',projectId:'p',name:'Customer',isActive:true,mobile:null,email:null,address:null},{id:'foreign-c',tenantId:'other',projectId:'foreign',name:'Private',isActive:true}],accounts:[{id:'a',tenantId:'t',projectId:'p',name:'Cash',balance:0},{id:'fund-a',tenantId:'t',projectId:'fund',name:'Fund cash',balance:0},{id:'billing-a',tenantId:'t',projectId:'billing',name:'Billing cash',balance:0},{id:'foreign-a',tenantId:'other',projectId:'foreign',name:'Private cash',balance:0}],inventory:[{id:'i',tenantId:'t',projectId:'p',name:'Product',quantity:5,isActive:true}],documents:[],payments:[],transactions:[],activity:[],stock:[],sessions:[],memberships:[]};}
function decorated(model,row,include){if(!row)return null;const r=copy(row);if(model==='projects'&&include?.tenant)r.tenant=copy(db.tenants.find(t=>t.id===row.tenantId));if(model==='documents'&&include){if(include.payments)r.payments=db.payments.filter(p=>p.documentId===row.id).map(copy);if(include.source)r.source=copy(db.documents.find(d=>d.id===row.sourceId)??null);if(include.next)r.next=copy(db.documents.find(d=>d.sourceId===row.id)??null);}if(model==='transactions'&&include?.account)r.account={name:db.accounts.find(a=>a.id===row.accountId)?.name};if(model==='transactions'&&include?.incomeCategory)r.incomeCategory=db.categories.find(c=>c.id===row.incomeCategoryId)??null;if(model==='transactions'&&include?.incomeCustomer)r.incomeCustomer=db.customers.find(c=>c.id===row.incomeCustomerId)??null;return r;}
function mockModel(name){return {
 aggregate:async({where})=>{const rows=db[name].filter(r=>match(r,where));return {_sum:{amount:rows.reduce((n,r)=>n+r.amount,0)},_count:rows.length};},
 groupBy:async({where,by})=>{const groups=new Map();for(const r of db[name].filter(r=>match(r,where))){const key=JSON.stringify(by.map(k=>r[k]??null));if(!groups.has(key))groups.set(key,{...Object.fromEntries(by.map(k=>[k,r[k]??null])),_sum:{amount:0,quantity:0},_count:0});const g=groups.get(key);g._sum.amount+=r.amount??0;g._sum.quantity+=r.quantity??0;g._count++;}return [...groups.values()];},
findFirst:async({where,include})=>decorated(name,db[name].find(r=>match(r,where)),include),findFirstOrThrow:async({where,include})=>{const r=db[name].find(r=>match(r,where));assert.ok(r);return decorated(name,r,include);},findMany:async({where,include,skip=0,take=100000}={})=>db[name].filter(r=>match(r,where)).slice(skip,skip+take).map(r=>decorated(name,r,include)),count:async({where})=>db[name].filter(r=>match(r,where)).length,create:async({data,include})=>{
 if(name==='activity'&&failAudit)throw new Error('Injected audit failure');
 if(data.requestKey&&db[name].some(r=>r.projectId===data.projectId&&r.requestKey===data.requestKey)||name==='documents'&&data.sourceId&&db[name].some(r=>r.sourceId===data.sourceId))throw new Prisma.PrismaClientKnownRequestError('unique',{code:'P2002',clientVersion:'test'});
 const defaults=name==='documents'?{paidAmount:0,dueDate:null,note:null,sourceId:null,revision:0,referrerId:null,referrerSnapshot:null}:name==='transactions'?{incomeSource:null,incomeCategoryId:null,incomeCustomerId:null,occurredOn:null,description:null,requestKey:null}:name==='payments'?{reference:null}:['customers','categories'].includes(name)?{isActive:true,mobile:null,email:null,address:null}:{};
 const r={id:`${name}-${++nextId}`,createdAt:new Date(),updatedAt:new Date(),...defaults,...Object.fromEntries(Object.entries(data).filter(([,v])=>v!==undefined))};db[name].push(r);return decorated(name,r,include);
 },update:async({where,data,include})=>{const r=db[name].find(r=>match(r,where));assert.ok(r);for(const[k,v]of Object.entries(data))if(v!==undefined)r[k]=v&&typeof v==='object'&&'increment'in v?r[k]+v.increment:copy(v);return decorated(name,r,include);},updateMany:async({where,data})=>{const rows=db[name].filter(r=>match(r,where));for(const r of rows)for(const[k,v]of Object.entries(data))if(v!==undefined)r[k]=v&&typeof v==='object'&&'increment'in v?r[k]+v.increment:copy(v);return {count:rows.length};}};}
function token(role='admin',project='p'){const userId=`user-${role}`,id=randomUUID();if(!db.users.some(u=>u.id===userId))db.users.push({id:userId,tenantId:'t',name:role,mobile:'+8801711000009',email:null,professionalProfile:null,isActive:true});const token=signAccessToken({userId,sessionId:id,tenantId:'t'});db.sessions.push({id,userId,tenantId:'t',activeProjectId:project,tokenHash:hashToken(token),revokedAt:null,expiresAt:new Date(Date.now()+60000),user:{id:userId,isActive:true,lastActiveAt:new Date()}});db.memberships.push({userId,tenantId:'t',projectId:project,role,isActive:true,memberId:role==='member'?'member':null});return token;}
before(async()=>{
  prisma.member.findMany = async () => [{ id: 'member' }];
  prisma.businessConfiguration.findFirst = async () => null;
  prisma.businessField.findMany = async () => [];
  prisma.$queryRaw = async () => [];
  prisma.user.findFirst = async () => ({name:'Test administrator'});
  prisma.documentNumberSequence.upsert = async ({where,create}) => {const key=where.tenantId_kind_period;let row=db.sequences.find(r=>match(r,key));if(row)row.lastValue++;else{row=copy(create);db.sequences.push(row);}return copy(row);};

  prisma.contactPerson.findFirst = async ({where}) => {
    const {customerLinks,...fields}=where;
    return copy(db.contacts.find(row=>match(row,fields)&&(!customerLinks||db.contactLinks.some(link=>link.contactPersonId===row.id&&match(link,customerLinks.some))))??null);
  };

 for(const[model,table]of Object.entries({user:'users',tenant:'tenants',inventoryLocation:'locations',project:'projects',customer:'customers',account:'accounts',businessDocument:'documents',businessPayment:'payments',inventoryItem:'inventory',accountTransaction:'transactions',activity:'activity',stockMovement:'stock',projectMembership:'memberships',incomeCategory:'categories'}))Object.assign(prisma[model],mockModel(table));
 prisma.session.findFirst=async({where})=>copy(db.sessions.find(r=>match(r,where))??null);prisma.onboardingProgress.findUnique=async()=>({incomeApprovalFlow:incomeFlow});
 prisma.$transaction=async(fn,options)=>{assert.equal(options.isolationLevel,'Serializable');const before=queue;let release;queue=new Promise(r=>release=r);await before;const snapshot=copy(db);try{if(retryConflict){retryConflict=false;throw new Prisma.PrismaClientKnownRequestError('retry',{code:'P2034',clientVersion:'test'});}return await fn(prisma);}catch(e){db=snapshot;throw e;}finally{release();}};
 const app=express();app.use(express.json());app.use(authenticate);app.use('/accounting',accountingRouter);app.use('/incomes',incomesRouter);app.use('/customers',customersRouter);app.use(errorHandler);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});beforeEach(reset);after(async()=>{await new Promise(r=>server.close(r));await prisma.$disconnect();});
async function request(path,body,role='admin',method=body===undefined?'GET':'POST',project='p'){const res=await fetch(base+path,{method,headers:{'content-type':'application/json',authorization:`Bearer ${token(role,project)}`},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()};}
const newBody=(kind='sale',extra={})=>({kind,customer_id:'c',document_date:'2026-01-01',due_date:'2026-01-02',lines:[{description:'Service',quantity:2,unit_price:500}],request_key:randomUUID(),...extra});
async function newDoc(kind='sale',extra={}){const r=await request('/accounting/documents',newBody(kind,extra));assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
async function action(d,a){const r=await request(`/accounting/documents/${d.id}/status`,{action:a});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.data;}
async function convert(d,kind){const r=await request(`/accounting/documents/${d.id}/convert`,{kind,document_date:'2026-01-01',request_key:randomUUID()});assert.equal(r.status,201,JSON.stringify(r.body));return r.body.data;}
const payBody=(amount=500)=>({account_id:'a',amount,payment_date:'2026-01-01',request_key:randomUUID()});
test('strict quotation → order → sale → partial/full payment tracks status and cash separately',async()=>{
 assert.equal((await request('/accounting/workflow',{quotations:true,orders:true,allow_skip:false},'admin','PUT')).status,200);
 assert.equal((await request('/accounting/documents',newBody())).status,409);assert.equal((await request('/accounting/documents',newBody('order'))).status,409);
 const q=await newDoc('quotation');await action(q,'send');await action(q,'accept');const o=await convert(q,'order');await action(o,'confirm');await action(o,'fulfill');const sale=await convert(o,'sale');assert.equal(db.accounts[0].balance,0);await action(sale,'issue');assert.equal(db.accounts[0].balance,0);
 assert.equal((await request(`/accounting/documents/${sale.id}/payments`,payBody(400))).status,201);assert.equal(db.accounts[0].balance,400);assert.equal(db.documents.find(d=>d.id===sale.id).paidAmount,400);
 assert.equal((await request(`/accounting/documents/${sale.id}/payments`,payBody(600))).status,201);const detail=(await request(`/accounting/documents/${sale.id}`)).body.data;assert.equal(detail.payment_status,'paid');assert.equal(detail.remaining,0);assert.equal(detail.payments.length,2);assert.equal(detail.source.id,o.id);assert.equal(db.transactions.reduce((n,t)=>n+t.amount,0),1000);assert.equal(db.accounts[0].balance,1000);assert.equal((await request(`/accounting/documents/${sale.id}/status`,{action:'cancel'})).status,409);
});
test('flexible businesses can create direct orders/sales or skip quotation → sale',async()=>{await newDoc('order');await newDoc('sale');const q=await newDoc('quotation');await action(q,'send');await action(q,'accept');const sale=await convert(q,'sale');assert.equal(sale.sourceId,q.id);});
test('disabling quotations and orders allows direct sales even in strict mode',async()=>{await request('/accounting/workflow',{quotations:false,orders:false,allow_skip:false},'admin','PUT');await newDoc();assert.equal((await request('/accounting/documents',newBody('quotation'))).status,400);assert.equal((await request('/accounting/documents',newBody('order'))).status,400);});
test('old documents retain their workflow after settings change',async()=>{const q=await newDoc('quotation');await action(q,'send');await action(q,'accept');await request('/accounting/workflow',{quotations:false,orders:false,allow_skip:false},'admin','PUT');assert.equal((await convert(q,'order')).kind,'order');});
test('conversion requires acceptance/confirmation and is single-use',async()=>{const q=await newDoc('quotation');const body={kind:'order',document_date:'2026-01-01',request_key:randomUUID()};assert.equal((await request(`/accounting/documents/${q.id}/convert`,body)).status,409);await action(q,'send');await action(q,'accept');const first=await request(`/accounting/documents/${q.id}/convert`,body);const retry=await request(`/accounting/documents/${q.id}/convert`,body);assert.equal(first.body.data.id,retry.body.data.id);assert.equal((await request(`/accounting/documents/${q.id}/convert`,{...body,request_key:randomUUID()})).status,409);});
test('unissued, foreign and excessive receivable payments never credit money',async()=>{const sale=await newDoc();assert.equal((await request(`/accounting/documents/${sale.id}/payments`,payBody())).status,409);await action(sale,'issue');assert.equal((await request(`/accounting/documents/${sale.id}/payments`,payBody(1001))).status,409);assert.equal((await request(`/accounting/documents/${sale.id}/payments`,{...payBody(),account_id:'foreign-a'})).status,404);assert.equal(db.accounts[0].balance,0);assert.equal(db.payments.length,0);});
test('simultaneous duplicate and competing payments cannot double-credit or overpay',async()=>{const sale=await newDoc();await action(sale,'issue');const b=payBody(700);const duplicate=await Promise.all([request(`/accounting/documents/${sale.id}/payments`,b),request(`/accounting/documents/${sale.id}/payments`,b)]);assert.deepEqual(duplicate.map(r=>r.status),[201,201]);assert.equal(duplicate[0].body.data.id,duplicate[1].body.data.id);assert.equal(db.payments.length,1);assert.equal(db.accounts[0].balance,700);const competing=await Promise.all([request(`/accounting/documents/${sale.id}/payments`,payBody(200)),request(`/accounting/documents/${sale.id}/payments`,payBody(200))]);assert.deepEqual(competing.map(r=>r.status).sort(),[201,409]);assert.equal(db.accounts[0].balance,900);});
test('inventory deducts aggregate duplicate lines only on issue and restores on unpaid cancellation',async()=>{const d=await newDoc('sale',{lines:[{description:'Product',item_id:'i',quantity:2,unit_price:100},{description:'Product',item_id:'i',quantity:2,unit_price:100}]});assert.equal(db.inventory[0].quantity,5);await action(d,'issue');assert.equal(db.inventory[0].quantity,1);assert.equal(db.stock.length,1);assert.equal((await request(`/accounting/documents/${d.id}/status`,{action:'issue'})).status,409);await action(d,'cancel');assert.equal(db.inventory[0].quantity,5);assert.equal(db.accounts[0].balance,0);});
test('insufficient stock rolls back all lines and document status',async()=>{const d=await newDoc('sale',{lines:[{description:'Product',item_id:'i',quantity:6,unit_price:100}]});assert.equal((await request(`/accounting/documents/${d.id}/status`,{action:'issue'})).status,409);assert.equal(db.inventory[0].quantity,5);assert.equal(db.documents[0].status,'draft');assert.equal(db.stock.length,0);});
test('foreign customers/documents and project-type misuse cannot be accessed',async()=>{assert.equal((await request('/accounting/documents',newBody('sale',{customer_id:'foreign-c'}))).status,404);assert.equal((await request('/accounting/customers',undefined,'admin','GET','fund')).status,403);assert.equal((await request('/accounting/customers',undefined,'admin','GET','foreign')).status,403);assert.equal((await request('/accounting/documents/not-present')).status,404);assert.equal((await request('/accounting/customers')).body.data.length,1);});
for(const role of ['member','auditor','approver'])test(`${role} cannot create customers/documents, change workflow or record invoice payment`,async()=>{assert.equal((await request('/accounting/customers',{name:'New customer'},role)).status,403);assert.equal((await request('/accounting/documents',newBody(),role)).status,403);assert.equal((await request('/accounting/workflow',{quotations:true,orders:true,allow_skip:false},role,'PUT')).status,403);assert.equal((await request('/accounting/documents/x/payments',payBody(),role)).status,403);});
test('auditor can read staff documents; cashier can create sales but cannot change workflow',async()=>{await newDoc();assert.equal((await request('/accounting/documents',undefined,'auditor')).status,200);assert.equal((await request('/accounting/documents',newBody(),'cashier')).status,201);assert.equal((await request('/accounting/workflow',{quotations:true,orders:true,allow_skip:false},'cashier','PUT')).status,403);});
test('draft edits recalculate totals and issued invoices are immutable',async()=>{const d=await newDoc();const b=newBody();delete b.kind;delete b.request_key;b.lines=[{description:'Edited',quantity:1.5,unit_price:1000}];b.discount=100;b.tax=50;assert.equal((await request(`/accounting/documents/${d.id}`,b,'admin','PATCH')).body.data.total,1450);await action(d,'issue');assert.equal((await request(`/accounting/documents/${d.id}`,b,'admin','PATCH')).status,409);});
test('calendar, amounts, discount, precision and untrusted totals are validated',async()=>{assert.equal(dateSchema.safeParse('2026-02-30').success,false);assert.equal((await request('/accounting/documents',newBody('sale',{total:1}))).status,400);assert.equal((await request('/accounting/documents',newBody('sale',{discount:1001}))).status,400);assert.equal((await request('/accounting/documents',newBody('sale',{due_date:'2025-01-01'}))).status,400);assert.throws(()=>calculate([{description:'Overflow',quantity:1000000,unit_price:2147483647}],0,0));assert.equal((await request('/accounting/documents?kind=invalid')).status,400);});
for(const project of ['p','fund','billing'])test(`outside income credits the chosen ${project} account exactly once without affecting invoices`,async()=>{const accountId=project==='p'?'a':`${project}-a`;const b={account_id:accountId,amount:500,source:'Interest',income_date:'2026-01-01',request_key:randomUUID()};retryConflict=true;const r=await request('/incomes',b,'admin','POST',project);assert.equal(r.status,201);assert.equal((await request('/incomes',b,'admin','POST',project)).body.data.id,r.body.data.id);assert.equal(db.accounts.find(a=>a.id===accountId).balance,500);assert.equal(db.documents.length,0);const list=(await request('/incomes',undefined,'member','GET',project)).body.data;assert.equal(list.entries.length,1);assert.equal(list.entries[0].source,'Interest');assert.equal(list.can_record,false);assert.equal((await request('/incomes',b,'member','POST',project)).status,403);});
test('income preserves legacy history and refuses foreign account, bad dates and reused payload keys',async()=>{db.transactions.push({id:'old',tenantId:'t',projectId:'p',accountId:'a',direction:'money_in',referenceType:'income',amount:100,balanceAfter:100,incomeSource:null,occurredOn:null,createdAt:new Date('2026-01-01'),description:'Legacy income'});assert.equal((await request('/incomes')).body.data.entries[0].source,'Legacy income');const b={account_id:'a',amount:500,request_key:randomUUID()};await request('/incomes',b);assert.equal((await request('/incomes',{...b,amount:600})).status,409);assert.equal((await request('/incomes',{...b,request_key:randomUUID(),account_id:'foreign-a'})).status,404);assert.equal((await request('/incomes',{...b,request_key:randomUUID(),income_date:'2099-01-01'})).status,400);assert.equal((await request('/incomes?offset=-1')).status,400);});
test('audit failure rolls back payment, cash and invoice amount together',async()=>{const d=await newDoc();await action(d,'issue');failAudit=true;const savedError=console.error;console.error=()=>{};try{assert.equal((await request(`/accounting/documents/${d.id}/payments`,payBody())).status,500);}finally{console.error=savedError;}assert.equal(db.accounts[0].balance,0);assert.equal(db.documents[0].paidAmount,0);assert.equal(db.payments.length,0);assert.equal(db.transactions.length,0);});

test('optional income category/customer tags are scoped and appear in history and grouped reports',async()=>{
 const b={account_id:'a',amount:500,category_id:'cat',customer_id:'c',source:'Outside income',income_date:'2026-01-10',request_key:randomUUID()};
 const tagged=await request('/incomes',b);assert.equal(tagged.status,201);assert.equal(tagged.body.data.category_name,'Interest');assert.equal(tagged.body.data.customer_name,'Customer');
 assert.equal((await request('/incomes',b)).body.data.id,tagged.body.data.id);assert.equal((await request('/incomes',{...b,request_key:randomUUID(),category_id:'foreign-cat'})).status,404);assert.equal((await request('/incomes',{...b,request_key:randomUUID(),customer_id:'foreign-c'})).status,404);
 await request('/incomes',{account_id:'a',amount:200,income_date:'2026-02-01',request_key:randomUUID()});
 const all=(await request('/incomes/report')).body.data;assert.equal(all.total_amount,700);assert.equal(all.by_category.find(g=>g.id==='cat').amount,500);assert.equal(all.by_category.find(g=>g.id===null).amount,200);assert.equal(all.by_customer.find(g=>g.id==='c').amount,500);
 const filtered=(await request('/incomes/report?category_id=cat&customer_id=c&from=2026-01-01&to=2026-01-31')).body.data;assert.equal(filtered.total_amount,500);assert.equal(filtered.entry_count,1);
 assert.equal((await request('/incomes?category_id=none')).body.data.entries.length,1);assert.equal((await request('/incomes/report?from=2026-03-01&to=2026-01-01')).status,400);
 assert.equal(db.documents.length,0);assert.equal(db.accounts[0].balance,700);
});
test('dynamic categories can be renamed and archived while preserving historical reports',async()=>{
 const created=await request('/incomes/categories',{name:'Rental income'});assert.equal(created.status,201);const id=created.body.data.id;
 assert.equal((await request('/incomes/categories',{name:'rental INCOME'})).status,409);assert.equal((await request('/incomes/categories',{name:'Forbidden'},'member')).status,403);
 await request('/incomes',{account_id:'a',amount:100,category_id:id,request_key:randomUUID()});
 assert.equal((await request(`/incomes/categories/${id}`,{name:'Rent',is_active:false},'admin','PATCH')).status,200);
 assert.equal((await request('/incomes',{account_id:'a',amount:100,category_id:id,request_key:randomUUID()})).status,404);
 assert.equal((await request('/incomes/report')).body.data.by_category[0].name,'Rent');assert.equal((await request('/incomes')).body.data.entries[0].category_name,'Rent');
 assert.equal((await request('/incomes/categories/foreign-cat',{name:'Spoof'},'admin','PATCH')).status,404);
});
for(const project of ['fund','billing'])test(`customer tags and categories are available for outside income in ${project} projects`,async()=>{
 const c=await request('/customers',{name:'Income customer'},'admin','POST',project);assert.equal(c.status,201);const cat=await request('/incomes/categories',{name:'Other income'},'admin','POST',project);assert.equal(cat.status,201);
 const r=await request('/incomes',{account_id:`${project}-a`,amount:50,customer_id:c.body.data.id,category_id:cat.body.data.id,request_key:randomUUID()},'admin','POST',project);assert.equal(r.status,201);assert.equal(r.body.data.customer_name,'Income customer');
 assert.equal((await request('/customers',undefined,'member','GET',project)).status,403);assert.equal((await request('/incomes/report',undefined,'member','GET',project)).body.data.total_amount,50);
});
test('income reporting excludes invoice payments and foreign project transactions',async()=>{const d=await newDoc();await action(d,'issue');await request(`/accounting/documents/${d.id}/payments`,payBody(100));await request('/incomes',{account_id:'a',amount:500,request_key:randomUUID()});await request('/incomes',{account_id:'fund-a',amount:700,request_key:randomUUID()},'admin','POST','fund');assert.equal((await request('/incomes/report')).body.data.total_amount,500);});

async function newIncome(extra = {}, project = 'p') {
 const created = await request('/incomes', { account_id: project === 'p' ? 'a' : `${project}-a`, amount: 500, source: 'Bank transfer', income_date: '2026-01-10', request_key: randomUUID(), ...extra }, 'admin', 'POST', project);
 assert.equal(created.status, 201, JSON.stringify(created.body));
 return created.body.data;
}
const tagIncome = (id, body, role = 'admin', project = 'p') => request(`/incomes/${id}/tags`, body, role, 'PATCH', project);

test('tagging existing income returns the full entry, updates reports and audits metadata only', async () => {
 const income = await newIncome({ customer_id: 'c', note: 'Original receipt' });
 const originalTransaction = copy(db.transactions[0]), originalAccounts = copy(db.accounts);
 retryConflict = true;
 const updated = await tagIncome(income.id, { category_id: 'cat' });
 assert.equal(updated.status, 200, JSON.stringify(updated.body));
 assert.deepEqual(updated.body.data, { ...income, category_id: 'cat', category_name: 'Interest' });
 assert.deepEqual(db.transactions[0], { ...originalTransaction, incomeCategoryId: 'cat' });
 assert.deepEqual(db.accounts, originalAccounts); assert.equal(db.transactions.length, 1);
 const report = (await request('/incomes/report?category_id=cat')).body.data;
 assert.equal(report.total_amount, 500); assert.equal(report.entry_count, 1);
 assert.equal(report.by_category[0].name, 'Interest');
 assert.equal((await request('/incomes?category_id=cat')).body.data.entries[0].category_name, 'Interest');
 const audit = db.activity.filter(row => row.action === 'income.tagged');
 assert.equal(audit.length, 1);
 assert.deepEqual({ tenantId: audit[0].tenantId, projectId: audit[0].projectId, actorUserId: audit[0].actorUserId, entityType: audit[0].entityType, entityId: audit[0].entityId, before: audit[0].before, after: audit[0].after }, { tenantId: 't', projectId: 'p', actorUserId: 'user-admin', entityType: 'account_transaction', entityId: income.id, before: { category_id: null }, after: { category_id: 'cat' } });
});

test('duplicate and concurrent tag saves are idempotent and tags can be removed', async () => {
 const income = await newIncome({ customer_id: 'c' });
 const results = await Promise.all([tagIncome(income.id, { category_id: 'cat' }), tagIncome(income.id, { category_id: 'cat' })]);
 assert.deepEqual(results.map(result => result.status), [200, 200]);
 assert.equal(db.activity.filter(row => row.action === 'income.tagged').length, 1);
 const cleared = await tagIncome(income.id, { category_id: null });
 assert.equal(cleared.status, 200); assert.equal(cleared.body.data.category_id, null); assert.equal(cleared.body.data.category_name, null); assert.equal(cleared.body.data.customer_id, 'c');
 assert.equal((await request('/incomes?category_id=none')).body.data.entries.length, 1);
 const audits = db.activity.filter(row => row.action === 'income.tagged');
 assert.equal(audits.length, 2); assert.deepEqual(audits[1].before, { category_id: 'cat' }); assert.deepEqual(audits[1].after, { category_id: null });
 assert.equal(db.accounts[0].balance, 500); assert.equal(db.transactions.length, 1);
});

for (const role of ['owner', 'admin', 'accountant']) test(`${role} can tag income under the accountant-only flow`, async () => {
 const income = await newIncome();
 assert.equal((await tagIncome(income.id, { category_id: 'cat' }, role)).status, 200);
});
for (const role of ['member', 'auditor', 'cashier', 'approver']) test(`${role} cannot tag income under the accountant-only flow`, async () => {
 const income = await newIncome();
 assert.equal((await tagIncome(income.id, { category_id: 'cat' }, role)).status, 403);
 assert.equal(db.transactions[0].incomeCategoryId, null); assert.equal(db.activity.filter(row => row.action === 'income.tagged').length, 0);
});

test('tag permissions follow the project income approval flow', async () => {
 const income = await newIncome(); incomeFlow = 'accountant_and_approver';
 assert.equal((await tagIncome(income.id, { category_id: 'cat' }, 'accountant')).status, 403);
 assert.equal((await request('/incomes', undefined, 'accountant')).body.data.can_record, false);
 assert.equal((await tagIncome(income.id, { category_id: 'cat' }, 'approver')).status, 200);
 assert.equal((await request('/incomes', undefined, 'approver')).body.data.can_record, true);
 assert.equal(db.accounts[0].balance, 500);
});

test('tagging refuses entries outside the tenant/project and non-income transactions', async () => {
 const income = await newIncome();
 for (const [id, overrides] of [
  ['foreign-tenant', { tenantId: 'other' }], ['foreign-project', { projectId: 'fund', accountId: 'fund-a' }],
  ['invoice-payment', { referenceType: 'receivable_payment' }], ['money-out', { direction: 'money_out' }],
 ]) db.transactions.push({ ...copy(db.transactions[0]), id, ...overrides });
 const before = copy(db.transactions);
 for (const id of ['foreign-tenant', 'foreign-project', 'invoice-payment', 'money-out', 'missing']) assert.equal((await tagIncome(id, { category_id: 'cat' })).status, 404, id);
 assert.equal((await tagIncome(income.id, { category_id: 'cat' }, 'admin', 'fund')).status, 404);
 assert.deepEqual(db.transactions, before); assert.equal(db.activity.filter(row => row.action === 'income.tagged').length, 0);
});

test('tagging refuses foreign, missing and archived categories', async () => {
 const income = await newIncome();
 db.categories.push({ id: 'other-project-category', tenantId: 't', projectId: 'fund', name: 'Fund category', isActive: true }, { id: 'other-tenant-category', tenantId: 'other', projectId: 'p', name: 'Private category', isActive: true }, { id: 'archived-category', tenantId: 't', projectId: 'p', name: 'Archived', isActive: false });
 for (const category_id of ['foreign-cat', 'other-project-category', 'other-tenant-category', 'archived-category', 'missing']) assert.equal((await tagIncome(income.id, { category_id })).status, 404, category_id);
 assert.equal(db.transactions[0].incomeCategoryId, null); assert.equal(db.accounts[0].balance, 500);
 assert.equal(db.activity.filter(row => row.action === 'income.tagged').length, 0);
});

test('tag payloads reject financial edits, extra fields and invalid categories', async () => {
 const income = await newIncome();
 const before = copy(db.transactions[0]);
 for (const body of [{}, { category_id: '' }, { category_id: '   ' }, { category_id: 1 }, { category_id: 'cat', amount: 1 }, { category_id: 'cat', account_id: 'fund-a' }, { category_id: 'cat', customer_id: 'c' }, { category_id: 'cat', income_date: '2026-02-01' }]) assert.equal((await tagIncome(income.id, body)).status, 400, JSON.stringify(body));
 assert.deepEqual(db.transactions[0], before); assert.equal(db.accounts[0].balance, 500);
});

test('an audit failure rolls back the category change without touching the balance', async () => {
 const income = await newIncome(); const before = copy(db.transactions[0]);
 failAudit = true; const savedError = console.error; console.error = () => {};
 try { assert.equal((await tagIncome(income.id, { category_id: 'cat' })).status, 500); } finally { console.error = savedError; }
 assert.deepEqual(db.transactions[0], before); assert.equal(db.accounts[0].balance, 500); assert.equal(db.activity.filter(row => row.action === 'income.tagged').length, 0);
});

for (const project of ['fund', 'billing']) test(`existing income can be tagged in ${project} projects`, async () => {
 const category = await request('/incomes/categories', { name: 'Outside income' }, 'admin', 'POST', project);
 assert.equal(category.status, 201);
 const income = await newIncome({}, project);
 const tagged = await tagIncome(income.id, { category_id: category.body.data.id }, 'admin', project);
 assert.equal(tagged.status, 200, JSON.stringify(tagged.body)); assert.equal(tagged.body.data.category_name, 'Outside income');
 assert.equal(db.accounts.find(row => row.projectId === project).balance, 500);
 assert.equal((await request('/incomes/report', undefined, 'member', 'GET', project)).body.data.by_category[0].name, 'Outside income');
});

// Dashboard aggregates remain subject to the Accounting router's role and project boundary.
test('dashboard validates periods and retains project and role isolation', async () => {
 assert.equal((await request('/accounting/dashboard?period=week')).status,400);
 assert.equal((await request('/accounting/dashboard',undefined,'member')).status,403);
 assert.equal((await request('/accounting/dashboard',undefined,'admin','GET','fund')).status,403);
 assert.equal((await request('/accounting/dashboard',undefined,'admin','GET','foreign')).status,403);
 const response=await request('/accounting/dashboard?period=this_year',undefined,'auditor');
 assert.equal(response.status,200);assert.equal(response.body.data.period,'this_year');assert.equal(response.body.data.metrics.invoiced,0);
});
test('dashboard reports issued invoices, payments, and linked conversions without leaking foreign data', async () => {
 const q=await newDoc('quotation');await action(q,'send');await action(q,'accept');
 const order=await convert(q,'order');await action(order,'confirm');const sale=await convert(order,'sale');await action(sale,'issue');
 await request(`/accounting/documents/${sale.id}/payments`,payBody(400));
 db.documents.push({...db.documents.find(d=>d.id===sale.id),id:'foreign-document',tenantId:'other-tenant',projectId:'foreign',total:999999});
 db.payments.push({...db.payments[0],id:'foreign-payment',tenantId:'other-tenant',projectId:'foreign',documentId:'foreign-document',amount:999999});
 const response=await request('/accounting/dashboard?period=this_year');assert.equal(response.status,200);
 const d=response.body.data;assert.equal(d.metrics.invoiced,1000);assert.equal(d.metrics.collected,400);assert.equal(d.pipeline.stages[0].conversionRate,100);assert.equal(d.pipeline.stages[1].conversionRate,100);
 assert.ok(d.activity.paid.some(row=>row.kind==='payment'));assert.ok(d.activity.unpaid.some(row=>row.documentId===sale.id));
 assert.ok(d.activity.all.every(row=>!row.id.includes('foreign')));
});

test('quotation contact identity and snapshot persist through edits and conversion',async()=>{
 const q=await newDoc('quotation',{quotation_person_id:'person'});
 assert.equal(q.quotationPersonId,'person');assert.equal(q.quotationPersonSnapshot.name,'Original buyer');
 db.contacts[0].name='Changed directory name';db.contactLinks=[];
 const {kind,request_key,...editBody}=newBody('quotation',{quotation_person_id:'person'});
 const edited=await request(`/accounting/documents/${q.id}`,editBody,'admin','PATCH');assert.equal(edited.status,200);assert.equal(edited.body.data.quotationPersonSnapshot.name,'Original buyer');
 await action(q,'send');await action(q,'accept');const order=await convert(q,'order');assert.equal(order.quotationPersonId,'person');assert.equal(order.quotationPersonSnapshot.name,'Original buyer');
});
test('quotation routes reject unlinked contacts and conflicting retry identities',async()=>{
 const payload=newBody('quotation',{quotation_person_id:'person'});assert.equal((await request('/accounting/documents',payload)).status,201);
 assert.equal((await request('/accounting/documents',{...payload,quotation_person_id:null})).status,409);
 assert.equal((await request('/accounting/documents',newBody('quotation',{quotation_person_id:'foreign-person'}))).status,400);
 db.contactLinks=[];assert.equal((await request('/accounting/documents',newBody('quotation',{quotation_person_id:'person'}))).status,400);
});

test('monthly organization numbers are separate per type and request retries do not consume another serial',async()=>{
 const body=newBody('quotation');const q=(await request('/accounting/documents',body)).body.data;
 assert.equal(q.number,'TSTQ26011001');assert.equal((await request('/accounting/documents',body)).body.data.number,q.number);
 assert.equal((await newDoc('quotation')).number,'TSTQ26011002');assert.equal((await newDoc('order')).number,'TSTSO26011001');assert.equal((await newDoc('sale')).number,'TSTSI26011001');
 assert.equal((await newDoc('quotation',{document_date:'2026-02-01',due_date:'2026-02-02'})).number,'TSTQ26021001');
});
test('concurrent document creations allocate distinct serials and overflow rolls back',async()=>{
 const rows=await Promise.all(Array.from({length:4},()=>newDoc('quotation')));assert.equal(new Set(rows.map(r=>r.number)).size,4);
 db.sequences.find(s=>s.kind==='quotation').lastValue=999;
 assert.equal((await request('/accounting/documents',newBody('quotation'))).status,409);assert.equal(db.sequences.find(s=>s.kind==='quotation').lastValue,999);
});
test('sent quotations can be negotiated without changing their number, and stale edits are rejected',async()=>{
 const q=await newDoc('quotation');const sent=(await request(`/accounting/documents/${q.id}/status`,{action:'send'})).body.data;
 const {kind,request_key,...body}=newBody('quotation',{expected_revision:sent.revision,lines:[{description:'Negotiated kit',quantity:1,unit_price:750,item_id:'i'}]});
 const edited=await request(`/accounting/documents/${q.id}`,body,'admin','PATCH');assert.equal(edited.status,200);assert.equal(edited.body.data.status,'sent');assert.equal(edited.body.data.number,q.number);assert.equal(edited.body.data.total,750);assert.equal(edited.body.data.revision,sent.revision+1);assert.equal(edited.body.data.events.at(-1).status,'quotation_revised');
 assert.equal((await request(`/accounting/documents/${q.id}`,body,'admin','PATCH')).status,409);assert.equal(db.inventory[0].quantity,5);
 const revisionAudit=db.activity.find(a=>a.action==='accounting.document.updated');assert.equal(revisionAudit.before.total,1000);assert.equal(revisionAudit.after.total,750);

});
test('admin settings support paragraphs, validate prefixes, preserve snapshots and forbid non-admin writes',async()=>{
 const settings=(await request('/accounting/document-settings')).body.data;
 const configured={...settings,prefix:'abc',terms:{enabled:true,text:'**Payment**\n1. First line\n\n*Italic* [Support](https://example.com)'},disclaimer:{enabled:false,text:'Optional legal paragraph'}};
 assert.equal((await request('/accounting/document-settings',configured,'accountant','PUT')).status,403);
 assert.equal((await request('/accounting/document-settings',{...configured,prefix:'ABCD'},'admin','PUT')).status,400);
 const saved=await request('/accounting/document-settings',configured,'admin','PUT');assert.equal(saved.status,200);assert.equal(saved.body.data.prefix,'ABC');
 assert.equal((await request('/accounting/document-settings',configured,'admin','PUT')).status,409);
 const q=await newDoc('quotation');assert.equal(q.number,'ABCQ26011001');assert.equal(q.presentationSnapshot.terms.text,configured.terms.text);
 await request('/accounting/document-settings',{...saved.body.data,terms:{enabled:true,text:'Changed defaults'}},'admin','PUT');
 assert.equal(db.documents[0].presentationSnapshot.terms.text,configured.terms.text);
 const {kind,request_key,...edit}=newBody('quotation',{expected_revision:q.revision,presentation:{revision:q.presentationSnapshot.settingsRevision,terms:false,disclaimer:true}});
 const response=await request(`/accounting/documents/${q.id}`,edit,'admin','PATCH');assert.equal(response.status,200);assert.equal(response.body.data.presentationSnapshot.terms.enabled,false);assert.equal(response.body.data.presentationSnapshot.disclaimer.enabled,true);assert.equal(response.body.data.presentationSnapshot.terms.text,configured.terms.text);
});
test('PDF preview uses current edited values without creating a document or consuming a serial',async()=>{
 const {request_key,...body}=newBody('quotation',{lines:[{description:'External instrument',quantity:1,unit_price:250,source:'external',unit:'pcs',model:'Model-1'}]});
 const response=await request('/accounting/documents/preview',body);assert.equal(response.status,200,JSON.stringify(response.body));assert.match(response.body.data.html,/External/);assert.match(response.body.data.html,/250.00/);assert.ok(Buffer.from(response.body.data.base64,'base64').subarray(0,5).equals(Buffer.from('%PDF-')));assert.equal(db.documents.length,0);assert.equal(db.sequences.length,0);assert.equal(db.inventory[0].quantity,5);
});
test('external lines are linked without receiving stock and issuing requires a catalog link',async()=>{
 const invoice=await newDoc('sale',{lines:[{description:'External instrument',quantity:1,unit_price:250,source:'external'}]});
 assert.equal((await request(`/accounting/documents/${invoice.id}/status`,{action:'issue'})).status,409);
 const before=db.inventory[0].quantity;
 const linked=await request(`/accounting/documents/${invoice.id}/source-items`,{expected_revision:invoice.revision,mappings:[{line:0,item_id:'i'}]});assert.equal(linked.status,200);assert.equal(db.inventory[0].quantity,before);assert.equal(linked.body.data.lines[0].unit_price,250);
 assert.equal((await request(`/accounting/documents/${invoice.id}/source-items`,{expected_revision:invoice.revision,mappings:[{line:0,item_id:'i'}]})).status,409);
 await action(invoice,'issue');assert.equal(db.inventory[0].quantity,before-1);
});
test('foreign source mappings and unconfirmed quotation sourcing are rejected',async()=>{
 const q=await newDoc('quotation',{lines:[{description:'External',quantity:1,unit_price:200,source:'external'}]});
 assert.equal((await request(`/accounting/documents/${q.id}/source-items`,{expected_revision:q.revision,mappings:[{line:0,item_id:'i'}]})).status,409);
 const invoice=await newDoc('sale',{lines:q.lines.map(({line_total,...l})=>l)});
 assert.equal((await request(`/accounting/documents/${invoice.id}/source-items`,{expected_revision:invoice.revision,mappings:[{line:0,item_id:'foreign'}]})).status,404);
});
test('referrer attribution is scoped and copied through orders and invoices for commission reporting',async()=>{
 assert.equal((await request('/accounting/documents',newBody('quotation',{referrer_id:'foreign-person'}))).status,400);
 const q=await newDoc('quotation',{referrer_id:'person'});await action(q,'send');await action(q,'accept');const order=await convert(q,'order');assert.equal(order.referrerId,'person');await action(order,'confirm');
 const report=(await request('/accounting/referrals')).body.data;assert.equal(report[0].workOrders,1);assert.equal(report[0].invoices,0);
 const invoice=await convert(order,'sale');await action(invoice,'issue');const next=(await request('/accounting/referrals')).body.data;assert.equal(next[0].workOrders,1);assert.equal(next[0].invoices,1);assert.equal(next[0].invoiced,1000);assert.equal(invoice.referrerSnapshot.name,q.referrerSnapshot.name);
});

test('five admin layouts and custom colors are validated, previewed without saving, and snapshotted',async()=>{
 let settings=(await request('/accounting/document-settings')).body.data;
 for(const templateId of ['classic','executive','minimal','corporate','elegant']) {
  const body={...settings,templateId,accentColor:'#B77D22'};
  assert.equal((await request('/accounting/document-settings/preview',body,'accountant')).status,403);
  const preview=await request('/accounting/document-settings/preview',body);assert.equal(preview.status,200,JSON.stringify(preview.body));assert.ok(preview.body.data.html.includes('#B77D22'));assert.equal(db.documents.length,0);assert.equal(db.sequences.length,0);
  const saved=await request('/accounting/document-settings',body,'admin','PUT');assert.equal(saved.status,200);settings=saved.body.data;
 }
 assert.equal((await request('/accounting/document-settings',{...settings,accentColor:'red'},'admin','PUT')).status,400);
 assert.equal((await request('/accounting/document-settings',{...settings,templateId:'unknown'},'admin','PUT')).status,400);
 const q=await newDoc('quotation');assert.equal(q.presentationSnapshot.templateId,'elegant');assert.equal(q.presentationSnapshot.accentColor,'#B77D22');
});
test('prepared-by snapshots use the user profile and disregard business identity overrides',async()=>{
 db.users[0].professionalProfile={revision:1,designation:'Sales manager',mobile:'+447700900123',email:'sales@example.com'};
 const settings=(await request('/accounting/document-settings')).body.data;
 assert.equal((await request('/accounting/document-settings',{...settings,profile:{...settings.profile,preparedBy:'Spoofed author',designation:'Director'}},'admin','PUT')).status,200);
 const q=await newDoc('quotation');assert.equal(q.presentationSnapshot.preparedBy.name,'Test administrator');assert.equal(q.presentationSnapshot.preparedBy.designation,'Sales manager');assert.equal(q.presentationSnapshot.preparedBy.mobile,'+447700900123');assert.equal(q.presentationSnapshot.profile.preparedBy,undefined);
 db.users[0].name='Renamed user';db.users[0].professionalProfile.designation='Updated role';await action(q,'send');await action(q,'accept');const order=await convert(q,'order');assert.deepEqual(order.presentationSnapshot.preparedBy,q.presentationSnapshot.preparedBy);
});
test('quotation wording overrides persist independently through sent revisions and conversion',async()=>{
 const settings=(await request('/accounting/document-settings')).body.data;
 const custom={revision:settings.revision,terms:true,disclaimer:true,terms_text:'**Equipment terms**\n1. Commissioning included.',disclaimer_text:'Delivery depends on supplier confirmation.'};
 const q=await newDoc('quotation',{presentation:custom});assert.equal(q.presentationSnapshot.terms.text,custom.terms_text);assert.equal(db.projects[0].documentSettings,undefined);
 const sent=(await request(`/accounting/documents/${q.id}/status`,{action:'send'})).body.data;
 const {kind,request_key,...edit}=newBody('quotation',{expected_revision:sent.revision,presentation:{...custom,terms_text:'**Revised equipment terms**'}});
 const revised=await request(`/accounting/documents/${q.id}`,edit,'accountant','PATCH');assert.equal(revised.status,200);assert.equal(revised.body.data.presentationSnapshot.terms.text,'**Revised equipment terms**');assert.equal(revised.body.data.presentationSnapshot.disclaimer.text,custom.disclaimer_text);
 assert.equal((await request('/accounting/documents',newBody('quotation',{presentation:{...custom,templateId:'corporate'}}),'accountant')).status,400);
 await action(q,'accept');const order=await convert(q,'order');assert.equal(order.presentationSnapshot.terms.text,'**Revised equipment terms**');
});


test('reviewed AI document creation refuses a changed total before saving',async()=>{
 const r=await request('/accounting/documents',newBody('quotation',{expected_total:999}));assert.equal(r.status,409);assert.equal(db.documents.length,0);
 const saved=await request('/accounting/documents',newBody('quotation',{expected_total:1000}));assert.equal(saved.status,201);
});
test('reviewed AI quotation status changes and conversions reject stale revisions',async()=>{
 const q=await newDoc('quotation');await action(q,'send');
 let r=await request(`/accounting/documents/${q.id}/status`,{action:'accept',expected_revision:0});assert.equal(r.status,409);assert.equal(db.documents[0].status,'sent');
 r=await request(`/accounting/documents/${q.id}/status`,{action:'accept',expected_revision:1});assert.equal(r.status,200);
 r=await request(`/accounting/documents/${q.id}/convert`,{kind:'order',document_date:'2026-01-01',request_key:randomUUID(),expected_revision:1});assert.equal(r.status,409);assert.equal(db.documents.length,1);
 r=await request(`/accounting/documents/${q.id}/convert`,{kind:'order',document_date:'2026-01-01',request_key:randomUUID(),expected_revision:2});assert.equal(r.status,201);assert.equal(db.documents.length,2);
});


test('accepted quotation revisions return to sent, retain history and need fresh acceptance before order conversion',async()=>{
 const q=await newDoc('quotation');await action(q,'send');const accepted=await action(q,'accept');
 const {kind,request_key,...body}=newBody('quotation',{expected_revision:accepted.revision,lines:[{description:'Final negotiated kit',quantity:2,unit_price:600,item_id:'i'}]});
 const revised=await request(`/accounting/documents/${q.id}`,body,'accountant','PATCH');assert.equal(revised.status,200);const r=revised.body.data;
 assert.equal(r.id,q.id);assert.equal(r.number,q.number);assert.equal(r.status,'sent');assert.equal(r.total,1200);assert.equal(r.revision,accepted.revision+1);assert.ok(r.events.some(e=>e.status==='accepted'));assert.equal(r.events.at(-1).status,'quotation_revised');
 assert.equal((await request(`/accounting/documents/${q.id}/convert`,{kind:'order',document_date:'2026-01-10',expected_revision:r.revision,request_key:randomUUID()})).status,409);
 const reaccepted=await action(r,'accept');const converted=await request(`/accounting/documents/${q.id}/convert`,{kind:'order',document_date:'2026-01-10',expected_revision:reaccepted.revision,request_key:randomUUID()});assert.equal(converted.status,201);assert.equal(converted.body.data.total,1200);assert.equal(converted.body.data.status,'draft');
 assert.equal(db.inventory[0].quantity,5);assert.equal(db.accounts[0].balance,0);assert.equal(db.payments.length,0);
 const audits=db.activity.filter(a=>a.action==='accounting.document.updated');assert.equal(audits.at(-1).before.status,'accepted');assert.equal(audits.at(-1).after.status,'sent');
});
test('accepted quotation revisions require the reviewed revision, writer access and matching project',async()=>{
 const q=await newDoc('quotation');await action(q,'send');const accepted=await action(q,'accept');
 const {kind,request_key,...body}=newBody('quotation',{expected_revision:accepted.revision});
 const {expected_revision,...missingRevision}=body;
 assert.equal((await request(`/accounting/documents/${q.id}`,missingRevision,'admin','PATCH')).status,409);
 assert.equal((await request(`/accounting/documents/${q.id}`,{...body,expected_revision:accepted.revision-1},'admin','PATCH')).status,409);
 assert.equal((await request(`/accounting/documents/${q.id}`,body,'member','PATCH')).status,403);
 assert.equal((await request(`/accounting/documents/${q.id}`,body,'admin','PATCH','fund')).status,404);
 assert.equal(db.documents.find(d=>d.id===q.id).status,'accepted');
});
test('a quotation linked to a sales order cannot be revised even if a stale status says accepted',async()=>{
 const q=await newDoc('quotation');await action(q,'send');await action(q,'accept');
 assert.equal((await request(`/accounting/documents/${q.id}/convert`,{kind:'order',document_date:'2026-01-10',request_key:randomUUID()})).status,201);
 const source=db.documents.find(d=>d.id===q.id);source.status='accepted';
 const {kind,request_key,...body}=newBody('quotation',{expected_revision:source.revision});
 assert.equal((await request(`/accounting/documents/${q.id}`,body,'admin','PATCH')).status,409);
});
test('simultaneous accepted-quotation revision and order conversion cannot both succeed',async()=>{
 const q=await newDoc('quotation');await action(q,'send');const accepted=await action(q,'accept');
 const {kind,request_key,...body}=newBody('quotation',{expected_revision:accepted.revision,lines:[{description:'Revised kit',quantity:1,unit_price:800,item_id:'i'}]});
 const results=await Promise.all([request(`/accounting/documents/${q.id}`,body,'admin','PATCH'),request(`/accounting/documents/${q.id}/convert`,{kind:'order',document_date:'2026-01-10',expected_revision:accepted.revision,request_key:randomUUID()})]);
 assert.equal(results.filter(r=>r.status>=200&&r.status<300).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
 assert.equal(db.inventory[0].quantity,5);assert.equal(db.accounts[0].balance,0);
});
