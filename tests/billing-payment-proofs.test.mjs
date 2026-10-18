import assert from 'node:assert/strict';
import {test,beforeEach,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const storage=await mkdtemp(join(tmpdir(),'fundnesta-billing-proof-'));
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'billing-proof-test-secret',UPLOAD_STORAGE:'local',UPLOAD_LOCAL_DIR:storage});
const {prisma}=await import('../dist/core/prisma/client.js');
const {issueInvoice,submitInvoicePayment,reviewInvoicePayment,invoicesFromContact}=await import('../dist/modules/subscription/billing.service.js');
const {selectPackage}=await import('../dist/modules/subscription/package-selection.service.js');
const {billingPaymentSchema,billingReceipt,sendBillingReceipt}=await import('../dist/modules/subscription/billing-proof.service.js');
const {evaluateSubscription}=await import('../dist/core/subscription/subscription.service.js');
let tenant,alerts,receipts,audits,queue=Promise.resolve();
const file={originalname:'bank-receipt.pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic receipt.'),size:26};file.size=file.buffer.length;
beforeEach(()=>{
 tenant={id:'org',name:'Test organization',contact:{},updatedAt:new Date(1),deletionStartedAt:null};alerts=[];receipts=[];audits=[];
 prisma.tenant.findUnique=async({where})=>where.id==='org'?structuredClone(tenant):null;
 prisma.tenant.findUniqueOrThrow=async()=>structuredClone(tenant);
 prisma.tenant.updateMany=async({where,data})=>{if(where.updatedAt.getTime()!==tenant.updatedAt.getTime())return{count:0};tenant={...tenant,...structuredClone(data),updatedAt:new Date(tenant.updatedAt.getTime()+1)};return{count:1};};
 prisma.$queryRaw=async()=>[{count:0n}];prisma.upload.count=async()=>0;prisma.project.count=async()=>1;
 prisma.subscriptionPaymentReceipt.create=async({data})=>{receipts.push(structuredClone(data));return data;};
 prisma.subscriptionPaymentReceipt.findFirst=async({where})=>receipts.find(r=>Object.entries(where).every(([k,v])=>r[k]===v))??null;
 prisma.platformAlert.upsert=async({where,create})=>{const old=alerts.find(a=>a.eventKey===where.eventKey);if(old)return old;alerts.push(structuredClone(create));return create;};
 prisma.activity.create=async({data})=>{audits.push(data);return data;};
 prisma.$transaction=async fn=>{const previous=queue;let release;queue=new Promise(r=>release=r);await previous;const snapshot=structuredClone({tenant,alerts,receipts,audits});try{return await fn(prisma);}catch(e){({tenant,alerts,receipts,audits}=snapshot);throw e;}finally{release();}};
});
after(async()=>{await rm(storage,{recursive:true,force:true});await prisma.$disconnect();});
const payment=(extra={})=>({payment_reference:'BANK-TX-123',payment_amount:2500,request_key:randomUUID(),...extra});
const invoice=()=>issueInvoice('org',2500,'BDT','Pay to the designated bank.');
test('reference, integer amount, request identity and real receipt bytes are all required',()=>{
 for(const b of [{payment_reference:'TX'},{payment_reference:'TX-123',payment_amount:0,request_key:randomUUID()},{payment_reference:'TX-123',payment_amount:2500,request_key:'invalid'}])assert.equal(billingPaymentSchema.safeParse(b).success,false);
 assert.throws(()=>billingReceipt(),/Attach a receipt/);assert.throws(()=>billingReceipt({...file,buffer:Buffer.from('text-file'),size:9}),/JPG, PNG or WebP/);assert.throws(()=>billingReceipt({...file,size:5000001}),/5 MB/);assert.equal(billingReceipt(file).mimeType,'application/pdf');
});
test('a submission stores proof and amount and queues a billing alert without activating the plan',async()=>{
 const bill=await invoice(),before=evaluateSubscription(tenant.contact).has_access;
 const result=await submitInvoicePayment('org',bill.id,'customer',payment(),file);
 assert.equal(result.status,'submitted');assert.equal(result.payment_amount,2500);assert.equal(result.receipt.file_name,'bank-receipt.pdf');assert.equal(receipts.length,1);assert.equal(alerts.length,1);assert.equal(alerts[0].kind,'billing_payment');assert.equal(alerts[0].userId,'customer');assert.equal(evaluateSubscription(tenant.contact).has_access,before);
 assert.deepEqual(await readFile(join(storage,receipts[0].storageKey)),file.buffer);
});
test('payment retries return the existing request without duplicate proof, alerts or audit events',async()=>{
 const bill=await invoice(),input=payment(),first=await submitInvoicePayment('org',bill.id,'customer',input,file),count=audits.length;
 const retry=await submitInvoicePayment('org',bill.id,'customer',input,file);assert.equal(first.receipt.id,retry.receipt.id);assert.equal(receipts.length,1);assert.equal(alerts.length,1);assert.equal(audits.length,count);
 await assert.rejects(submitInvoicePayment('org',bill.id,'customer',{...input,payment_reference:'CHANGED'},file),/already used/);
});
test('wrong amount, foreign invoice and missing receipt never submit or queue an alert',async()=>{
 const bill=await invoice();await assert.rejects(submitInvoicePayment('org',bill.id,'customer',payment({payment_amount:2000}),file),/must match/);await assert.rejects(submitInvoicePayment('org','foreign','customer',payment(),file),/Invoice not found/);await assert.rejects(submitInvoicePayment('org',bill.id,'customer',payment()),/Attach a receipt/);assert.equal(alerts.length,0);assert.equal(receipts.length,0);assert.equal(invoicesFromContact(tenant.contact)[0].status,'open');
});
test('proof is tenant/invoice scoped and is served privately to the authorized route',async()=>{
 const bill=await invoice(),sent=await submitInvoicePayment('org',bill.id,'customer',payment(),file);
 const response={headers:null,set(value){this.headers=value;},send(value){return value;}};
 assert.deepEqual(await sendBillingReceipt({},response,'org',bill.id,sent.receipt.id),file.buffer);assert.equal(response.headers['Cache-Control'],'private, no-store');assert.equal(response.headers['Content-Type'],'application/pdf');
 await assert.rejects(sendBillingReceipt({},response,'other-org',bill.id,sent.receipt.id),/not found/);await assert.rejects(sendBillingReceipt({},response,'org','other-invoice',sent.receipt.id),/not found/);
});
test('only complete, unchanged proof can be approved; retries do not renew twice',async()=>{
 const bill=await invoice(),input=payment();await submitInvoicePayment('org',bill.id,'customer',input,file);
 await assert.rejects(reviewInvoicePayment('org',bill.id,'approve',undefined,randomUUID()),/proof changed/);
 const result=await reviewInvoicePayment('org',bill.id,'approve',undefined,input.request_key);assert.equal(result.status,'approved');assert.equal(evaluateSubscription(tenant.contact).has_access,true);
 const end=result.period_ends_at;assert.equal((await reviewInvoicePayment('org',bill.id,'approve',undefined,input.request_key)).period_ends_at,end);
});
test('legacy reference-only submissions must supply proof before approval and can be rejected for resubmission',async()=>{
 const bill=await invoice();Object.assign(tenant.contact.billing.invoices[0],{status:'submitted',payment_reference:'OLD-TX'});
 await assert.rejects(reviewInvoicePayment('org',bill.id,'approve'),/receipt.*required/);
 await reviewInvoicePayment('org',bill.id,'reject','Please attach receipt and amount.');const resubmitted=await submitInvoicePayment('org',bill.id,'customer',payment(),file);assert.equal(resubmitted.status,'submitted');assert.ok(resubmitted.receipt);
});
test('rejection followed by new proof creates a new alert and invalidates the prior review',async()=>{
 const bill=await invoice(),old=payment();await submitInvoicePayment('org',bill.id,'customer',old,file);await reviewInvoicePayment('org',bill.id,'reject','Check the reference.',old.request_key);
 await submitInvoicePayment('org',bill.id,'customer',payment({payment_reference:'BANK-CORRECTED'}),file);assert.equal(alerts.length,2);await assert.rejects(reviewInvoicePayment('org',bill.id,'approve',undefined,old.request_key),/proof changed/);
});
test('an upgrade request queues one platform alert and keeps the current plan until paid approval',async()=>{
 const result=await selectPackage('org','customer','business','monthly');const again=await selectPackage('org','customer','business','monthly');assert.equal(result.id,again.id);assert.equal(alerts.length,1);assert.equal(alerts[0].kind,'billing_upgrade');assert.equal(result.status,'open');assert.notEqual(tenant.contact.subscription?.package,'business');
});
test('concurrent submissions and approvals cannot duplicate evidence or renewals',async()=>{
 const bill=await invoice(),input=payment();const results=await Promise.all([submitInvoicePayment('org',bill.id,'customer',input,file),submitInvoicePayment('org',bill.id,'customer',input,file)]);assert.equal(results[0].receipt.id,results[1].receipt.id);assert.equal(receipts.length,1);assert.equal(alerts.length,1);
 const approvals=await Promise.all([reviewInvoicePayment('org',bill.id,'approve',undefined,input.request_key),reviewInvoicePayment('org',bill.id,'approve',undefined,input.request_key)]);assert.equal(approvals[0].period_ends_at,approvals[1].period_ends_at);
});

test('an alert write failure rolls back the payment and evidence metadata',async()=>{
 const bill=await invoice();prisma.platformAlert.upsert=async()=>{throw Error('simulated outbox failure');};
 await assert.rejects(submitInvoicePayment('org',bill.id,'customer',payment(),file),/outbox failure/);
 assert.equal(receipts.length,0);assert.equal(invoicesFromContact(tenant.contact)[0].status,'open');assert.equal(alerts.length,0);
});
