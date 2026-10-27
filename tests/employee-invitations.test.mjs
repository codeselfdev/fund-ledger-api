import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL='postgresql://unused:unused@localhost:55439/payroll_test';process.env.JWT_SECRET='disposable-employee-tests';
const {prisma}=await import('../dist/core/prisma/client.js');
const {env}=await import('../dist/config/env.js');env.smtp.user='test';env.smtp.pass='test';
const {inviteEmployee,employeeInvitationSchema}=await import('../dist/modules/payroll/employee-invitation.service.js');
const {access}=await import('../dist/modules/payroll/payroll.service.js');
const {summarizeProjectMemberships}=await import('../dist/core/security/project-access.js');
const owner={tenantId:'tenant',projectId:'project',userId:'admin',roles:['admin'],builtinRoles:['admin']};
const draft={name:'Sadia',mobile:'01711482930',email:'sadia@example.test',nationalId:'',birthDate:null,bloodGroup:'',address:'',emergencyContact:'',bankAccount:'',reportsToId:null,departmentId:null,designationId:null,workLocation:'office',locationRequired:false,revision:0,employeeRevision:0,request_key:'01234567-89ab-4cde-8123-456789abcdef'};
function harness(options={}){
 const data={users:structuredClone(options.users??[]),memberships:[],activities:[],profile:null,person:{id:'person',tenantId:'tenant',projectId:'project',userId:options.userId??null,name:'Sadia',mobile:draft.mobile,revision:0,status:options.inactive?'inactive':'active',basic:20000,medical:0,transport:0,pfMember:false,joiningDate:new Date('2021-01-01')},writes:0,emails:0};
 const tx={project:{findFirst:async({where})=>where.id==='project'&&where.tenantId==='tenant'?{id:'project',projectType:'payroll_pf'}:null,findFirstOrThrow:async()=>({name:'Office'})},
 payrollEmployee:{findFirst:async({where})=>where.id?.not?null:where.id===data.person.id&&where.tenantId===data.person.tenantId&&where.projectId===data.person.projectId?structuredClone(data.person):null,update:async({data:changes})=>{data.writes++;Object.assign(data.person,{...changes,revision:changes.revision?data.person.revision+changes.revision.increment:data.person.revision});return data.person;}},
 user:{findMany:async()=>data.users,findFirstOrThrow:async()=>({name:'Admin'}),create:async({data:user})=>{data.writes++;const row={...user,id:'login',isActive:true};data.users.push(row);return row;},update:async({where,data:changes})=>{data.writes++;const user=data.users.find(u=>u.id===where.id);Object.assign(user,changes);return user;}},
 projectMembership:{upsert:async({create})=>{data.writes++;data.memberships.push(create);return create;}},
 activity:{findUnique:async({where})=>data.activities.find(x=>x.id===where.id)??null,findFirst:async()=>data.activities.find(x=>x.action==='payroll.employee.email_invitation')??null,create:async({data:row})=>{data.activities.push(row);return row;},update:async({where,data:changes})=>{Object.assign(data.activities.find(x=>x.id===where.id),changes);}},
 $queryRaw:async(strings,...values)=>{const sql=strings.join('?');if(sql.includes('FOR UPDATE'))return[{id:'person'}];if(sql.startsWith('SELECT'))return data.profile?[structuredClone(data.profile)]:[];if(sql.startsWith('INSERT')){data.profile={id:'profile',record_key:'person',revision:0,data:JSON.parse(values[6])};return[data.profile];}throw Error(sql);}};
 prisma.$transaction=async fn=>{const previous=structuredClone(data);try{return await fn(tx);}catch(e){Object.assign(data,previous);throw e;}};prisma.activity.update=tx.activity.update;
 const send=async input=>{data.emails++;data.sent=input;if(options.throwMail)throw Error('SMTP offline');return options.mailSuccess!==false;};
 return{data,tx,send,invite:(body=draft,a=owner,id='person')=>inviteEmployee(a,id,body,undefined,send)};
}
test('invitation atomically saves the email, creates the login, links the employee and grants only the employee project role',async()=>{
 const h=harness(),result=await h.invite();assert.equal(result.status,'sent');assert.equal(result.role,'employee');assert.equal(h.data.users.length,1);assert.equal(h.data.person.userId,'login');assert.equal(h.data.profile.data.email,draft.email);assert.deepEqual(h.data.memberships,[{tenantId:'tenant',projectId:'project',userId:'login',role:'employee'}]);assert.equal(h.data.emails,1);assert.equal(h.data.sent.email,draft.email);assert.match(h.data.sent.invitationLink,/role=employee/);
});
test('existing matching login is reused without changing identity or duplicating the user',async()=>{
 const h=harness({userId:'existing',users:[{id:'existing',mobile:draft.mobile,email:draft.email,isActive:true}]});await h.invite();assert.equal(h.data.users.length,1);assert.equal(h.data.person.userId,'existing');assert.equal(h.data.memberships[0].userId,'existing');
});
test('ambiguous network retries replay the committed invitation without re-saving or sending twice',async()=>{
 const h=harness();await h.invite();const before=h.data.writes;const replay=await h.invite();assert.equal(replay.replayed,true);assert.equal(h.data.writes,before);assert.equal(h.data.emails,1);await assert.rejects(h.invite({...draft,email:'changed@example.test'}),e=>e.statusCode===409);await assert.rejects(h.invite(draft,{...owner,userId:'other-admin'}),e=>e.statusCode===409);
});
test('non-admin and synthetic custom-role administrators cannot create login access',async()=>{
 for(const role of ['employee','member','accountant']){const h=harness();await assert.rejects(h.invite(draft,{...owner,roles:[role],builtinRoles:[role]}),e=>e.statusCode===403);assert.equal(h.data.writes,0);}
 const h=harness();await assert.rejects(h.invite(draft,{...owner,roles:['admin'],builtinRoles:[]}),e=>e.statusCode===403);assert.equal(h.data.writes,0);
});
test('foreign employee IDs, inactive employees and stale revisions never create access or mail',async()=>{
 for(const options of [{},{inactive:true}]){const h=harness(options);await assert.rejects(h.invite(draft,owner,options.inactive?'person':'foreign'),e=>[400,404,409].includes(e.statusCode));assert.equal(h.data.writes,0);assert.equal(h.data.emails,0);}
 const h=harness();await assert.rejects(h.invite({...draft,employeeRevision:9}),e=>e.statusCode===409);assert.equal(h.data.writes,0);assert.equal(h.data.emails,0);
});
test('conflicting emails, duplicate identities and inactive login accounts are rejected before any writes',async()=>{
 for(const users of [[{id:'existing',mobile:draft.mobile,email:'different@example.test',isActive:true}],[{id:'one'},{id:'two'}],[{id:'existing',mobile:draft.mobile,email:draft.email,isActive:false}]]){const h=harness({users});await assert.rejects(h.invite(),e=>e.statusCode===409);assert.equal(h.data.writes,0);assert.equal(h.data.emails,0);}
});
test('SMTP failure reports failed delivery while preserving usable employee access and safe replay',async()=>{
 const h=harness({throwMail:true});const result=await h.invite();assert.equal(result.status,'failed');assert.equal(h.data.person.userId,'login');assert.equal(h.data.memberships[0].role,'employee');assert.equal((await h.invite()).status,'failed');assert.equal(h.data.emails,1);
});
test('strict invitation input requires valid email and ignores no forged role or project fields',()=>{
 assert.equal(employeeInvitationSchema.safeParse({...draft,email:''}).success,false);assert.equal(employeeInvitationSchema.safeParse({...draft,role:'owner'}).success,false);assert.equal(employeeInvitationSchema.safeParse({...draft,projectId:'foreign'}).success,false);assert.equal(employeeInvitationSchema.parse({...draft,email:' SADIA@Example.Test '}).email,'sadia@example.test');
});
test('employee membership remains visible in project discovery and has personal payroll/attendance access only',()=>{
 assert.equal(access({roles:['employee']}).member,true);assert.equal(access({roles:['employee']}).staff,false);
 const projects=summarizeProjectMemberships([{tenantId:'tenant',projectId:'project',role:'employee',memberId:null,project:{name:'Office',projectType:'payroll_pf',isActive:true}}]);assert.equal(projects.length,1);assert.equal(projects[0].role,'employee');assert.equal(projects[0].member_id,null);
});

test('employee role migration preserves existing roles and membership records',{skip:!process.env.PGLITE_MODULE_PATH},async()=>{
 const {pathToFileURL}=await import('node:url');const {PGlite}=await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
 const {readFile}=await import('node:fs/promises');const db=new PGlite();
 try{await db.exec(`CREATE TYPE "Role" AS ENUM ('owner','admin','member');CREATE TABLE memberships (id TEXT PRIMARY KEY,role "Role");INSERT INTO memberships VALUES ('existing','member');`);await db.exec(await readFile(new URL('../prisma/migrations/20261028000000_employee_role/migration.sql',import.meta.url),'utf8'));await db.exec(`INSERT INTO memberships VALUES ('invited','employee');`);assert.deepEqual((await db.query('SELECT * FROM memberships ORDER BY id')).rows,[{id:'existing',role:'member'},{id:'invited',role:'employee'}]);}finally{await db.close();}
});
