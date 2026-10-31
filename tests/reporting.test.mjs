import { fixtureTransactionClient, installAccountRelationFixtures, normalizedTenantProjection } from './helpers/normalized-fixtures.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import nodemailer from 'nodemailer';
import { rm } from 'node:fs/promises';
import * as XLSX from 'xlsx';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET='reporting-isolated-test-secret';
process.env.UPLOAD_STORAGE='local';
process.env.UPLOAD_LOCAL_DIR=`/tmp/fundledger-reporting-test-${process.pid}`;
delete process.env.REPORTS_AUTOMATION_ENABLED;
const { prisma }=await import('../dist/core/prisma/client.js');
const { reportsRouter }=await import('../dist/modules/reports/report.routes.js');
const { integrationsRouter,telegramWebhookRouter }=await import('../dist/modules/integrations/integrations.routes.js');
const { errorHandler }=await import('../dist/core/http/error-handler.js');
const policy=await import('../dist/modules/reports/report.policy.js');
const { buildReport,workbookFiles }=await import('../dist/modules/reports/report.workbook.js');
const { deliverExport,validateDestinations,getExport }=await import('../dist/modules/reports/report.service.js');
const { runReportsWorker }=await import('../dist/modules/reports/report.worker.js');
const { receiveTelegramUpdate,confirmTelegramLink,checkWebhookSecret }=await import('../dist/modules/integrations/telegram.service.js');
const scope={tenantId:'tenant',projectId:'project',userId:'admin'};
let server,base,deliveries,notifications,fetchCalls,exportLookups,link;
const originalFetch=globalThis.fetch;
const baseReport={id:'report',tenantId:'tenant',projectId:'project',status:'ready',files:[],preview:{project_name:'Project',date:'2026-10-15',stats:{collected:100,spent:20,balance:80,outstanding:50}},deliveries:[]};
before(async()=>{
 const app=express();app.use(express.json());app.use('/webhook',telegramWebhookRouter);
 app.use((req,_res,next)=>{req.auth={...scope,roles:[req.header('x-test-role')??'admin']};next();});
 app.use('/reports',reportsRouter);app.use('/integrations',integrationsRouter);app.use(errorHandler);
 await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',resolve);});base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await rm(process.env.UPLOAD_LOCAL_DIR,{recursive:true,force:true});globalThis.fetch=originalFetch;await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
beforeEach(()=>{
 globalThis.fetch=originalFetch;deliveries=[];notifications=[];fetchCalls=0;exportLookups=[];
 delete process.env.REPORTS_AUTOMATION_ENABLED;
 prisma.projectMembership.findMany=async()=>[{userId:'staff',role:'accountant',user:{id:'staff',name:'Staff',email:'staff@example.test'}},{userId:'no-email',role:'auditor',user:{id:'no-email',name:'No email',email:null}}];
 prisma.telegramConnection.findFirst=async()=>null;
 prisma.reportExport.findFirst=async({where})=>{exportLookups.push(where);return where.id==='report'&&where.tenantId==='tenant'&&where.projectId==='project'?{...baseReport,deliveries}:null;};
 prisma.reportDelivery.upsert=async({where,create})=>{const key=where.exportId_channel_target;let row=deliveries.find(d=>d.exportId===key.exportId&&d.channel===key.channel&&d.target===key.target);if(!row){row={id:`d-${deliveries.length}`,status:'pending',attempts:0,...create};deliveries.push(row);}return {...row};};
 prisma.reportDelivery.updateMany=async({where,data})=>{const row=deliveries.find(d=>d.id===where.id&&where.status.in.includes(d.status));if(!row)return{count:0};row.status=data.status;row.attempts++;return{count:1};};
 prisma.reportDelivery.update=async({where,data})=>{const row=deliveries.find(d=>d.id===where.id);Object.assign(row,data);return row;};
 prisma.reportDelivery.findFirst=async()=>null;
 prisma.notification.create=async({data})=>{notifications.push(data);return data;};
 link={id:'link',tenantId:'tenant',projectId:'project',userId:'admin',chatId:null,expiresAt:new Date(Date.now()+60000),consumedAt:null};
 prisma.telegramLink.findUnique=async()=>link;
 prisma.telegramLink.findFirst=async()=>link;
installAccountRelationFixtures(prisma);
 // Reset transaction mocks between tests; file storage also uses a transaction for its project lock.
 prisma.$transaction=async fn=>fn(fixtureTransactionClient(prisma));
 prisma.$queryRaw=async()=>[];
 prisma.project.findFirst=async()=>({id:'project',name:'Project'});
});
async function request(path,body,role='admin') { const response=await originalFetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','x-test-role':role},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,json:await response.json()}; }
test('configuration and all mutations are admin only',async()=>{
 for(const role of ['member','accountant','auditor','approver']) {
  assert.equal((await request('/reports/configuration',undefined,role)).status,403);
  assert.equal((await request('/reports/exports',{sheets:['summary']},role)).status,403);
  assert.equal((await request('/integrations',undefined,role)).status,403);
 }
});
test('staff can read only reports explicitly delivered to their own inbox',async()=>{
 assert.equal((await request('/reports/exports/report',undefined,'accountant')).status,403);
 prisma.reportDelivery.findFirst=async({where})=>where.target==='admin'&&where.report.tenantId==='tenant'&&where.report.projectId==='project'?{id:'delivery'}:null;
 assert.equal((await request('/reports/exports/report',undefined,'accountant')).status,200);
 assert.deepEqual(exportLookups.at(-1),{tenantId:'tenant',projectId:'project',id:'report'});
});
test('foreign report ids return 404 with tenant and project filters',async()=>{
 await assert.rejects(getExport({...scope,roles:['admin'],sessionId:'session'},'foreign'),/not found/);
 assert.deepEqual(exportLookups[0],{tenantId:'tenant',projectId:'project',id:'foreign'});
});
test('validates destinations before delivery, including cross-project ids and missing emails',async()=>{
 for(const d of [{email:true,inbox:false,telegram:false,recipient_ids:['foreign']},{email:true,inbox:false,telegram:false,recipient_ids:['no-email']},{email:false,inbox:false,telegram:true,recipient_ids:[]}]) await assert.rejects(validateDestinations(scope,d));
 assert.equal(notifications.length,0);
});
test('repeat and concurrent sends claim each inbox recipient once',async()=>{
 const destination={email:false,inbox:true,telegram:false,recipient_ids:['staff']};
 await Promise.all([deliverExport(scope,'report',destination),deliverExport(scope,'report',destination)]);
 await deliverExport(scope,'report',destination);
 assert.equal(notifications.length,1);assert.equal(deliveries[0].status,'sent');assert.equal(deliveries[0].attempts,1);
 assert.equal(notifications[0].entityType,'report_export');assert.equal(notifications[0].entityId,'report');
});
test('failed delivery remains failed until explicit retry, then does not resend success',async()=>{
 const destination={email:false,inbox:true,telegram:false,recipient_ids:['staff']};
 prisma.notification.create=async()=>{throw Error('Temporary inbox failure');};
 await deliverExport(scope,'report',destination);assert.equal(deliveries[0].status,'failed');
 await deliverExport(scope,'report',destination);assert.equal(deliveries[0].attempts,1);
 prisma.notification.create=async({data})=>{notifications.push(data);return data;};
 await deliverExport(scope,'report',destination,true);await deliverExport(scope,'report',destination,true);
 assert.equal(notifications.length,1);assert.equal(deliveries[0].attempts,2);assert.equal(deliveries[0].status,'sent');
});
test('empty or invalid schedules and exports are rejected',()=>{
 assert.equal(policy.exportSchema.safeParse({sheets:[]}).success,false);
 const valid={enabled:true,time:'21:00',timezone:'Asia/Dhaka',days:[1],sheets:['summary'],recipient_ids:['staff'],email:true,inbox:false,telegram:false};
 assert.equal(policy.scheduleSchema.safeParse(valid).success,true);
 for(const extra of [{days:[]},{time:'24:00'},{timezone:'not/a-zone'},{recipient_ids:[]},{email:false}]) assert.equal(policy.scheduleSchema.safeParse({...valid,...extra}).success,false);
});
test('date ranges use project timezone and preserve leap-month boundaries',()=>{
 const range=policy.reportRange(new Date('2024-03-01T01:00:00Z'),'Asia/Dhaka','last');
 assert.equal(range.from,'2024-02-01');assert.equal(range.until,'2024-03-01');assert.equal(range.start.toISOString(),'2024-01-31T18:00:00.000Z');
 assert.equal(policy.localMidnight('2026-03-09','America/New_York').toISOString(),'2026-03-09T04:00:00.000Z');
});
test('workbook uses correct transfer flows, waivers and penalties and preserves formula-like text',async()=>{
 const now=new Date('2026-10-15T12:00:00Z');
 const dues=[{memberId:'m',amount:100,waivedAmount:20,paidAmount:40,penaltyDue:10,penaltyPaid:3}];
 const todayTx=[{id:'a',accountId:'bank',direction:'transfer',referenceId:'transfer',referenceType:'transfer',amount:30,createdAt:now},{id:'b',accountId:'cash',direction:'transfer',referenceId:'transfer',referenceType:'transfer',amount:30,createdAt:now},{id:'c',accountId:'cash',direction:'money_in',referenceType:'deposit',amount:100,createdAt:now}];
 let txCalls=0;
 prisma.$transaction=async(fn,opts)=>{assert.equal(opts.isolationLevel,'RepeatableRead');return fn(fixtureTransactionClient(prisma));};
 prisma.project.findFirst=async()=>({name:'Committee'});
 prisma.account.findMany=async()=>[{id:'bank',name:'Bank',type:'bank',balance:70},{id:'cash',name:'Cash',type:'cash',balance:130}];
 prisma.due.findMany=async()=>dues;
 prisma.accountTransaction.findMany=async()=>++txCalls===1?todayTx:[];
 prisma.member.findMany=async()=>[{id:'m',name:'=HYPERLINK("evil")',status:'active',shares:1}];
 prisma.deposit.groupBy=async()=>[{memberId:'m',_max:{confirmedAt:now}}];
 prisma.transfer.findMany=async()=>[{id:'transfer',fromAccountId:'bank',toAccountId:'cash'}];
 const report=await buildReport(scope,{sheets:['summary','members','banks','ie'],period:'month',layout:'one',timezone:'Asia/Dhaka'},now);
 assert.equal(report.stats.outstanding,47);assert.equal(report.stats.collected,100);assert.equal(report.stats.spent,0);
 const accounts=report.sheets.find(s=>s.key==='banks');assert.deepEqual(accounts.rows[1],['Bank','bank',100,0,30,70]);assert.deepEqual(accounts.rows[2],['Cash','cash',0,130,0,130]);
 const files=workbookFiles(report,'one');assert.equal(files.length,1);assert.equal(files[0].buffer.subarray(0,2).toString(),'PK');
 const workbook=XLSX.read(files[0].buffer,{type:'buffer'});assert.equal(workbook.SheetNames.length,4);assert.equal(workbook.Sheets.Members.A2.t,'s');assert.equal(workbook.Sheets.Members.A2.f,undefined);
 assert.equal(workbookFiles(report,'sep').length,4);
});
test('worker does nothing until explicit server opt-in',async()=>{
 let called=false;prisma.reportSchedule.findMany=async()=>{called=true;return[];};
 await runReportsWorker();assert.equal(called,false);
});
test('webhook rejects wrong or missing secrets without processing a group',async()=>{
 process.env.TELEGRAM_WEBHOOK_SECRET='webhook-secret';
 assert.throws(()=>checkWebhookSecret(undefined));assert.throws(()=>checkWebhookSecret('wrong'));
 assert.doesNotThrow(()=>checkWebhookSecret('webhook-secret'));
 assert.equal((await request('/webhook',{message:{text:'/connect FL-0123456789ABCDEF'}})).status,401);
});
test('expired and non-admin Telegram pairing messages cannot bind a group',async()=>{
 process.env.TELEGRAM_BOT_TOKEN='test';process.env.TELEGRAM_BOT_USERNAME='TestBot';
 let updates=0;
 prisma.telegramLink.updateMany=async()=>{updates++;return{count:1};};
 globalThis.fetch=async()=>{fetchCalls++;return new Response(JSON.stringify({ok:true,result:{status:'member'}}));};
 const update={message:{text:'/connect FL-0123456789ABCDEF',chat:{id:-1,type:'supergroup',title:'Group'},from:{id:2}}};
 link.expiresAt=new Date(Date.now()-1);await receiveTelegramUpdate(update);assert.equal(fetchCalls,0);
 link.expiresAt=new Date(Date.now()+60000);await receiveTelegramUpdate(update);assert.equal(updates,0);
 link.consumedAt=new Date();await assert.rejects(confirmTelegramLink(scope,'link'));assert.equal(updates,0);
});
test('a verified group command binds only an unclaimed non-expired pairing request',async()=>{
 let filter;
 prisma.telegramLink.updateMany=async({where})=>{filter=where;return{count:1};};
 globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:{status:'administrator'}}));
 await receiveTelegramUpdate({message:{text:'/connect@TestBot FL-0123456789ABCDEF',chat:{id:-1,type:'supergroup',title:'Verified Group'},from:{id:2}}});
 assert.equal(filter.chatId,null);assert.equal(filter.consumedAt,null);assert.ok(filter.expiresAt.gt instanceof Date);
});
test('scheduler respects local weekdays and author access and skips an existing daily slot',async()=>{
 process.env.REPORTS_AUTOMATION_ENABLED='true';let slots=[];
 const s={...scope,updatedById:'admin',updatedAt:new Date('2026-10-14T10:00:00Z'),enabled:true,time:'21:00',timezone:'Asia/Dhaka',days:[4],project:{tenant:{contact:{}},isActive:true}};
 prisma.reportSchedule.findMany=async()=>normalizedTenantProjection([s]);
 prisma.projectMembership.findFirst=async()=>({role:'admin'});
 prisma.reportExport.findUnique=async({where})=>{slots.push(where.scheduleSlot);return{id:'already-generated'};};
 prisma.telegramConnection.findMany=async()=>[];
 prisma.reportDelivery.updateMany=async()=>({count:0});prisma.reportExport.updateMany=async()=>({count:0});prisma.telegramLink.deleteMany=async()=>({count:0});
 // Subscription service grants access only with a configured subscription; use a future trial.
 s.project.tenant.contact={subscription:{status:'trial',trial_ends_at:'2099-01-01T00:00:00.000Z'}};
 // Reuse the repository's actual trial shape.
 const { createOneMonthTrial }=await import('../dist/core/subscription/subscription.service.js');
 s.project.tenant.contact={subscription:createOneMonthTrial(new Date('2026-10-01T00:00:00Z'))};
 await runReportsWorker(new Date('2026-10-15T14:59:00Z'));assert.equal(slots.length,0);
 await runReportsWorker(new Date('2026-10-15T15:00:00Z'));assert.deepEqual(slots,['project:2026-10-15']);
 prisma.projectMembership.findFirst=async()=>null;slots=[];
 await runReportsWorker(new Date('2026-10-15T15:01:00Z'));assert.equal(slots.length,0);
});

test('email delivery attaches the generated bytes and does not resend accepted mail',async()=>{
 const { env }=await import('../dist/config/env.js');
 const { storeObject }=await import('../dist/core/storage/object-storage.service.js');
 const oldTransport=nodemailer.createTransport,oldSmtp={...env.smtp};let messages=[];
 env.smtp.user='test';env.smtp.pass='test';
 nodemailer.createTransport=()=>({sendMail:async message=>{messages.push(message);}});
 const bytes=Buffer.from('PK\x03\x04test-workbook');
 await storeObject({storageKey:'tenant/project/reports/report/test.xlsx',buffer:bytes});
 baseReport.files=[{filename:'test.xlsx',size:bytes.length,storage_key:'tenant/project/reports/report/test.xlsx'}];
 try {
  await deliverExport(scope,'report',{email:true,inbox:false,telegram:false,recipient_ids:['staff']});
  await deliverExport(scope,'report',{email:true,inbox:false,telegram:false,recipient_ids:['staff']});
  assert.equal(messages.length,1);assert.equal(messages[0].to,'staff@example.test');
  assert.equal(messages[0].attachments[0].filename,'test.xlsx');assert.deepEqual(messages[0].attachments[0].content,bytes);
 } finally {baseReport.files=[];nodemailer.createTransport=oldTransport;Object.assign(env.smtp,oldSmtp);}
});

test('custom export ranges validate dates and use inclusive end dates in project timezones',async()=>{
 const base={sheets:['ie'],period:'custom',layout:'one',timezone:'Asia/Dhaka'};
 for(const input of [{},{from:'2026-10-01'},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-10-31',to:'2026-10-01'},{from:'bad',to:'2026-10-01'}]) {
  assert.equal(policy.exportSchema.safeParse({...base,...input}).success,false);
  assert.equal((await request('/reports/exports',{...base,...input})).status,400);
 }
 assert.equal(policy.exportSchema.safeParse({...base,from:'2024-02-29',to:'2024-02-29'}).success,true);
 const now=new Date('2026-10-31T12:00:00Z');
 const dhaka=policy.reportRange(now,'Asia/Dhaka','custom',{from:'2026-10-01',to:'2026-10-31'});
 assert.equal(dhaka.start.toISOString(),'2026-09-30T18:00:00.000Z');assert.equal(dhaka.end.toISOString(),'2026-10-31T18:00:00.000Z');assert.equal(dhaka.until,'2026-11-01');
 const dst=policy.reportRange(now,'America/New_York','custom',{from:'2026-03-08',to:'2026-03-08'});
 assert.equal(dst.start.toISOString(),'2026-03-08T05:00:00.000Z');assert.equal(dst.end.toISOString(),'2026-03-09T04:00:00.000Z');
 assert.equal((dst.end-dst.start)/3600000,23);
 const fall=policy.reportRange(now,'America/New_York','custom',{from:'2026-11-01',to:'2026-11-01'});
 assert.equal((fall.end-fall.start)/3600000,25);
 assert.throws(()=>policy.reportRange(now,'Asia/Dhaka','custom'),/valid custom/);
});
test('custom workbook filters occurred-on dates and legacy timestamps with an exclusive next-midnight bound',async()=>{
 const now=new Date('2026-10-31T12:00:00Z'), captured=[];
 prisma.$transaction=async fn=>fn(fixtureTransactionClient(prisma));
 prisma.project.findFirst=async()=>({name:'Custom report'});prisma.account.findMany=async()=>[];prisma.due.findMany=async()=>[];
 const base={account:{name:'Cash'},accountId:'cash',direction:'money_in',referenceType:'income',amount:10,incomeCategory:null,incomeCustomer:null};
 const entries=[
  {...base,id:'before',occurredOn:null,createdAt:new Date('2026-09-30T17:59:59.999Z')},
  {...base,id:'start',occurredOn:null,createdAt:new Date('2026-09-30T18:00:00.000Z')},
  {...base,id:'end',occurredOn:null,createdAt:new Date('2026-10-31T17:59:59.999Z')},
  {...base,id:'after',occurredOn:null,createdAt:new Date('2026-10-31T18:00:00.000Z')},
  {...base,id:'date-start',occurredOn:new Date('2026-10-01T00:00:00Z'),createdAt:now},
  {...base,id:'date-end',occurredOn:new Date('2026-10-31T00:00:00Z'),createdAt:now},
  {...base,id:'date-after',occurredOn:new Date('2026-11-01T00:00:00Z'),createdAt:now},
 ];
 prisma.accountTransaction.findMany=async({where})=>{
  if(!where.OR)return[];
  captured.push(where);
  const date=where.OR[0].occurredOn,time=where.OR[1].createdAt;
  return entries.filter(t=>t.occurredOn?t.occurredOn>=date.gte&&t.occurredOn<date.lt:t.createdAt>=time.gte&&t.createdAt<time.lt);
 };
 const report=await buildReport(scope,{sheets:['ie'],period:'custom',from:'2026-10-01',to:'2026-10-31',layout:'one',timezone:'Asia/Dhaka'},now);
 assert.equal(captured[0].tenantId,'tenant');assert.equal(captured[0].projectId,'project');
 assert.equal(captured[0].OR[1].createdAt.lte,undefined);assert.equal(captured[0].OR[1].createdAt.lt.toISOString(),'2026-10-31T18:00:00.000Z');
 assert.equal(report.sheets[0].total_rows,4);assert.equal(report.period_from,'2026-10-01');assert.equal(report.period_until,'2026-11-01');
 const file=workbookFiles(report,'one')[0], workbook=XLSX.read(file.buffer,{type:'buffer'});
 assert.match(workbook.Props.Subject,/2026-10-01 to 2026-10-31 \(inclusive\)/);
 assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['Income & Expense']).length,4);
});
