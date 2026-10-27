import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {records,record,saveRecord} from '../dist/modules/payroll/portal.store.js';
const runtime=process.env.PGLITE_MODULE_PATH;
test('portal migration preserves payroll rows and persists scoped, revision-checked records',{skip:!runtime},async()=>{
 const {PGlite}=await import(pathToFileURL(runtime).href),db=new PGlite();
 try{
  await db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT);CREATE TABLE payroll_employees(id TEXT PRIMARY KEY,name TEXT,basic INTEGER NOT NULL);INSERT INTO projects VALUES ('project','Existing payroll'),('other-project','Other payroll');INSERT INTO payroll_employees VALUES ('employee','Existing employee',32000);`);
  await db.exec(await readFile(new URL('../prisma/migrations/20261027180000_payroll_employee_portal/migration.sql',import.meta.url),'utf8'));
  assert.deepEqual((await db.query('SELECT * FROM payroll_employees')).rows,[{id:'employee',name:'Existing employee',basic:32000}]);
  assert.equal((await db.query('SELECT count(*)::int n FROM payroll_portal_records')).rows[0].n,0);
  const tx={$queryRaw:async(strings,...values)=>(await db.query(strings.reduce((sql,part,i)=>sql+(i?`$${i}`:'')+part,''),values)).rows},auth={tenantId:'tenant',projectId:'project'};
  const row=await saveRecord(tx,auth,'profile','employee',{employeeId:'employee',label:'Saved profile'},'employee');assert.equal(row.revision,0);
  assert.equal((await records(tx,auth,'profile')).length,1);assert.deepEqual(await records(tx,{tenantId:'another',projectId:'project'}),[]);assert.deepEqual(await records(tx,{tenantId:'tenant',projectId:'other-project'}),[]);
  await assert.rejects(record(tx,{tenantId:'another',projectId:'project'},'profile','employee'),error=>error.statusCode===404);
  const updated=await saveRecord(tx,auth,'profile','employee',{employeeId:'employee',label:'Updated profile'},'employee',0);assert.equal(updated.revision,1);
  await assert.rejects(saveRecord(tx,auth,'profile','employee',{label:'Stale'},'employee',0),error=>error.statusCode===409);
  assert.equal((await record(tx,auth,'profile','employee')).data.label,'Updated profile');
  await assert.rejects(saveRecord(tx,auth,'profile','employee',{label:'Duplicate'},'employee'),error=>error.statusCode===409);
  await assert.rejects(saveRecord(tx,auth,'invalid-kind','bad',{}),/check constraint/);
  await assert.rejects(db.exec(`UPDATE payroll_portal_records SET revision=-1`),/check constraint/);
  await assert.rejects(saveRecord(tx,auth,'profile','unknown',{},'missing-employee'),/foreign key/);
  await assert.rejects(db.transaction(async transaction=>{await transaction.exec(`INSERT INTO payroll_portal_records(id,tenant_id,project_id,kind,record_key,data) VALUES ('rollback','tenant','project','department','rollback','{}');`);throw Error('simulate failed mutation');}),/simulate failed mutation/);
  assert.equal((await db.query("SELECT count(*)::int n FROM payroll_portal_records WHERE record_key='rollback'")).rows[0].n,0);
  assert.deepEqual((await db.query('SELECT * FROM payroll_employees')).rows,[{id:'employee',name:'Existing employee',basic:32000}]);
 }finally{await db.close();}
});
