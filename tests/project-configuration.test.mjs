import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import express from 'express';
import { prisma } from '../dist/core/prisma/client.js';
import { membershipsRouter } from '../dist/modules/memberships/memberships.routes.js';
import { projectsRouter } from '../dist/modules/projects/projects.routes.js';
import { depositsRouter } from '../dist/modules/deposits/deposits.routes.js';
import { onboardingRouter } from '../dist/modules/onboarding/onboarding.routes.js';
import { provisionTenant } from '../dist/modules/tenants/tenants.service.js';
import { signAccessToken } from '../dist/core/security/jwt.js';
import { createTrialSubscription } from '../dist/core/subscription/subscription.service.js';
import { normalizePortalSettings, portalSettingsSchema } from '../dist/core/projects/project-settings.js';
let server, url, project, members, roles, deposits, due, account, receipts, progress, notifications, scopeQueries;
const owner = { id: 'owner', tenantId: 'tenant', name: 'Owner', mobile: 'e:owner', email: null, isActive: true };
const matches = (row, where) => row && Object.entries(where).every(([key, val]) => val === undefined || (typeof val === 'object' && val !== null ? key === 'role' ? val.in.includes(row[key]) : true : row[key] === val));
const clean = data => Object.fromEntries(Object.entries(data).filter(([, val]) => val !== undefined));
function reset() {
 project = { id: 'project', tenantId: 'tenant', name: 'Fund', totalShares: 10, projectType: 'fund_shares', portalSettings: null, isActive: true, logoFileId: null };
 members = []; roles = [{ id:'owner-role', projectId:'project', tenantId:'tenant', userId:'owner', role:'owner', isActive:true, memberId:null }]; deposits=[]; receipts=[]; notifications=[]; scopeQueries=[];
 account={ id:'account', tenantId:'tenant', projectId:'project', balance:0 };
 due={ id:'due', tenantId:'tenant', projectId:'project', memberId:'member', scheduleId:'schedule', amount:1000, paidAmount:0, waivedAmount:0, penaltyDue:0, penaltyPaid:0, status:'due', dueDate:new Date(), paidAt:null };
 progress={tenantId:'tenant',projectId:'project',status:'in_progress',organizationStepStatus:'done',accountantStepStatus:'pending',accountsStepStatus:'pending',shareholdersStepStatus:'pending',accountantUserId:null,incomeApprovalFlow:'accountant_and_approver',expenseApprovalFlow:'accountant_and_approver',completedAt:null};
}
before(async () => {
 prisma.upload.count=async()=>0; prisma.project.count=async()=>1;
 prisma.$queryRaw=async()=>[];
 prisma.$transaction=async fn=>fn(prisma);
 prisma.project.findFirst=async ({where})=>matches(project,where)?structuredClone(project):null;
 prisma.project.findFirstOrThrow=async ({where})=>{scopeQueries.push(where);if(!matches(project,where)) throw new Error('Project not found');return structuredClone(project);};
 prisma.project.create=async ({data})=>(project={...project,...clean(data),id:'project'});
 prisma.project.update=async ({data})=>(project={...project,...clean(data)});
 prisma.tenant.findUnique=async ({where})=>where.slug?null:{id:'tenant',name:'Business',slug:'business',contact:{subscription:createTrialSubscription(182)}};
 prisma.tenant.findUniqueOrThrow=async ()=>({id:'tenant',name:'Business',slug:'business',contact:{subscription:createTrialSubscription(182)}});
 prisma.tenant.create=async ({data})=>({id:'tenant',...data});
 prisma.user.findFirst=async()=>null;
 prisma.user.findFirstOrThrow=async()=>owner;
 prisma.user.findUniqueOrThrow=async()=>owner;
 prisma.user.update=async({where,data})=>({...owner,id:where.id,...data});
 prisma.user.create=async ({data})=>({...owner,...data});
 prisma.user.upsert=async ({create})=>({id:'accountant',isActive:true,...create});
 prisma.user.findMany=async()=>[];
 prisma.session.create=async ({data})=>({id:'session',...data});prisma.session.update=async()=>({});
 prisma.session.findFirst=async({where})=>({id:'session',tenantId:'tenant',userId:where.userId,activeProjectId:'project',user:{...owner,id:where.userId,lastActiveAt:new Date()}});
 prisma.onboardingProgress.create=async ({data})=>(progress={...data});
 prisma.onboardingProgress.findUnique=async()=>structuredClone(progress);
 prisma.onboardingProgress.update=async ({data})=>(progress={...progress,...clean(data)});
 prisma.projectMembership.findFirst=async ({where})=>roles.find(row=>matches(row,where))??null;
 prisma.projectMembership.findMany=async ({where})=>roles.filter(row=>matches(row,where));
 prisma.projectMembership.create=async({data})=>{const row={id:`role-${roles.length}`,isActive:true,memberId:null,...data};roles.push(row);return row;};
 prisma.projectMembership.upsert=async({where,update,create})=>{const row=roles.find(row=>matches(row,where.projectId_userId_role));return row?Object.assign(row,update):prisma.projectMembership.create({data:create});};
 prisma.projectMembership.update=async({where,data})=>{const row=roles.find(row=>matches(row,where));return Object.assign(row,data);};
 prisma.projectMembership.updateMany=async({where,data})=>{const rows=roles.filter(row=>matches(row,where));rows.forEach(row=>Object.assign(row,data));return{count:rows.length};};
 prisma.member.findFirst=async({where})=>where.id==='member'?{id:'member',name:'Actual member',email:null,status:'active'}:members.find(row=>matches(row,where))??null;
 prisma.member.findUnique=async()=>({email:null});
 prisma.member.aggregate=async()=>({_sum:{shares:members.reduce((n,row)=>n+row.shares,0)}});
 prisma.member.count=async()=>members.length;
 prisma.member.create=async({data})=>{const row={id:`member-${members.length+1}`,...data};members.push(row);return row;};
 prisma.account.create=async({data})=>({id:'account',...data});
 prisma.account.findFirst=async({where})=>matches(account,where)?structuredClone(account):null;
 prisma.account.findFirstOrThrow=async({where})=>{if(!matches(account,where))throw new Error('Account not found');return structuredClone(account);};
 prisma.account.count=async()=>1;
 prisma.account.update=async({data})=>{account.balance+=data.balance.increment;return structuredClone(account);};
 prisma.due.findMany=async({where})=>due.tenantId===where.tenantId&&due.projectId===where.projectId&&due.memberId===where.memberId?[structuredClone(due)]:[];
 prisma.due.update=async({data})=>(due={...due,...data});
 prisma.deposit.create=async({data})=>{const row={id:`deposit-${deposits.length}`,createdAt:new Date(),accountantById:null,approvalRoute:'accountant',...data};deposits.push(row);return structuredClone(row);};
 prisma.deposit.findFirst=async({where})=>{const row=deposits.find(row=>matches(row,where));return row?structuredClone(row):null;};
 prisma.deposit.findUniqueOrThrow=async({where})=>structuredClone(deposits.find(row=>row.id===where.id));
 prisma.deposit.findMany=async({where})=>deposits.filter(row=>matches(row,where));
 prisma.deposit.updateMany=async({where,data})=>{const rows=deposits.filter(row=>matches(row,where));rows.forEach(row=>Object.assign(row,data));return{count:rows.length};};
 prisma.deposit.update=async({where,data})=>{const row=deposits.find(row=>matches(row,where));return Object.assign(row,data);};
 prisma.depositAllocation.createMany=async()=>({count:1});
 prisma.depositAllocation.findMany=async()=>[{due:{...structuredClone(due),schedule:{name:"Schedule"}}}];
 prisma.depositAllocation.updateMany=async()=>({count:1});
 prisma.receipt.create=async({data})=>{const row={id:`receipt-${receipts.length}`,...data};receipts.push(row);return row;};
 prisma.accountTransaction.create=async({data})=>({id:'transaction',...data});
 prisma.paymentCommitment.findFirst=async()=>null;
 prisma.whatsAppConnection.findFirst=async()=>null;
 prisma.activity.create=async({data})=>data;
 prisma.notification.createMany=async({data})=>{notifications.push(...data);return{count:data.length};};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.auth={tenantId:'tenant',projectId:'project',userId:req.header('x-role')==='member'?'member-user':'owner',roles:[req.header('x-role')??'admin'],memberId:'member'};next();});
 app.use('/memberships',membershipsRouter);app.use('/projects',projectsRouter);app.use('/deposits',depositsRouter);app.use('/onboarding',onboardingRouter);
 app.use((error,_req,res,_next)=>res.status(error.statusCode??500).json({error:error.message}));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(reset);
after(async()=>{await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
async function request(path,body,role='admin',method='POST'){
 const token=signAccessToken({sessionId:'session',tenantId:'tenant',userId:role==='member'?'member-user':'owner'});
 const response=await fetch(url+path,{method,headers:{'content-type':'application/json','x-role':role,authorization:`Bearer ${token}`},...(body!==undefined?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};
}
const settings={deposit_review:'admin_only',member_shortcuts:['ledger'],accountant_shortcuts:['approvals','expenses']};
test('project creation defaults to Fund/Shares and leaves the creator access-only',async()=>{
 const res=await request('/projects',{name:'Fund',total_shares:10});assert.equal(res.status,201);assert.equal(members.length,0);assert.equal(res.body.data.project_type,'fund_shares');assert.deepEqual(roles.map(row=>row.role),['owner','admin']);
});
test('project creation explicitly links the owner only when selected',async()=>{
 assert.equal((await request('/projects',{name:'Fund',total_shares:10,owner_is_member:true})).status,201);assert.equal(members.length,1);assert.equal(members[0].shares,1);assert.ok(roles.some(row=>row.role==='member'));
});
for(const type of ['accounting','billing'])test(`${type} persists without a financial member or Fund shareholder onboarding`,async()=>{
 await provisionTenant({name:'Business',slug:'business',adminName:'Owner',adminMobile:'e:owner',projectType:type,ownerIsMember:true,source:'self_signup'});assert.equal(project.projectType,type);assert.equal(members.length,0);assert.equal(progress.shareholdersStepStatus,'skipped');
});
test('owner provisioning without opt-in does not seed a Member',async()=>{
 await provisionTenant({name:'Business',slug:'business',adminName:'Owner',adminMobile:'e:owner',source:'self_signup'});assert.equal(members.length,0);assert.equal(roles.at(-1).memberId,null);
});
test('project settings are scoped and only management can change them',async()=>{
 assert.equal((await request('/projects/project',{portal_settings:settings},'member','PATCH')).status,403);
 assert.equal((await request('/projects/foreign',{portal_settings:settings},'admin','PATCH')).status,403);
 assert.equal((await request('/projects/project',{portal_settings:settings},'admin','PATCH')).status,200);assert.deepEqual(project.portalSettings,settings);
});
test('settings reject duplicate or foreign shortcut keys, and allow hiding every shortcut',async()=>{
 assert.equal(portalSettingsSchema.safeParse({...settings,member_shortcuts:['members','members']}).success,false);
 assert.equal(portalSettingsSchema.safeParse({...settings,member_shortcuts:['approvals']}).success,false);
 assert.deepEqual(normalizePortalSettings({...settings,member_shortcuts:[],accountant_shortcuts:[]}).member_shortcuts,[]);
 assert.equal((await request('/projects/project',{portal_settings:{...settings,member_shortcuts:['delete_project']}},'admin','PATCH')).status,400);
});
test('onboarding can skip a separate accountant and settle that step without creating members',async()=>{
 const res=await request('/onboarding/skip',{step:'accounting'});assert.equal(res.status,200);assert.equal(progress.accountantStepStatus,'skipped');assert.equal(progress.incomeApprovalFlow,'accountant_only');assert.equal(members.length,0);
});
test('skipping accountant never silently removes an existing assigned accountant',async()=>{
 roles.push({id:'acc',tenantId:'tenant',projectId:'project',role:'accountant',isActive:true,userId:'accountant',memberId:null});assert.equal((await request('/onboarding/skip',{step:'accounting'})).status,400);assert.equal(progress.accountantStepStatus,'pending');
});
test('accountant onboarding has independent optional member linking',async()=>{
 const body={accountant:{name:'Accountant',mobile:'e:accountant'},approval_flow:{income:'accountant_and_approver',expense:'accountant_only'}};
 assert.equal((await request('/onboarding/accounting',body)).status,200);assert.equal(members.length,0);
 reset();assert.equal((await request('/onboarding/accounting',{...body,accountant_is_member:true})).status,200);assert.equal(members.length,1);assert.equal(members[0].shares,0);assert.ok(roles.some(row=>row.role==='member'&&row.userId==='accountant'));
});
const payment={member_id:'member',schedule_ids:['schedule'],account_id:'account',amount:1000,method:'cash',proof_file_id:'proof'};
for(const kind of ['ordinary','advance'])test(`${kind} member submission without accountant routes to admin without financial posting until approved`,async()=>{
 roles.push({id:'admin',tenantId:'tenant',projectId:'project',userId:'admin',role:'admin',isActive:true});
 const res=await request(kind==='advance'?'/deposits/advance':'/deposits',payment,'member');assert.equal(res.status,201,res.body.error);assert.equal(deposits[0].status,'pending_approver');assert.equal(deposits[0].approvalRoute,'admin');assert.equal(deposits[0].accountantById??null,null);assert.equal(account.balance,0);assert.equal(receipts.length,0);assert.deepEqual(notifications.map(row=>row.recipientUserId),['owner','admin']);
 assert.equal((await request(`/deposits/${deposits[0].id}/confirm`,{},'approver')).status,403);assert.equal(account.balance,0);
 const confirmation=await request(`/deposits/${deposits[0].id}/confirm`,{},'admin');assert.equal(confirmation.status,200,confirmation.body.error);assert.equal(account.balance,1000);assert.equal(receipts.length,1);assert.equal(deposits[0].accountantById??null,null);
 assert.equal((await request(`/deposits/${deposits[0].id}/confirm`,{},'admin')).status,400);assert.equal(account.balance,1000);assert.equal(receipts.length,1);
});
test('an active accountant preserves the two-stage route, but admin-only overrides it',async()=>{
 roles.push({id:'acc',tenantId:'tenant',projectId:'project',userId:'accountant',role:'accountant',isActive:true});
 assert.equal((await request('/deposits',payment,'member')).status,201);assert.equal(deposits[0].status,'pending_accountant');assert.equal(deposits[0].approvalRoute,'accountant');
 project.portalSettings=settings;assert.equal((await request('/deposits/advance',payment,'accountant')).status,201);assert.equal(deposits[1].status,'pending_approver');assert.equal(deposits[1].approvalRoute,'admin');assert.equal(deposits[1].accountantById??null,null);
});
test('admin can finalize a legacy accountant queue when the accountant is removed',async()=>{
 await prisma.deposit.create({data:{...payment,tenantId:'tenant',projectId:'project',memberId:'member',accountId:'account',allocate:'advance',status:'pending_accountant'}});
 const res=await request('/deposits/deposit-0/approve',{},'admin');assert.equal(res.status,200,res.body.error);assert.equal(deposits[0].status,'confirmed');assert.equal(receipts.length,1);
});
test('concurrent admin confirmation cannot post the same deposit twice',async()=>{
 await request('/deposits/advance',payment,'member');const results=await Promise.all([request('/deposits/deposit-0/confirm',{},'admin'),request('/deposits/deposit-0/confirm',{},'admin')]);assert.equal(results.filter(row=>row.status===200).length,1);assert.equal(account.balance,1000);assert.equal(receipts.length,1);
});
test('foreign accounts and members are rejected before a deposit is created',async()=>{
 assert.equal((await request('/deposits',{...payment,account_id:'foreign'},'member')).status,404);assert.equal((await request('/deposits/advance',{...payment,member_id:'foreign'},'member')).status,403);assert.equal(deposits.length,0);
 assert.ok(scopeQueries.every(query=>query.tenantId==='tenant'&&query.id==='project'));
});

test('admin can explicitly tag the existing owner as a member without changing owner access',async()=>{
 const res=await request('/memberships/owner-role',{also_member:true},'admin','PATCH');assert.equal(res.status,200,res.body.error);assert.equal(members.length,1);assert.equal(members[0].shares,0);assert.equal(roles.find(row=>row.id==='owner-role').role,'owner');assert.ok(roles.some(row=>row.role==='member'&&row.userId==='owner'));
});
test('onboarding can defer all shareholders without adding an access-only owner or accountant',async()=>{
 progress.accountantStepStatus='skipped';progress.accountsStepStatus='done';const res=await request('/onboarding/skip',{step:'shareholders'});assert.equal(res.status,200,res.body.error);assert.equal(progress.status,'completed');assert.equal(members.length,0);assert.deepEqual(roles.map(row=>row.role),['owner']);
});

test('automatic routing with an accountant still requires two reviews before posting',async()=>{
 roles.push({id:'acc',tenantId:'tenant',projectId:'project',userId:'accountant',role:'accountant',isActive:true});
 await request('/deposits',payment,'member');
 const reviewed=await request('/deposits/deposit-0/approve',{},'accountant');assert.equal(reviewed.status,200,reviewed.body.error);assert.equal(deposits[0].status,'pending_approver');assert.equal(account.balance,0);assert.equal(receipts.length,0);
 assert.equal((await request('/deposits/deposit-0/confirm',{},'admin')).status,200);assert.equal(account.balance,1000);assert.equal(receipts.length,1);
});

test('billing and construction creation supply type-specific menus without requiring a share target',async()=>{
 assert.equal((await request('/projects',{name:'Fund without target'})).status,400);
 const b=await request('/projects',{name:'Billing office',project_type:'billing'});assert.equal(b.status,201);assert.equal(b.body.data.total_shares,1);assert.ok(b.body.data.billing_menus.some(m=>m.key==='billing_invoices'));assert.deepEqual(b.body.data.portal_settings.member_shortcuts,[]);
 const c=await request('/projects',{name:'Building site',project_type:'construction'});assert.equal(c.status,201);assert.equal(c.body.data.project_type,'construction');assert.ok(c.body.data.construction_menus.some(m=>m.key==='construction_boq'));assert.ok(c.body.data.portal_settings.accountant_shortcuts.includes('construction_running_bills'));
});
