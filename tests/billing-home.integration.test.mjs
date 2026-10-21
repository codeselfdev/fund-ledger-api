import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const url=process.env.BILLING_TEST_DATABASE_URL;
test('billing reference fixture and complaint lifecycle reconcile in PostgreSQL',{skip:!url},async t=>{
 process.env.DATABASE_URL=url;process.env.JWT_SECRET='disposable-billing-test';
 const {prisma}=await import('../dist/core/prisma/client.js');
 const {billingRouter}=await import('../dist/modules/billing/billing.routes.js');
 const {errorHandler}=await import('../dist/core/http/error-handler.js');
 const {seedBillingDemo}=createRequire(import.meta.url)(process.env.BILLING_MOBILE_ROOT+'/scripts/seed-billing-demo.cjs');
 const {PROJECT_NAME}=createRequire(import.meta.url)(process.env.BILLING_MOBILE_ROOT+'/scripts/billing-demo-data.cjs');
 const {default:express}=await import('express');
 const tenant=await prisma.tenant.create({data:{name:'Fund Nesta Review Demo',slug:randomUUID()}});
 const user=await prisma.user.create({data:{tenantId:tenant.id,name:'Synthetic reviewer',mobile:'+16505550174'}});
 const project=await prisma.project.create({data:{tenantId:tenant.id,name:PROJECT_NAME,projectType:'billing',totalShares:1}});
 const account=await prisma.account.create({data:{tenantId:tenant.id,projectId:project.id,name:'Demo Cash',type:'cash',isDefault:true}});
 const a={tenantId:tenant.id,projectId:project.id,userId:user.id,roles:['admin']};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth=a;next();});
 app.get('/v1/auth/me',(req,res)=>res.json({ok:true,data:{tenant:{id:tenant.id,name:tenant.name},user:{mobile:user.mobile},roles:['admin']}}));
 app.get('/v1/projects',(req,res)=>res.json({ok:true,data:[{project_id:project.id,tenant_id:tenant.id,name:project.name,project_type:'billing'}]}));
 app.get('/v1/accounts',async(req,res)=>res.json({ok:true,data:{accounts:await prisma.account.findMany({where:{projectId:project.id}})}}));
 app.use('/v1/billing',billingRouter);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(path,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const j=await r.json();if(!r.ok)throw new Error(`${r.status} ${path}: ${JSON.stringify(j)}`);return j.data;};
 try{
  await t.test('preview leaves all records unchanged',async()=>{const r=await seedBillingDemo({call,projectId:project.id});assert.equal(r.status,'preview');assert.equal(await prisma.customer.count(),0);});
  await t.test('fixture creates recurring bills, receipts, complaints and pending reviews',async()=>{
   const r=await seedBillingDemo({call,projectId:project.id,apply:true});assert.equal(r.status,'seeded');assert.equal(r.metrics.outstanding,33000);
   assert.equal(await prisma.billingInvoice.count(),15);assert.equal(await prisma.billingAssignment.count(),10);assert.equal(await prisma.billingComplaint.count(),5);assert.equal(await prisma.billingAdjustment.count(),2);
   assert.equal(await prisma.billingMessage.count(),0);assert.equal((await prisma.account.findUnique({where:{id:account.id}})).balance,19000);
   assert.equal(await prisma.billingInvoice.count({where:{assignmentId:null}}),0);
  });
  await t.test('reruns and month generation never duplicate sample invoices or cash entries',async()=>{
   const before=await prisma.accountTransaction.count();await seedBillingDemo({call,projectId:project.id,apply:true});assert.equal(await prisma.billingInvoice.count(),15);assert.equal(await prisma.accountTransaction.count(),before);
   const a=await prisma.billingAssignment.findFirst();await call(`/v1/billing/assignments/${a.id}/invoice`,{period_start:'2026-10-01'});assert.equal(await prisma.billingInvoice.count(),15);
  });
  await t.test('adding a subscriber creates the first bill atomically and survives retries',async()=>{
   const plan=await prisma.billingPlan.findFirst();const body={customer:{name:'Extra sample subscriber'},unit_name:'SAMPLE-X',plan_id:plan.id,start:'this_month',request_key:randomUUID()};
   const before=await prisma.billingInvoice.count(),row=await call('/v1/billing/subscribers',body),again=await call('/v1/billing/subscribers',body);assert.equal(row.customer.id,again.customer.id);assert.equal(await prisma.billingInvoice.count(),before+1);assert.equal(row.invoice.total,plan.amount);
   await assert.rejects(call('/v1/billing/subscribers',{...body,unit_name:'changed'}),/409/);
   const customers=await prisma.customer.count();await assert.rejects(call('/v1/billing/subscribers',{...body,request_key:randomUUID(),customer:{name:'Should roll back'}}),/409/);assert.equal(await prisma.customer.count(),customers);
   const next=await call('/v1/billing/subscribers',{...body,unit_name:'SAMPLE-Y',start:'next_month',request_key:randomUUID()});assert.equal(next.invoice,null);assert.equal(await prisma.billingInvoice.count(),before+1);
  });
  await t.test('complaint status is persisted with an audit trail',async()=>{const c=await prisma.billingComplaint.findFirst({where:{status:'open'}});const row=await call(`/v1/billing/complaints/${c.id}`,{status:'progress',assigned_to:'Sample maintenance'},'PATCH');assert.equal(row.assignedTo,'Sample maintenance');const done=await call(`/v1/billing/complaints/${c.id}`,{status:'resolved'},'PATCH');assert.ok(done.resolvedAt);assert.ok(await prisma.activity.findFirst({where:{entityId:c.id,action:'billing.complaint.updated'}}));});
  if(process.env.BILLING_PREVIEW_FILE){const {writeFile}=await import('node:fs/promises');await writeFile(process.env.BILLING_PREVIEW_FILE,JSON.stringify(await call('/v1/billing/home?month=2026-10')));}
 }finally{await new Promise(r=>server.close(r));await prisma.$disconnect();}
});
