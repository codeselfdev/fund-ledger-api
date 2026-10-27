import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
// Optional test-only WASM PostgreSQL; never uses DATABASE_URL or a live server.
const runtime=process.env.PGLITE_MODULE_PATH;
test('construction migrations preserve legacy budgets and enforce work structure references in PostgreSQL',{skip:!runtime},async()=>{
 const {PGlite}=await import(pathToFileURL(runtime).href);const db=new PGlite();
 try {
  await db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY);
   CREATE TABLE construction_cost_heads(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL,name TEXT NOT NULL,phase TEXT NOT NULL,budget INTEGER NOT NULL,revised_budget INTEGER NOT NULL,status TEXT NOT NULL,created_by_id TEXT NOT NULL,created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
   CREATE UNIQUE INDEX construction_cost_heads_project_id_name_phase_key ON construction_cost_heads(project_id,name,phase);
   INSERT INTO projects VALUES ('project'),('other'); INSERT INTO users VALUES ('owner');
   INSERT INTO construction_cost_heads(id,tenant_id,project_id,name,phase,budget,revised_budget,status,created_by_id) VALUES ('old','tenant','project','Materials','Foundation',100000,120000,'approved','owner'),('other','other-tenant','other','Materials','Foundation',50000,50000,'pending','owner');`);
  const before=(await db.query('SELECT id,budget,revised_budget,status FROM construction_cost_heads ORDER BY id')).rows;
  for(const name of ['20261026150000_construction_phases','20261026170000_construction_work_structure'])await db.exec(await readFile(new URL(`../prisma/migrations/${name}/migration.sql`,import.meta.url),'utf8'));
  assert.deepEqual((await db.query('SELECT id,budget,revised_budget,status FROM construction_cost_heads ORDER BY id')).rows,before);
  const old=(await db.query(`SELECT * FROM construction_cost_heads WHERE id='old'`)).rows[0];assert.ok(old.phase_id);assert.equal(old.work_package_id,null);assert.equal(old.work_scope_key,'');
  const phases=(await db.query('SELECT * FROM construction_phases')).rows;assert.equal(phases.length,2);assert.ok(phases.every(p=>p.status==='draft'&&p.planned_start===null));
  const insertLocation=async(id,name,parent=null)=>db.query(`INSERT INTO construction_work_locations(id,tenant_id,project_id,parent_id,parent_key,kind,name,request_key,request_hash,created_by_id,updated_at) VALUES ($1,'tenant','project',$2,$3,$4,$5,$1,'hash','owner',CURRENT_TIMESTAMP)`,[id,parent,parent??'',parent?'floor':'building',name]);
  await insertLocation('building','Building A');await insertLocation('floor','Floor one','building');
  await assert.rejects(insertLocation('duplicate','Floor one','building'),/unique/i);
  await insertLocation('other-building','Building B');await insertLocation('other-floor','Floor one','other-building');
  await assert.rejects(insertLocation('orphan','Orphan','missing'),/foreign key/i);
  await db.query(`INSERT INTO construction_work_packages(id,tenant_id,project_id,phase_id,location_id,name,request_key,request_hash,created_by_id,updated_at) VALUES ('package','tenant','project',$1,'floor','Floor masonry','package','hash','owner',CURRENT_TIMESTAMP)`,[old.phase_id]);
  await db.exec(`INSERT INTO construction_tasks(id,tenant_id,project_id,work_package_id,name,request_key,request_hash,created_by_id,updated_at) VALUES ('task','tenant','project','package','Lay bricks','task','hash','owner',CURRENT_TIMESTAMP);`);
  const insertBudget=async(id,key)=>db.query(`INSERT INTO construction_cost_heads(id,tenant_id,project_id,name,phase,budget,revised_budget,status,created_by_id,phase_id,work_package_id,task_id,location_id,work_scope_key) VALUES ($1,'tenant','project','Materials','Foundation',100,100,'pending','owner',$2,'package','task','floor',$3)`,[id,old.phase_id,key]);
  await insertBudget('new','task-scope');await assert.rejects(insertBudget('duplicate-budget','task-scope'),/unique/i);
  await assert.rejects(db.exec(`DELETE FROM construction_tasks WHERE id='task'`),/foreign key/i);
  await assert.rejects(db.exec(`UPDATE construction_work_locations SET parent_key='wrong' WHERE id='floor'`),/check constraint/i);
  await db.exec(`UPDATE construction_tasks SET is_active=false,revision=revision+1 WHERE id='task'`);
  assert.equal((await db.query(`SELECT task_id FROM construction_cost_heads WHERE id='new'`)).rows[0].task_id,'task');
 } finally {await db.close();}
});
