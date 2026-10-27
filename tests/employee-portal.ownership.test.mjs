import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL='postgresql://unused:unused@localhost:55439/payroll_test';process.env.JWT_SECRET='disposable-payroll-tests';
const {prisma}=await import('../dist/core/prisma/client.js');
const service=await import('../dist/modules/payroll/portal.service.js');
const {today}=await import('../dist/modules/payroll/payroll.policy.js');
const member={tenantId:'tenant',projectId:'project',userId:'user-me',roles:['member'],builtinRoles:['member']};
const owner={...member,userId:'owner',roles:['owner'],builtinRoles:['owner']};
const me={id:'me',userId:'user-me',name:'Self',revision:0,mobile:'01711482930',joiningDate:new Date('2021-01-01'),basic:30000,medical:0,transport:0,pfMember:true,status:'active',designation:'Officer',department:'Operations'};
const other={...me,id:'other',userId:'user-other',name:'Other'};
const item=(kind,key,data,employeeId=null,projectId='project')=>({id:key,record_key:key,kind,data,employee_id:employeeId,tenant_id:'tenant',project_id:projectId,revision:0});
function harness(){
 const rows=[item('task','mine',{employeeId:'me',projectId:'office',title:'My task',status:'todo'},'me'),item('task','another',{employeeId:'other',projectId:'office',title:'Other task',status:'todo'},'other'),item('task','foreign',{employeeId:'me',projectId:'office',title:'Foreign task',status:'todo'},'me','foreign-project'),item('document','my-doc',{employeeId:'me',title:'My ID',status:'uploaded',fileId:'mine'},'me'),item('document','other-doc',{employeeId:'other',title:'Other ID',status:'uploaded',fileId:'other'},'other'),item('office_project','office',{id:'office',status:'active',startDate:'2021-01-01',endDate:'2199-01-01',team:[{employeeId:'me',percent:50},{employeeId:'other',percent:50}]}),item('location','other-location',{employeeId:'other',consent:false,status:'paused',latitude:23.8,longitude:90.4,capturedAt:new Date().toISOString(),events:[]},'other')];
 const tx={project:{findFirst:async()=>({id:'project',projectType:'payroll_pf'})},payrollEmployee:{findFirst:async({where})=>[me,other].find(e=>where.userId?e.userId===where.userId:e.id===where.id)??null,findMany:async({where})=>[me,other].filter(e=>!where.id||where.id===e.id)},payrollAttendanceConfiguration:{findFirst:async()=>null},payrollAttendance:{findMany:async()=>[],findFirst:async()=>null},payrollOperation:{findFirst:async()=>null,create:async()=>({})},activity:{create:async()=>({})},user:{findFirstOrThrow:async()=>({name:'Self'})},
 $queryRaw:async(strings,...v)=>{const sql=strings.join('?');if(sql.startsWith('SELECT')){const[tenant,project,kind,key]=v;return rows.filter(r=>r.tenant_id===tenant&&r.project_id===project&&(!kind||r.kind===kind)&&(!key||r.record_key===key)).map(r=>structuredClone(r));}if(sql.startsWith('UPDATE')){const[payload,tenant,project,kind,key,revision]=v,r=rows.find(r=>r.tenant_id===tenant&&r.project_id===project&&r.kind===kind&&r.record_key===key&&r.revision===revision);if(!r)return[];r.data=JSON.parse(payload);r.revision++;return[structuredClone(r)];}throw Error('Unexpected SQL');},$executeRaw:async()=>0};
 prisma.$transaction=async(fn)=>fn(tx);return{rows,tx};
}
test('member workspace excludes other people, files, tasks, team allocations and locations',async()=>{
 harness();const data=await service.portalWorkspace(member);assert.deepEqual(data.profiles.map(p=>p.employeeId),['me']);assert.deepEqual(data.tasks.map(t=>t.id),['mine']);assert.deepEqual(data.documents.map(d=>d.id),['my-doc']);assert.deepEqual(data.projects[0].team,[{employeeId:'me',percent:50}]);assert.deepEqual(data.locations,[]);assert.equal(data.canManage,false);assert.equal(data.canViewLocations,false);
});
test('task mutations enforce employee and tenant/project ownership before any write',async()=>{
 const h=harness(),body={status:'done',revision:0,request_key:'one'};
 await assert.rejects(service.updateTask(member,'another',body),e=>e.statusCode===403);assert.equal(h.rows.find(r=>r.record_key==='another').data.status,'todo');
 await assert.rejects(service.updateTask(member,'foreign',body),e=>e.statusCode===404);
 const saved=await service.updateTask(member,'mine',body);assert.equal(saved.status,'done');assert.equal(saved.revision,1);assert.equal(h.rows.find(r=>r.record_key==='mine').data.status,'done');
});
test('employees cannot verify their own documents, acknowledge another employee’s document or create HR records',async()=>{
 harness();await assert.rejects(service.actDocument(member,'my-doc',{action:'verify',revision:0,request_key:'one'}),e=>e.statusCode===403);
 await assert.rejects(service.actDocument(member,'other-doc',{action:'acknowledge',revision:0,request_key:'two'}),e=>e.statusCode===403);
 await assert.rejects(service.createDepartment(member,{name:'Unauthorized',code:'BAD',headId:null,parentId:null,request_key:'three'}),e=>e.statusCode===403);
});
test('explicit task grants do not reveal HR profiles or live locations',async()=>{
 harness();const custom={...member,userId:'unlinked',roles:['auditor'],builtinRoles:[],menuPermissions:{payroll_tasks:{read:true,write:true}}};const data=await service.portalWorkspace(custom);assert.equal(data.tasks.length,2);assert.deepEqual(data.profiles,[]);assert.deepEqual(data.locations,[]);assert.deepEqual(data.documents,[]);assert.equal(data.canViewLocations,false);
});
