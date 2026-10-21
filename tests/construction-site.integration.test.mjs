import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const url=process.env.CONSTRUCTION_TEST_DATABASE_URL;
test('construction site workflow and demo fixture against PostgreSQL',{skip:!url},async t=>{
 process.env.DATABASE_URL=url;process.env.NODE_ENV='production';process.env.JWT_SECRET='disposable-construction-test';
 const {prisma}=await import('../dist/core/prisma/client.js');
 const {constructionRouter}=await import('../dist/modules/construction/construction.routes.js');
 const {constructionReport}=await import('../dist/modules/construction/construction.reports.js');
 const {errorHandler}=await import('../dist/core/http/error-handler.js');
 const {seedConstructionDemo,DEMO_NAME}=await import('../scripts/seed-construction-demo.mjs');
 const {default:express}=await import('express');
 const tenant=await prisma.tenant.create({data:{name:'Disposable Review Demo',slug:randomUUID()}});
 const user=await prisma.user.create({data:{tenantId:tenant.id,name:'Demo owner',mobile:'+16505550174'}});
 const reviewer=await prisma.user.create({data:{tenantId:tenant.id,name:'Test approver',mobile:randomUUID()}});
 const project=await prisma.project.create({data:{tenantId:tenant.id,name:DEMO_NAME,projectType:'construction',totalShares:12}});
 await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:project.id,userId:user.id,role:'admin'}});
 const a={tenantId:tenant.id,projectId:project.id,userId:user.id,roles:['admin']};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth={...a,userId:req.headers['x-test-user']??user.id,roles:[req.headers['x-test-role']??'admin']};next();});app.use(constructionRouter);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,body,method=body?'POST':'GET',who=user.id,role='admin')=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json','x-test-user':who,'x-test-role':role},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 try {
  await t.test('demo preload previews without writes, reconciles cash/cost, and is idempotent',async()=>{
   const options={mobile:user.mobile,projectId:project.id};assert.equal((await seedConstructionDemo(prisma,options)).status,'preview');assert.equal(await prisma.constructionCostHead.count({where:{projectId:project.id}}),0);
   assert.equal((await seedConstructionDemo(prisma,{...options,apply:true})).status,'seeded');
   const report=await constructionReport(a);assert.equal(report.approved_budget,58000000);assert.equal(report.actual_cost,34200000);assert.equal(report.cash_available,2650000);assert.equal(report.unpaid_liabilities,1840000);assert.equal(report.projected_final_cost,56100000);
   const count=await prisma.accountTransaction.count({where:{projectId:project.id}});assert.equal((await seedConstructionDemo(prisma,{...options,apply:true})).status,'already_seeded');assert.equal(await prisma.accountTransaction.count({where:{projectId:project.id}}),count);
   const snapshot={report,data:{settings:(await prisma.project.findUnique({where:{id:project.id}})).constructionSettings,heads:await prisma.constructionCostHead.findMany({where:{projectId:project.id}}),boq:await prisma.constructionBoq.findMany({where:{projectId:project.id}}),contractors:await prisma.constructionContractor.findMany({where:{projectId:project.id}}),contracts:await prisma.constructionContract.findMany({where:{projectId:project.id},include:{contractor:true}}),suppliers:await prisma.vendor.findMany({where:{projectId:project.id}}),bills:await prisma.constructionRunningBill.findMany({where:{projectId:project.id},include:{contract:true}}),supplierBills:await prisma.constructionSupplierBill.findMany({where:{projectId:project.id},include:{vendor:true}}),labor:await prisma.constructionLaborEntry.findMany({where:{projectId:project.id}}),materials:await prisma.constructionMaterialEntry.findMany({where:{projectId:project.id},include:{item:true}}),accounts:await prisma.account.findMany({where:{projectId:project.id}}),expenses:await prisma.expense.findMany({where:{projectId:project.id}}),inventory:await prisma.inventoryItem.findMany({where:{projectId:project.id}}),purchases:[]},logs:(await request('/site-logs?from=2026-10-01&to=2026-10-21')).data.data,waste:(await request('/wastage')).data.data};
   if(process.env.CONSTRUCTION_PREVIEW_FILE)await writeFile(process.env.CONSTRUCTION_PREVIEW_FILE,JSON.stringify(snapshot));
  });
  await t.test('simultaneous site submissions post wages and stock only once',async()=>{
   const log=await prisma.constructionSiteLog.findFirstOrThrow({where:{projectId:project.id}}),before=await prisma.inventoryItem.findMany({where:{projectId:project.id}}),cash=(await constructionReport(a)).cash_available;
   const results=await Promise.all([request(`/site-logs/${log.id}/submit`,{version:log.version}),request(`/site-logs/${log.id}/submit`,{version:log.version})]);results.forEach(r=>assert.equal(r.status,201,JSON.stringify(r.data)));
   const saved=await prisma.constructionSiteLog.findUnique({where:{id:log.id}});assert.equal(saved.laborIds.length,5);assert.equal(saved.materialIds.length,4);
   for(const m of log.content.materials){const row=await prisma.inventoryItem.findUnique({where:{id:m.item_id}});assert.equal(row.quantity,before.find(i=>i.id===row.id).quantity-m.quantity);}
   assert.equal((await request(`/site-logs/${log.id}/decision`,{decision:'approve'})).status,409);
   assert.equal((await request(`/site-logs/${log.id}/decision`,{decision:'approve'},'POST',reviewer.id,'approver')).status,200);
   assert.equal((await constructionReport(a)).cash_available,cash);assert.equal((await constructionReport(a)).actual_cost,34227900);
  });
  await t.test('concurrent edits enforce the saved version',async()=>{
   const body={work_date:'2026-10-18',version:0,content:{labor:[],materials:[],expense_ids:[],photo_ids:[],note:'Site inspection'}};
   const draft=await request('/site-logs',body,'PUT');assert.equal(draft.status,200,JSON.stringify(draft.data));
   const attempts=await Promise.all([request('/site-logs',{...body,version:1},'PUT'),request('/site-logs',{...body,version:1,content:{...body.content,note:'Another edit'}},'PUT')]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
  });
  await t.test('two bills cannot reserve the same wastage recovery',async()=>{
   const entry=await prisma.constructionMaterialEntry.findFirstOrThrow({where:{projectId:project.id,kind:'waste',chargeContractId:{not:null}}}),ct=await prisma.constructionContract.findUniqueOrThrow({where:{id:entry.chargeContractId}});
   const body={contract_id:ct.id,cumulative_certified:ct.certifiedAmount+1000000,advance_recovery:0,bill_date:'2026-10-21',waste_entry_ids:[entry.id]};
   const attempts=await Promise.all([request('/running-bills',{...body,request_key:randomUUID()}),request('/running-bills',{...body,request_key:randomUUID()})]);assert.deepEqual(attempts.map(r=>r.status).sort(),[201,409]);
   const bill=attempts.find(r=>r.status===201).data.data;assert.equal(bill.wastageDeduction,entry.quantity*entry.unitRate);
   assert.equal((await request(`/running-bills/${bill.id}/decision`,{decision:'approve'},'POST',reviewer.id,'approver')).status,200);
   const report=await constructionReport(a);assert.equal(report.actual_cost,34227900+1000000-bill.wastageDeduction);
  });
 }finally{await new Promise(r=>server.close(r));await prisma.$disconnect();}
});
