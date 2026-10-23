import assert from 'node:assert/strict';
import {test,before,after,beforeEach} from 'node:test';
import {randomUUID} from 'node:crypto';
import express from 'express';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'synthetic-business-assistant-test-secret'});
const {prisma}=await import('../dist/core/prisma/client.js');
const {businessAssistantRouter}=await import('../dist/modules/ai-service/business.routes.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
let projectType,roles,records,expenses,invoice,customer,base,server,reads,balance,ledger;
const scope={tenantId:'tenant',projectId:'project'};
const scoped=where=>{assert.equal(where.tenantId,'tenant');assert.equal(where.projectId,'project');};
before(async()=>{
 prisma.project.findFirst=async({where})=>{assert.equal(where.id,'project');assert.equal(where.tenantId,'tenant');return{projectType};};
 prisma.project.findFirstOrThrow=async()=>({projectType,stockManagementEnabled:true});
 prisma.tenant.findUniqueOrThrow=async()=>({currency:'BDT'});
 prisma.$queryRaw=async()=>[];
 prisma.$transaction=async fn=>fn(prisma);
 prisma.customer.findFirst=async({where})=>{scoped(where);return where.id==='customer'?customer:null;};
 prisma.vendor.findFirst=async({where})=>{scoped(where);return where.id==='supplier'?{id:'supplier',name:'Supplier'}:null;};
 prisma.account.findFirst=async({where})=>{scoped(where);return where.id==='account'?{id:'account',balance}:null;};
 prisma.inventoryItem.findFirst=async({where})=>{scoped(where);return where.id==='item'?{id:'item'}:null;};
 prisma.upload.findFirst=async({where})=>{scoped(where);return where.id==='proof'?{id:'proof'}:null;};
 prisma.businessDocument.findFirst=async({where})=>{scoped(where);return where.id==='invoice'?invoice:null;};
 for(const name of ['customer','inventoryItem','vendor','businessDocument','expense','account','purchase','expenseCategoryDef'])prisma[name].findMany=async({where,select})=>{scoped(where);if(name==='inventoryItem'&&'costPrice' in select)assert.equal(select.costPrice,true);reads++;return[];};
 prisma.account.updateMany=async({where,data})=>{scoped(where);if(where.id!=='account'||balance<where.balance.gte)return{count:0};balance-=data.balance.decrement;return{count:1};};
 prisma.account.findFirstOrThrow=async({where})=>{scoped(where);assert.equal(where.id,'account');return{id:'account',balance};};
 prisma.accountTransaction.create=async({data})=>{const row={id:'ledger-'+ledger.length,...data};ledger.push(row);return row;};
 prisma.expenseCategoryDef.findFirst=async({where})=>{scoped(where);return where.id==='meals'?{id:'meals',name:'Meals'}:null;};
 prisma.activity.findFirst=async({where})=>{scoped(where);return records.find(r=>r.id===where.id)??null;};
 prisma.activity.findMany=async({where})=>{scoped(where);return records;};
 prisma.activity.create=async({data})=>{records.push(data);return data;};
 prisma.activity.updateMany=async({where,data})=>{scoped(where);Object.assign(records.find(r=>r.id===where.id),data);return{count:1};};
 prisma.expense.create=async({data})=>{const saved={id:'expense-'+expenses.length,...data};expenses.push(saved);return saved;};
 prisma.businessConfiguration.findFirst=async()=>null;
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth={...scope,userId:'user',roles};next();});app.use('/business',businessAssistantRouter);app.use(errorHandler);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/business`;
});
beforeEach(()=>{projectType='accounting';roles=['accountant'];records=[];expenses=[];reads=0;balance=10000;ledger=[];invoice={id:'invoice',customerId:'customer',kind:'sale',status:'issued',total:1000,paidAmount:200};customer={id:'customer',email:'customer@example.test',name:'Customer'};});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await prisma.$disconnect();});
const request=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
const bill=()=>({operation:'create_expense_draft',fields:{supplier_id:'supplier',invoice_number:'SI-1',invoice_date:'2026-10-01',lines:[{item_id:'item',description:'Item',quantity:2,unit_price:500}],discount:0,tax:0,total:1000,category:'materials',account_id:'account'},targets:{},request_key:randomUUID(),verified_source_records:true,proof_file_id:'proof'});
test('snapshot rejects other project types and unauthorized roles before any record query',async()=>{
 for(const type of ['fund_shares','billing','construction']){projectType=type;assert.equal((await request('/snapshot')).status,403);assert.equal(reads,0);}
 projectType='accounting';for(const role of ['member','cashier','auditor']){roles=[role];assert.equal((await request('/snapshot')).status,403);assert.equal(reads,0);}
});
test('snapshot scopes every model read to authenticated tenant/project and exposes no credentials',async()=>{
 const r=await request('/snapshot');assert.equal(r.status,200);const result=(await r.json()).data;assert.equal(result.project_id,'project');assert.equal(result.project_type,'accounting');assert.equal(reads,8);assert.ok(!JSON.stringify(result).includes('SMTP_PASS'));
});
test('saving an expense requires attestation and creates only an unposted draft, including for admins',async()=>{
 const b=bill();assert.equal((await request('/actions',{...b,verified_source_records:false})).status,400);assert.equal(records.length,0);assert.equal(expenses.length,0);
 roles=['admin'];let r=await request('/actions',b);assert.equal(r.status,200);const result=(await r.json()).data;assert.equal(result.status,'draft');assert.equal(result.posted,false);assert.equal(expenses[0].status,'draft');assert.equal(expenses.length,1);
 r=await request('/actions',b);assert.equal(r.status,200);assert.equal(expenses.length,1);
});
test('foreign supplier, product, account and proof references are rejected before a write',async()=>{
 for(const field of ['supplier_id','account_id']){const b=bill();b.fields[field]='foreign';assert.equal((await request('/actions',b)).status,404);assert.equal(expenses.length,0);assert.equal(records.length,0);}
 const b=bill();b.fields.lines[0].item_id='foreign';assert.equal((await request('/actions',b)).status,404);b.fields.lines[0].item_id='item';b.proof_file_id='foreign';assert.equal((await request('/actions',b)).status,404);
});
test('duplicate supplier invoice across bill and expense drafts is blocked independently of AI preflight',async()=>{
 const b=bill();assert.equal((await request('/actions',b)).status,200);const again={...bill(),operation:'create_purchase_bill_draft'};delete again.fields.category;delete again.fields.account_id;assert.equal((await request('/actions',again)).status,409);assert.equal(records.length,1);assert.equal(expenses.length,1);
});
test('server validates supplier invoice arithmetic and prevents replay of changed requests',async()=>{
 const b=bill();b.fields.total++;assert.equal((await request('/actions',b)).status,400);assert.equal(records.length,0);b.fields.total--;assert.equal((await request('/actions',b)).status,200);b.fields.note='Changed after review';assert.equal((await request('/actions',b)).status,409);assert.equal(expenses.length,1);
});
test('customer reminders reject unsupported channels, changed balances and changed recipients without sending',async()=>{
 const b={operation:'send_payment_reminder',fields:{invoice_id:'invoice',channel:'whatsapp',message:'Payment reminder'},targets:{invoice:{outstanding:800,status:'issued'},recipient:{address:'customer@example.test'}},request_key:randomUUID(),verified_source_records:true};
 assert.equal((await request('/actions',b)).status,400);assert.equal(records.length,0);b.fields.channel='email';invoice.paidAmount=300;assert.equal((await request('/actions',b)).status,409);assert.equal(records.length,0);invoice.paidAmount=200;customer.email='different@example.test';assert.equal((await request('/actions',b)).status,409);assert.equal(records.length,0);
});
test('collection reported-paid notes never settle an invoice or mutate accounts',async()=>{
 const b={operation:'log_collection_followup',fields:{customer_id:'customer',invoice_id:'invoice',outcome:'reported_paid',note:'Customer reports paying; awaiting verification.'},targets:{},request_key:randomUUID(),verified_source_records:true};const r=await request('/actions',b);assert.equal(r.status,200);assert.equal(invoice.paidAmount,200);assert.equal((await r.json()).data.status,'recorded');assert.equal(expenses.length,0);
});
test('server previews the exact discount/VAT amount and rejects incorrect totals',async()=>{
 const body={kind:'quotation',fields:{customer_id:'customer',document_date:'2026-10-22',lines:[{item_id:'item',description:'Router',quantity:10,unit_price:2500}],discount_percent:5,vat_percent:15},calculation:{subtotal:25000,discount:1250,tax:3563,total:27313,currency:'BDT',rounding:'Whole taka'}};
 let r=await request('/document-preview',body);assert.equal(r.status,200);assert.equal((await r.json()).data.total,27313);body.calculation.total=27312;assert.equal((await request('/document-preview',body)).status,400);assert.equal(records.length,0);
});

test('restaurant receipts save the payee and service charge without a supplier record',async()=>{
 const b=bill();Object.assign(b.fields,{supplier_id:'',payee_name:'THE GREEN LOUNGE DHAKA',invoice_number:'574',invoice_date:'2025-03-25',lines:[{description:'Iftar platter followed by dinner',quantity:4,unit_price:2000}],tax:400,service_charge:400,total:8800,category:'services'});
 const response=await request('/actions',b);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
 assert.equal(expenses.length,1);assert.equal(expenses[0].vendorId,undefined);assert.equal(expenses[0].vendor,'THE GREEN LOUNGE DHAKA');assert.equal(expenses[0].amount,8800);assert.equal(expenses[0].status,'draft');assert.equal(expenses[0].docFileId,'proof');
 assert.match(expenses[0].title,/GREEN LOUNGE/);assert.equal(records[0].after.fields.service_charge,400);
 assert.equal((await request('/actions',b)).status,200);assert.equal(expenses.length,1);
});
test('expense supplier and payee may both be omitted while a linked supplier name is retained when provided',async()=>{
 const b=bill();delete b.fields.supplier_id;assert.equal((await request('/actions',b)).status,200);assert.equal(expenses[0].vendorId,undefined);assert.equal(expenses[0].vendor,undefined);
 const linked=bill();linked.fields.invoice_number='SI-2';assert.equal((await request('/actions',linked)).status,200);assert.equal(expenses[1].vendorId,'supplier');assert.equal(expenses[1].vendor,'Supplier');
 const purchase={...bill(),operation:'create_purchase_bill_draft'};delete purchase.fields.supplier_id;delete purchase.fields.category;delete purchase.fields.account_id;assert.equal((await request('/actions',purchase)).status,400);
});
test('duplicate checks distinguish receipt payees even without supplier IDs',async()=>{
 const first=bill();delete first.fields.supplier_id;first.fields.payee_name='THE GREEN LOUNGE DHAKA';assert.equal((await request('/actions',first)).status,200);
 const other={...first,fields:{...first.fields,payee_name:'Other Restaurant'},request_key:randomUUID()};assert.equal((await request('/actions',other)).status,200);
 const repeat={...first,fields:{...first.fields,payee_name:'the green lounge dhaka'},request_key:randomUUID()};assert.equal((await request('/actions',repeat)).status,409);assert.equal(expenses.length,2);
});


test('expenses accept missing or blank receipt numbers and use the expense description as their title',async()=>{
 for(const number of [undefined,'','   ',null]){
  const b=bill();b.fields.invoice_number=number;b.fields.payee_name='Cafe';
  const response=await request('/actions',b);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));
  const saved=expenses.at(-1);assert.equal(saved.title,'Cafe · Item');assert.equal(saved.amount,1000);assert.equal(saved.status,'draft');assert.equal(saved.docFileId,'proof');
  assert.equal(Object.hasOwn(records.at(-1).after.fields,'invoice_number'),false);
  const count=expenses.length;assert.equal((await request('/actions',b)).status,200);assert.equal(expenses.length,count);
 }
 const b=bill();delete b.fields.invoice_number;delete b.fields.supplier_id;
 assert.equal((await request('/actions',b)).status,200);assert.equal(expenses.at(-1).title,'Item');
});
test('receipt numbers remain optional without bypassing expense arithmetic or source verification',async()=>{
 for(const number of [undefined,'',null]){
  const b=bill();b.fields.invoice_number=number;b.fields.total++;
  assert.equal((await request('/actions',b)).status,400);assert.equal(records.length,0);assert.equal(expenses.length,0);
 }
 const b=bill();delete b.fields.invoice_number;b.verified_source_records=false;
 assert.equal((await request('/actions',b)).status,400);assert.equal(expenses.length,0);
});
test('purchase bill invoice numbers remain required and supplied expense numbers keep leading zeros',async()=>{
 const b=bill();b.fields.invoice_number='  000574  ';
 assert.equal((await request('/actions',b)).status,200);assert.equal(records[0].after.fields.invoice_number,'000574');assert.equal(expenses[0].title,'Supplier · Receipt 000574');
 for(const number of [undefined,'',null]){
  const purchase={...bill(),operation:'create_purchase_bill_draft'};purchase.fields.invoice_number=number;delete purchase.fields.category;delete purchase.fields.account_id;
  assert.equal((await request('/actions',purchase)).status,400);
 }
 assert.equal(expenses.length,1);assert.equal(records.length,1);
});


test('a reviewed receipt summary saves the final 437 taka expense with VAT counted once and proof retained',async()=>{
 const b=bill();b.fields={payee_name:'AL FRESCO',invoice_date:'2017-06-08',lines:[{description:'Receipt expense · AL FRESCO',quantity:1,unit_price:380}],discount:0,tax:57,total:437,category:'services',note:'Summary expense line from the final total; source item quantities/prices were not used.'};
 const r=await request('/actions',b);assert.equal(r.status,200,JSON.stringify(await r.clone().json()));
 assert.equal(expenses.length,1);assert.equal(expenses[0].amount,437);assert.equal(expenses[0].status,'draft');assert.equal(expenses[0].docFileId,'proof');assert.equal(expenses[0].vendor,'AL FRESCO');assert.equal(records[0].after.fields.tax,57);
 assert.equal((await request('/actions',b)).status,200);assert.equal(expenses.length,1);
});


test('expense review confirms owner/admin posting with one atomic debit and idempotent replay',async()=>{
 for(const role of ['owner','admin']){
  roles=[role];const beforeBalance=balance,count=expenses.length,entries=ledger.length;
  const b=bill();Object.assign(b.fields,{submission:'post',title:'Edited meal expense',payee_name:'AL FRESCO',category:'services',category_def_id:'meals'});delete b.fields.invoice_number;b.targets.expense_submission={status:'paid'};
  const r=await request('/actions',b);assert.equal(r.status,200,JSON.stringify(await r.clone().json()));const result=(await r.json()).data;
  assert.equal(result.status,'paid');assert.equal(result.posted,true);assert.equal(expenses.length,count+1);const saved=expenses.at(-1);assert.equal(saved.title,'Edited meal expense');assert.equal(saved.categoryDefId,'meals');assert.equal(saved.status,'paid');assert.equal(saved.paidAccountId,'account');assert.equal(saved.approvedById,'user');assert.equal(saved.disbursedById,'user');assert.equal(saved.docFileId,'proof');assert.equal(balance,beforeBalance-1000);assert.equal(ledger.length,entries+1);assert.equal(ledger.at(-1).referenceId,saved.id);assert.equal(ledger.at(-1).balanceAfter,balance);
  assert.equal((await request('/actions',b)).status,200);assert.equal(expenses.length,count+1);assert.equal(balance,beforeBalance-1000);assert.equal(ledger.length,entries+1);
 }
 assert.ok(records.some(r=>r.action==='account_transaction.created'));assert.ok(records.some(r=>r.action==='expense.posted'));
});
test('accountant expense submissions enter the pending approval queue without debiting any account',async()=>{
 roles=['accountant'];balance=0;
 const b=bill();b.fields.submission='post';b.targets.expense_submission={status:'pending'};b.fields.title='Needs approval';const r=await request('/actions',b);assert.equal(r.status,200);const result=(await r.json()).data;
 assert.equal(result.status,'pending');assert.equal(result.approval_required,true);assert.equal(result.posted,false);assert.equal(expenses[0].status,'pending');assert.equal(expenses[0].approvedById,undefined);assert.equal(balance,0);assert.equal(ledger.length,0);assert.ok(records.some(r=>r.action==='expense.submitted'));
 assert.equal((await request('/actions',b)).status,200);assert.equal(expenses.length,1);
});
test('expense posting cannot bypass account, category, date, balance or source checks',async()=>{
 roles=['owner'];
 for(const changes of [{account_id:undefined},{account_id:'foreign'},{category_def_id:'foreign'},{invoice_date:'2099-01-01'}]){
  const b=bill();Object.assign(b.fields,{submission:'post',...changes});b.targets.expense_submission={status:'paid'};assert.ok([400,404].includes((await request('/actions',b)).status));assert.equal(expenses.length,0);assert.equal(ledger.length,0);assert.equal(balance,10000);
 }
 balance=999;const b=bill();b.fields.submission='post';b.targets.expense_submission={status:'paid'};assert.equal((await request('/actions',b)).status,400);assert.equal(expenses.length,0);assert.equal(balance,999);assert.equal(ledger.length,0);
});


test('posting refuses a review prepared for a different role outcome',async()=>{
 const b=bill();b.fields.submission='post';b.targets.expense_submission={status:'paid'};roles=['accountant'];
 assert.equal((await request('/actions',b)).status,409);assert.equal(expenses.length,0);assert.equal(ledger.length,0);
 roles=['owner'];b.targets.expense_submission={status:'pending'};assert.equal((await request('/actions',b)).status,409);assert.equal(expenses.length,0);assert.equal(balance,10000);
});

for(const type of ['fund_shares','accounting','billing','construction']){
 test(`${type}: shared expense snapshot is scoped and excludes sales/customer data`,async()=>{
  projectType=type;const response=await request('/expense-snapshot');assert.equal(response.status,200);const data=(await response.json()).data;assert.equal(data.project_type,type);assert.equal(data.project_id,'project');assert.ok(Array.isArray(data.accounts));assert.ok(Array.isArray(data.expense_categories));assert.equal(data.documents,undefined);assert.equal(data.customers,undefined);
 });
 for(const role of ['owner','admin','accountant'])test(`${type} ${role}: shared expense posting obeys existing role effects and request-key replay`,async()=>{
  projectType=type;roles=[role];const b=bill();b.fields.submission='post';b.targets.expense_submission={status:role==='accountant'?'pending':'paid'};const r=await request('/actions',b);assert.equal(r.status,200);const result=(await r.json()).data;assert.equal(result.status,role==='accountant'?'pending':'paid');assert.equal(expenses.length,1);assert.equal(balance,role==='accountant'?10000:9000);assert.equal(ledger.length,role==='accountant'?0:1);assert.equal((await request('/actions',b)).status,200);assert.equal(expenses.length,1);assert.equal(ledger.length,role==='accountant'?0:1);
 });
 test(`${type}: shared expense references and roles cannot bypass the current project`,async()=>{
  projectType=type;for(const role of ['member','cashier','auditor','approver']){roles=[role];assert.equal((await request('/expense-snapshot')).status,403);assert.equal((await request('/actions',bill())).status,403);}roles=['owner'];for(const key of ['account_id','supplier_id']){const b=bill();b.fields[key]='foreign';assert.equal((await request('/actions',b)).status,404);}const b=bill();b.proof_file_id='foreign';assert.equal((await request('/actions',b)).status,404);assert.equal(expenses.length,0);assert.equal(ledger.length,0);
 });
}
for(const type of ['fund_shares','billing','construction'])test(`${type}: allowing shared expenses does not unlock Accounting sales or purchase actions`,async()=>{
 projectType=type;for(const operation of ['create_purchase_bill_draft','create_purchase_order_draft','send_payment_reminder','schedule_followup','log_collection_followup'])assert.equal((await request('/actions',{...bill(),operation})).status,403);assert.equal((await request('/document-preview',{})).status,403);assert.equal((await request('/snapshot')).status,403);assert.equal(expenses.length,0);assert.equal(records.length,0);
});

test('financial summaries are shared read-only routes with project and role checks',async()=>{
 const calls=[];prisma.expense.groupBy=async query=>{scoped(query.where);calls.push(query);return[];};
 prisma.accountTransaction.groupBy=async query=>{scoped(query.where);calls.push(query);return[];};
 prisma.incomeCategory.findMany=async({where})=>{scoped(where);return[];};
 for(const type of ['fund_shares','accounting','billing','construction']){
  projectType=type;
  for(const kind of ['income','expense']){const response=await request(`/financial-summary?kind=${kind}&from=2026-10-01&to=2026-10-23`);assert.equal(response.status,200);const {data}=await response.json();assert.equal(data.project_id,'project');assert.equal(data.summary_type,kind);assert.equal(data.total,0);}
 }
 for(const role of ['member','cashier','auditor','approver']){roles=[role];assert.equal((await request('/financial-summary?kind=expense&from=2026-10-01&to=2026-10-23')).status,403);}
 roles=['owner'];assert.equal((await request('/financial-summary?kind=income&from=2026-11-01&to=2026-10-23')).status,400);assert.ok(calls.length>0);assert.equal(expenses.length,0);assert.equal(ledger.length,0);
});
