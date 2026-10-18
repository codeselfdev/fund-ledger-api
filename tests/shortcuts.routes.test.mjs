import assert from 'node:assert/strict';
import { before,after,beforeEach,test } from 'node:test';
import express from 'express';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/isolated';
process.env.JWT_SECRET='shortcuts-isolated-tests';
const {randomUUID}=await import('node:crypto');
const {prisma}=await import('../dist/core/prisma/client.js');
const {Prisma}=await import('@prisma/client');
const {shortcutsRouter}=await import('../dist/modules/shortcuts/shortcuts.routes.js');
const {availableCatalog,defaultPins,MAX_PINS}=await import('../dist/modules/shortcuts/shortcuts.policy.js');
const {authenticate}=await import('../dist/core/security/auth.middleware.js');
const {signAccessToken,hashToken}=await import('../dist/core/security/jwt.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
let db,server,base,queue=Promise.resolve(),counter=0;
const clone=v=>structuredClone(v);
function matches(row,where={}){return !!row&&Object.entries(where).every(([key,value])=>{
 if(value===undefined)return true;
 if(key==='project')return matches(db.projects.find(p=>p.id===row.projectId),value);
 if(value&&typeof value==='object'&&!(value instanceof Date)){if('gt'in value)return row[key]>value.gt;if('in'in value)return value.in.includes(row[key]);}
 return value instanceof Date?row[key]?.getTime()===value.getTime():row[key]===value;
});}
function model(table){return {
 findFirst:async({where={}}={})=>clone(db[table].find(r=>matches(r,where))??null),
 findMany:async({where={}}={})=>clone(db[table].filter(r=>matches(r,where))),
 create:async({data})=>{if(table==='preferences'&&db.preferences.some(r=>r.tenantId===data.tenantId&&r.projectId===data.projectId&&r.userId===data.userId))throw new Prisma.PrismaClientKnownRequestError('unique',{code:'P2002',clientVersion:'test'});const row={id:randomUUID(),...clone(data)};db[table].push(row);return clone(row);},
 update:async({where,data})=>{const row=db[table].find(r=>matches(r,where));assert.ok(row);for(const[k,v]of Object.entries(data))row[k]=v&&typeof v==='object'&&'increment'in v?row[k]+v.increment:clone(v);return clone(row);}
};}
before(async()=>{
 prisma.member.findMany=async({where})=>db.memberships.filter(row=>row.tenantId===where.tenantId&&row.projectId===where.projectId&&row.userId===where.userId&&row.role==='member'&&row.isActive).map(row=>({id:row.memberId}));
 for(const[name,table]of Object.entries({project:'projects',shortcutPreference:'preferences',projectMembership:'memberships',session:'sessions'}))Object.assign(prisma[name],model(table));
 prisma.$transaction=async fn=>{const previous=queue;let release;queue=new Promise(r=>release=r);await previous;const snapshot=clone(db);try{return await fn(prisma);}catch(e){db=snapshot;throw e;}finally{release();}};
 const app=express();app.use(express.json());app.use(authenticate);app.use('/v1/shortcuts',shortcutsRouter);app.use(errorHandler);server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});base=`http://127.0.0.1:${server.address().port}/v1/shortcuts`;
});
beforeEach(()=>{counter=0;db={preferences:[],sessions:[],memberships:[],projects:[{id:'p',tenantId:'t',projectType:'fund_shares',isActive:true,portalSettings:null},{id:'accounting',tenantId:'t',projectType:'accounting',isActive:true,portalSettings:null},{id:'billing',tenantId:'t',projectType:'billing',isActive:true,portalSettings:null},{id:'construction',tenantId:'t',projectType:'construction',isActive:true,portalSettings:null},{id:'foreign',tenantId:'other',projectType:'fund_shares',isActive:true},{id:'inactive',tenantId:'t',projectType:'fund_shares',isActive:false}]};});
after(async()=>{await new Promise(r=>server.close(r));await prisma.$disconnect();});
function token(role,project,userId){const id=`s${++counter}`,value=signAccessToken({sessionId:id,tenantId:'t',userId});db.sessions.push({id,tenantId:'t',userId,tokenHash:hashToken(value),revokedAt:null,expiresAt:new Date(Date.now()+60000),activeProjectId:project,user:{isActive:true,lastActiveAt:new Date()}});db.memberships.push({tenantId:'t',projectId:project,userId,role,isActive:true,memberId:role==='member'?'member':null});return value;}
async function request(path='',body,role='admin',project='p',userId=`user-${role}`,method=body?'PUT':'GET'){
 const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token(role,project,userId)}`,'x-project-id':project,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()};
}
const put=(pinned,version=0,role='admin',project='p',userId=`user-${role}`)=>request('/preferences',{pinned,version},role,project,userId);

test('default admin Home matches the eight-pin design and has four separate quick-add actions',async()=>{
 const r=await request();assert.equal(r.status,200);assert.equal(r.data.version,0);assert.equal(r.data.max_pins,8);assert.deepEqual(r.data.pinned,['members','income','expenses','schedules','notices','reports','accounts','assets']);assert.deepEqual(r.data.groups.map(g=>g.label),['Money','Members','Communicate','Reports & setup']);assert.deepEqual(r.data.quick_add.map(t=>t.key),['add_member','add_income','add_expense','add_notice']);assert.equal(db.preferences.length,0);
});
test('personal pins keep exact order and synchronize across requests without changing project defaults',async()=>{
 const body=['assets','members','income'];const saved=await put(body);assert.equal(saved.status,200);assert.equal(saved.data.version,1);assert.deepEqual((await request()).data.pinned,body);assert.deepEqual(db.projects[0].portalSettings,null);assert.equal(db.preferences.length,1);
 const changed=await put(['income','assets','members'],1);assert.equal(changed.data.version,2);assert.deepEqual((await request()).data.pinned,['income','assets','members']);
});
test('empty pins are intentional and reset restores current defaults with a new revision',async()=>{
 assert.equal((await put([])).status,200);assert.deepEqual((await request()).data.pinned,[]);
 const r=await request('/reset',{version:1},'admin','p','user-admin','POST');assert.equal(r.status,200);assert.equal(r.data.version,2);assert.equal(r.data.pinned.length,8);
});
test('duplicates, unknown tools, quick-add keys, excessive pins and extra fields are rejected',async()=>{
 for(const body of [{pinned:['income','income'],version:0},{pinned:['unknown'],version:0},{pinned:['add_income'],version:0},{pinned:['income','expenses','accounts','schedules','recurring','assets','members','roles','reports'],version:0},{pinned:[],version:-1},{pinned:[],version:0,user_id:'someone-else'}])assert.equal((await request('/preferences',body)).status,400,JSON.stringify(body));assert.equal(db.preferences.length,0);
});
test('preferences are isolated by user and project and reject cross-tenant or inactive project contexts',async()=>{
 await put(['assets']);await put(['income'],0,'admin','p','another-user');await put(['sale'],0,'admin','accounting');
 assert.deepEqual((await request()).data.pinned,['assets']);assert.deepEqual((await request('',undefined,'admin','p','another-user')).data.pinned,['income']);assert.deepEqual((await request('',undefined,'admin','accounting')).data.pinned,['sale']);
 assert.equal((await request('',undefined,'admin','foreign')).status,404);assert.equal((await request('',undefined,'admin','inactive')).status,403);
});
test('a stale device cannot overwrite newer choices; identical one-revision retries are idempotent',async()=>{
 const first=await put(['assets','members']);assert.equal(first.status,200);assert.equal((await put(['assets','members'])).status,200);assert.equal(db.preferences[0].version,1);
 assert.equal((await put(['income'],0)).status,409);assert.deepEqual((await request()).data.pinned,['assets','members']);
 const results=await Promise.all([put(['income'],1),put(['expenses'],1)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(db.preferences[0].version,2);
});
test('role changes hide old pins and unauthorized tools cannot be pinned',async()=>{
 await put(['reports','roles','assets','income'],0,'admin','p','same-user');db.memberships=[];
 const accountant=await request('',undefined,'accountant','p','same-user');assert.deepEqual(accountant.data.pinned,['assets','income']);assert.ok(!accountant.data.tools.some(t=>t.key==='roles'));assert.ok(!accountant.data.quick_add.some(t=>t.key==='add_notice'));
 assert.equal((await put(['roles'],1,'accountant','p','same-user')).status,400);
});
test('member, cashier, approver and auditor retain only role-appropriate tools and creation actions',async()=>{
 const member=(await request('',undefined,'member')).data;assert.ok(member.tools.every(t=>['members','income','expenses','ledger'].includes(t.key)));assert.equal(member.quick_add.length,0);assert.equal((await put(['assets'],0,'member')).status,400);
 for(const role of ['cashier','approver','auditor']){const config=(await request('',undefined,role)).data;assert.equal(config.quick_add.length,0);assert.ok(!config.tools.some(t=>['roles','integrations','reports','notifications'].includes(t.key)));}
 const auditor=(await request('',undefined,'auditor')).data;assert.ok(auditor.tools.some(t=>t.key==='assets'));
});
test('project types get their own modules and creation flows without leaking other project tools',async()=>{
 for(const type of ['accounting','billing','construction']){const r=await request('',undefined,'admin',type);assert.equal(r.status,200);assert.ok(r.data.tools.some(t=>t.key==='assets'));assert.ok(!r.data.tools.some(t=>type==='billing'?t.key.startsWith('construction_'):type==='construction'?t.key.startsWith('billing_'):t.key.startsWith('billing_')||t.key.startsWith('construction_')));assert.ok(r.data.pinned.length<=MAX_PINS);assert.equal((await put(['members'],0,'admin','accounting')).status,400);}
 assert.deepEqual((await request('',undefined,'admin','billing')).data.quick_add.map(t=>t.key),['add_customer','add_invoice','add_collection','add_expense']);
});
test('legacy accountant and member defaults are preserved, sanitized and capped without resetting saved personal pins',async()=>{
 db.projects[0].portalSettings={accountant_shortcuts:['income','accounts','commerce','income','bad'],member_shortcuts:[]};
 assert.deepEqual((await request('',undefined,'accountant')).data.pinned,['income','accounts','commerce']);assert.deepEqual((await request('',undefined,'member')).data.pinned,[]);
 await put(['assets'],0,'accountant');db.projects[0].portalSettings.accountant_shortcuts=['members'];assert.deepEqual((await request('',undefined,'accountant')).data.pinned,['assets']);
});
test('catalogue definitions have stable unique keys and group colours; role filtering is deterministic',()=>{
 const catalog=availableCatalog('fund_shares',['admin']);assert.equal(new Set(catalog.tools.map(t=>t.key)).size,catalog.tools.length);assert.equal(new Set(catalog.groups.map(g=>g.color)).size,4);assert.ok(catalog.tools.every(t=>t.icon&&t.description&&catalog.groups.some(g=>g.key===t.group)));assert.deepEqual(defaultPins('fund_shares',['admin']),defaultPins('fund_shares',['owner']));
});

test('accountants can discover and save the schedules shortcut',async()=>{
 const config=await request('',undefined,'accountant');
 assert.equal(config.status,200);
 assert.ok(config.data.tools.some(t=>t.key==='schedules'));
 assert.equal((await put(['schedules','members'],0,'accountant')).status,200);
 assert.deepEqual((await request('',undefined,'accountant')).data.pinned,['schedules','members']);
 for(const role of ['member','cashier','auditor'])assert.equal((await put(['schedules'],0,role)).status,400);
});
