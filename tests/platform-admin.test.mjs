import { fixtureTransactionClient, installNormalizedFixtures } from './helpers/normalized-fixtures.mjs';
import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {prisma} from '../dist/core/prisma/client.js';
import {env} from '../dist/config/env.js';
import {requireInternalApiKey} from '../dist/core/security/internal-api-key.middleware.js';
import {manualPaymentSchema,recordManualPayment} from '../dist/modules/internal/payments.service.js';
import {cleanupEligibility,tenantDeletionOrder,beginCleanup} from '../dist/modules/internal/cleanup.service.js';
import {allowancePeriod,monthlyPeriod} from '../dist/modules/assistant/assistant.policy.js';
import {organizationWorkbook} from '../dist/modules/internal/export.service.js';
let tenant,payments,audits;
const activeContact=()=>({subscription:{status:'active',package:'business',billing_cycle:'monthly',current_period_end_at:new Date(Date.now()+86400000).toISOString()}});
beforeEach(()=>{
 tenant={id:'org',name:'Test organization',slug:'test-org',currency:'BDT',contact:{},subscription:activeContact().subscription,updatedAt:new Date(),deletionStartedAt:null};payments=[];audits=[];
 prisma.$queryRaw=async()=>[{count:5n}];prisma.tenant.findUnique=async({where})=>where.id==='org'?tenant:null;prisma.tenant.findUniqueOrThrow=async()=>tenant;
 prisma.tenant.update=async({data})=>(tenant={...tenant,...data});
 prisma.platformPayment.findUnique=async({where})=>payments.find(p=>p.tenantId===where.tenantId_requestKey.tenantId&&p.requestKey===where.tenantId_requestKey.requestKey)??null;
 prisma.platformPayment.create=async({data})=>{const row={id:`payment-${payments.length}`,...data};payments.push(row);return row;};
 prisma.internalAudit.create=async({data})=>{audits.push(data);return data;};
 prisma.upload.count=async()=>7;prisma.project.count=async()=>2;
 prisma.$transaction=async callback=>{const snapshot=structuredClone({tenant,payments,audits});try{return await callback(fixtureTransactionClient(prisma));}catch(error){({tenant,payments,audits}=snapshot);throw error;}};
const fixtureUsers=[];installNormalizedFixtures(prisma,{users:()=>fixtureUsers,tenants:()=>[tenant]});
});
after(()=>prisma.$disconnect());
test('internal key fails closed when unset/short and rejects JWTs, wrong keys and query keys',()=>{
 const previous=env.internalApiKey;
 try{for(const [configured,key,status]of [[undefined,'abc',503],['short','short',503],['a'.repeat(40),undefined,401],['a'.repeat(40),'wrong',401],['a'.repeat(40),'a'.repeat(40),undefined]]){
  env.internalApiKey=configured;let error='not-called';
  requireInternalApiKey({get:name=>name==='x-internal-api-key'?key:'Bearer fake',query:{internal_api_key:'a'.repeat(40)}},{setHeader(){}},e=>{error=e;});
  assert.equal(error?.statusCode,status);
 }}finally{env.internalApiKey=previous;}
});
test('manual payment changes plan immediately, resets monthly counters and keeps actual capacity usage',async()=>{
 const input=manualPaymentSchema.parse({request_key:'6f22d132-73c4-4e34-8724-097078ba9423',package:'starter',billing_cycle:'monthly',amount:1000,currency:'BDT',method:'bank',reference:'test-only',paid_at:new Date().toISOString()});
 const oldEnd=new Date(tenant.subscription.current_period_end_at);
 const first=await recordManualPayment('org',input,'operator');
 assert.equal(first.replayed,false);assert.equal(tenant.subscription.package,'starter');assert.ok(new Date(tenant.subscription.current_period_end_at)>oldEnd);
 assert.equal(first.quota.documents.used,7);assert.equal(first.quota.users.used,5);assert.equal(first.quota.projects.used,2);
 assert.equal(first.quota.documents.limit,1000);assert.equal(first.quota.users.limit,20);
 const reset=tenant.subscription.quota_reset_at,now=new Date(Date.now()+1000);
 assert.equal(allowancePeriod({subscription:tenant.subscription},now).start.toISOString(),reset);
 const replay=await recordManualPayment('org',input,'operator');assert.equal(replay.replayed,true);assert.equal(payments.length,1);assert.equal(audits.length,1);assert.equal(tenant.subscription.quota_reset_at,reset);
 await assert.rejects(recordManualPayment('org',{...input,amount:2000},'operator'),/different data/);
 assert.equal(allowancePeriod(tenant.contact,new Date(monthlyPeriod(now).end.getTime()+1)).start.toISOString(),monthlyPeriod(new Date(monthlyPeriod(now).end.getTime()+1)).start.toISOString());
});
test('frozen organizations, unknown organizations and mismatched currency cannot accept manual payments',async()=>{
 const input=manualPaymentSchema.parse({request_key:'6f22d132-73c4-4e34-8724-097078ba9423',package:'business',billing_cycle:'yearly',amount:50000,method:'cash',reference:'test-only',paid_at:new Date().toISOString()});
 tenant.deletionStartedAt=new Date();await assert.rejects(recordManualPayment('org',input,'operator'),/cleanup has started/);
 tenant.deletionStartedAt=null;await assert.rejects(recordManualPayment('other',input,'operator'),/not found/);
 await assert.rejects(recordManualPayment('org',{...input,currency:'USD'},'operator'),/currency/);assert.equal(payments.length,0);
});
test('cleanup requires three calendar months after paid expiry and rejects active/trial-only tenants',()=>{
 const contact={subscription:{status:'expired',package:'starter',current_period_end_at:'2026-03-31T12:00:00Z'}};
 assert.equal(cleanupEligibility(contact,new Date('2026-06-30T11:59:59Z')).eligible,false);
 assert.equal(cleanupEligibility(contact,new Date('2026-06-30T12:00:00Z')).eligible,true);
 assert.equal(cleanupEligibility(activeContact()).eligible,false);
 assert.equal(cleanupEligibility({subscription:{status:'trial',package:'free',trial_ends_at:'2025-01-01T00:00:00Z'}}).eligible,false);
 assert.equal(cleanupEligibility({subscription:{current_period_end_at:'bad'}}).eligible,false);
});
test('cleanup deletion order respects financial restrictions and never includes global audit/OTP tables',async()=>{
 const order=tenantDeletionOrder();
 for(const [child,parent]of [['BillingAllocation','BillingPayment'],['BillingPayment','Account'],['ConstructionCostAllocation','Expense'],['FixedAssetJournal','FixedAsset'],['Member','TenantUser'],['SupportAttachment','SupportMessage'],['SupportMessage','SupportTicket']])assert.ok(order.indexOf(child)<order.indexOf(parent),`${child} before ${parent}`);
 assert.ok(!order.includes('InternalAudit'));assert.ok(!order.includes('TenantDeletionJob'));assert.ok(!order.includes('OtpCode'));
 env.internalApiKey='test-only-internal-key-that-is-long-enough';await assert.rejects(beginCleanup('org','bad.token','DELETE test-org','operator'),/Invalid cleanup preview/);
});
test('organization workbook contains complete scoped financial tabs and safe text values',async()=>{
 const project={id:'project',tenantId:'org',name:'Test project',projectType:'fund_shares',isActive:true,totalShares:1};
 prisma.project.findFirst=async({where})=>where.id==='project'&&where.tenantId==='org'?project:null;
 const data={project:[project],member:[{id:'member',tenantId:'org',projectId:'project',mid:'S1',name:'=1+1',mobile:'01711000001',email:null,shares:1,status:'active'}],due:[{id:'due',tenantId:'org',projectId:'project',memberId:'member',amount:1500,paidAmount:1000,waivedAmount:0,penaltyDue:50,penaltyPaid:10,dueDate:new Date(),status:'partial',schedule:{name:'Current'}}],account:[{id:'account',tenantId:'org',projectId:'project',name:'Bank',type:'bank',balance:900,accountNumber:'000123'}],accountTransaction:[{id:'income',tenantId:'org',projectId:'project',accountId:'account',amount:1000,direction:'money_in',referenceType:'income',createdAt:new Date(),balanceAfter:1000}],expense:[],deposit:[],fixedAsset:[],businessDocument:[],billingInvoice:[],billingPayment:[]};
 for(const [model,rows]of Object.entries(data))prisma[model].findMany=async({where})=>{assert.equal(where.tenantId,'org');if(model!=='project')assert.equal(where.projectId,'project');return rows;};
 const file=await organizationWorkbook('org','project'),book=XLSX.read(file.buffer,{type:'buffer'});
 for(const name of ['Summary','Member summary','Member dues','Bank and cash summary','Expenses','Income','Deposits','Fixed assets'])assert.ok(book.SheetNames.includes(name));
 const members=XLSX.utils.sheet_to_json(book.Sheets['Member summary']);assert.equal(members[0]['Paid principal'],1000);assert.equal(members[0].Outstanding,540);assert.equal(members[0].Mobile,'01711000001');
 assert.equal(book.Sheets['Member summary'].E2.t,'s');assert.equal(book.Sheets['Member summary'].E2.f,undefined);assert.equal(book.Sheets['Member summary'].E2.v,'=1+1');
 const banks=XLSX.utils.sheet_to_json(book.Sheets['Bank and cash summary']);assert.equal(banks[0]['Account number'],'000123');
 await assert.rejects(organizationWorkbook('org','foreign'),/not found/);
});
