const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function load(file, dependencies = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'), { compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022} }).outputText;
  new Function('require','module','exports',code)(name=>name in dependencies?dependencies[name]:require(name),module,module.exports);
  return module.exports;
}
const errors = load('src/core/http/api-error.ts');
const policy = load('src/modules/institute/institute.policy.ts', {'../../core/http/api-error.js':errors});
const dependencies = {'@prisma/client':{},'../../core/prisma/client.js':{prisma:{}},'../../core/security/auth.context.js':{requireProjectContext:r=>r.auth},'../../core/http/api-error.js':errors,'../accounting/transaction.js':{},'./institute.notifications.js':{queueInstituteNotifications:async()=>0},'./institute.policy.js':policy};
const service = load('src/modules/institute/institute.service.ts',dependencies);
const access = portal=>({portal,family:['guardian','student'].includes(portal),scope:{tenantId:'t',projectId:'p'},auth:{userId:'u',builtinRoles:[portal==='office'?'admin':portal==='guardian'?'member':portal]},studentIds:['linked'],groupIds:['assigned']});
test('guardian, student and teacher scope is put into the database predicate',()=>{
 assert.deepEqual(service.studentWhere(access('guardian')),{tenantId:'t',projectId:'p',id:{in:['linked']},status:'active'});
 assert.deepEqual(service.studentWhere(access('teacher')),{tenantId:'t',projectId:'p',groupId:{in:['assigned']}});
 assert.deepEqual(policy.portals(['teacher','member'],true,true,true),['teacher','guardian','student']);
 assert.deepEqual(policy.portals([],false,false,false),[]);
});
test('teachers receive no fee API, accountants no marks and auditors never write',()=>{
 assert.throws(()=>service.permit(access('teacher'),'fees'),e=>e.statusCode===404);
 assert.throws(()=>service.permit(access('accounts'),'results'),e=>e.statusCode===404);
 assert.throws(()=>service.permit(access('auditor'),'attendance',true),e=>e.statusCode===403);
 const a=access('teacher');a.auth.menuPermissions={institute_fees:{read:true,write:true}};
 assert.throws(()=>service.permit(a,'fees'),e=>e.statusCode===404);
});
test('out of scope student IDs return 404 and remain constrained by linked IDs',async()=>{
 let where; const tx={instituteStudent:{findFirst:async q=>{where=q.where;return null;}}};
 await assert.rejects(()=>service.student(tx,access('guardian'),'another-student'),e=>e.statusCode===404);
 assert.deepEqual(where.AND,{id:{in:['linked']}});assert.equal(where.id,'another-student');
});
test('attendance is complete or rejected, and approved leave is locked',()=>{
 const roster=['a','b'];assert.throws(()=>policy.validateAttendance(roster,new Set(),[{student_id:'a',status:'present'}]),e=>e.code==='ATTENDANCE_INCOMPLETE');
 assert.throws(()=>policy.validateAttendance(roster,new Set(['b']),[{student_id:'a',status:'present'},{student_id:'b',status:'absent'}]),e=>e.code==='ATTENDANCE_LEAVE_LOCKED');
 assert.throws(()=>policy.validateAttendance(roster,new Set(),[{student_id:'a',status:'present'},{student_id:'b',status:'leave'}]),e=>e.code==='ATTENDANCE_LEAVE_LOCKED');
 policy.validateAttendance(roster,new Set(['b']),[{student_id:'a',status:'present'},{student_id:'b',status:'leave'}]);
});
test('GPA any-F rule, absent and dense tied positions',()=>{
 assert.equal(policy.resultGrade([90,32],'bd_gpa5',[false,false]).gpa,0);
 assert.equal(policy.resultGrade([90,80],'bd_gpa5',[true,false]).grade,'F');
 assert.equal(policy.resultGrade([90,80],'bd_gpa5',[false,false]).gpa,5);
 assert.equal(policy.resultGrade([39,99],'bands',[false,false]).grade,'Refer');
 assert.deepEqual(policy.densePositions([{student_id:'a',gpa:5,total:190,passed:true},{student_id:'b',gpa:5,total:190,passed:true},{student_id:'c',gpa:5,total:180,passed:true},{student_id:'f',gpa:0,total:160,passed:false}]),{a:1,b:1,c:2});
});
test('quiet hours defer delivery until 07:00 project time',()=>{
 const at=new Date('2026-10-26T15:00:00Z');assert.equal(policy.pushNotBefore('Asia/Dhaka',at).toISOString(),'2026-10-27T01:00:00.000Z');
 const daytime=new Date('2026-10-26T04:00:00Z');assert.equal(policy.pushNotBefore('Asia/Dhaka',daytime),daytime);
});
test('idempotency replay returns the first result and changed payloads conflict',async()=>{
 let receipt=null,count=0;
 const tx={instituteWriteReceipt:{findUnique:async()=>receipt,create:async q=>{receipt=q.data;}},activity:{create:async()=>{}}};
 const tested=load('src/modules/institute/institute.service.ts',{...dependencies,'../accounting/transaction.js':{financialTransaction:fn=>fn(tx)}});
 const req={method:'POST',path:'/groups',body:{name:'Class 8'},header:()=> '6f1cf561-c6cb-4dc1-a968-310e217602df'},a=access('office');
 const operation=async()=>({id:`group-${++count}`});
 assert.deepEqual(await tested.mutate(req,a,operation),{id:'group-1'});assert.deepEqual(await tested.mutate(req,a,operation),{id:'group-1'});assert.equal(count,1);
 req.body={name:'Class 9'};await assert.rejects(()=>tested.mutate(req,a,operation),e=>e.code==='IDEMPOTENCY_CONFLICT');
});
test('stale revisions expose the current aggregate without mutating it',()=>{
 const row={revision:2,marks:[{student_id:'a',status:'present'}]};assert.throws(()=>service.assertRevision(row,1),e=>e.code==='REVISION_CONFLICT'&&e.current.revision===2);assert.equal(row.revision,2);
});
test('migration creates only institute-prefixed tables and has foreign keys and money checks',()=>{
 const sql=fs.readFileSync(path.join(root,'prisma/migrations/20261026120000_institute_core/migration.sql'),'utf8');
 const names=Array.from(sql.matchAll(/CREATE TABLE "([^"]+)"/g),m=>m[1]);assert.equal(names.length,22);assert.ok(names.every(n=>n.startsWith('institute_')));assert.ok(!/DROP |TRUNCATE |DELETE FROM|UPDATE "/.test(sql));assert.match(sql,/FOREIGN KEY/);assert.match(sql,/institute_payment_amount/);
});

test('fee collection month boundaries follow project time across UTC and DST changes',()=>{
 const dhaka=policy.monthBounds('2026-10','Asia/Dhaka');assert.equal(dhaka.start.toISOString(),'2026-09-30T18:00:00.000Z');assert.equal(dhaka.end.toISOString(),'2026-10-31T18:00:00.000Z');
 const ny=policy.monthBounds('2026-11','America/New_York');assert.equal(ny.start.toISOString(),'2026-11-01T04:00:00.000Z');assert.equal(ny.end.toISOString(),'2026-12-01T05:00:00.000Z');
});
test('subject data for assigned teachers retains result-menu access without granting directory writes',()=>{
 const a=access('teacher');a.auth.menuPermissions={institute_results:{read:true,write:false}};
 assert.doesNotThrow(()=>service.permit(a,'subjects'));
 assert.throws(()=>service.permit(a,'subjects',true),e=>e.statusCode===403);
 a.auth.menuPermissions={institute_subjects:{read:true,write:true}};
 assert.throws(()=>service.permit(a,'subjects'),e=>e.statusCode===403);
});
