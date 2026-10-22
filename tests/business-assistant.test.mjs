import assert from 'node:assert/strict';
import {test,before,after,beforeEach} from 'node:test';
import {randomUUID} from 'node:crypto';
import express from 'express';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'synthetic-business-assistant-test-secret'});
const {prisma}=await import('../dist/core/prisma/client.js');
const {businessAssistantRouter}=await import('../dist/modules/ai-service/business.routes.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
let projectType,roles,records,expenses,invoice,customer,base,server,reads;
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
 prisma.account.findFirst=async({where})=>{scoped(where);return where.id==='account'?{id:'account'}:null;};
 prisma.inventoryItem.findFirst=async({where})=>{scoped(where);return where.id==='item'?{id:'item'}:null;};
 prisma.upload.findFirst=async({where})=>{scoped(where);return where.id==='proof'?{id:'proof'}:null;};
 prisma.businessDocument.findFirst=async({where})=>{scoped(where);return where.id==='invoice'?invoice:null;};
 for(const name of ['customer','inventoryItem','vendor','businessDocument','expense','account','purchase'])prisma[name].findMany=async({where})=>{scoped(where);reads++;return[];};
 prisma.activity.findFirst=async({where})=>{scoped(where);return records.find(r=>r.id===where.id)??null;};
 prisma.activity.findMany=async({where})=>{scoped(where);return records;};
 prisma.activity.create=async({data})=>{records.push(data);return data;};
 prisma.activity.updateMany=async({where,data})=>{scoped(where);Object.assign(records.find(r=>r.id===where.id),data);return{count:1};};
 prisma.expense.create=async({data})=>{expenses.push(data);return{id:'expense',...data};};
 prisma.businessConfiguration.findFirst=async()=>null;
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth={...scope,userId:'user',roles};next();});app.use('/business',businessAssistantRouter);app.use(errorHandler);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/business`;
});
beforeEach(()=>{projectType='accounting';roles=['accountant'];records=[];expenses=[];reads=0;invoice={id:'invoice',customerId:'customer',kind:'sale',status:'issued',total:1000,paidAmount:200};customer={id:'customer',email:'customer@example.test',name:'Customer'};});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await prisma.$disconnect();});
const request=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
const bill=()=>({operation:'create_expense_draft',fields:{supplier_id:'supplier',invoice_number:'SI-1',invoice_date:'2026-10-01',lines:[{item_id:'item',description:'Item',quantity:2,unit_price:500}],discount:0,tax:0,total:1000,category:'materials',account_id:'account'},targets:{},request_key:randomUUID(),verified_source_records:true,proof_file_id:'proof'});
test('snapshot rejects other project types and unauthorized roles before any record query',async()=>{
 for(const type of ['fund_shares','billing','construction']){projectType=type;assert.equal((await request('/snapshot')).status,403);assert.equal(reads,0);}
 projectType='accounting';for(const role of ['member','cashier','auditor']){roles=[role];assert.equal((await request('/snapshot')).status,403);assert.equal(reads,0);}
});
test('snapshot scopes every model read to authenticated tenant/project and exposes no credentials',async()=>{
 const r=await request('/snapshot');assert.equal(r.status,200);const result=(await r.json()).data;assert.equal(result.project_id,'project');assert.equal(result.project_type,'accounting');assert.equal(reads,7);assert.ok(!JSON.stringify(result).includes('SMTP_PASS'));
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
