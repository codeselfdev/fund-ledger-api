import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const runtime=process.env.PGLITE_MODULE_PATH;
test('site-control migration is additive, defaults legacy projects to expense and enforces ledger invariants',{skip:!runtime},async()=>{
 const {PGlite}=await import(pathToFileURL(runtime).href),db=new PGlite();try{
  await db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY);CREATE TABLE construction_material_entries(id TEXT PRIMARY KEY,quantity INTEGER NOT NULL);INSERT INTO projects VALUES ('p');INSERT INTO construction_material_entries VALUES ('old',5);`);
  await db.exec(await readFile(new URL('../prisma/migrations/20261026200000_construction_site_control/migration.sql',import.meta.url),'utf8'));
  assert.deepEqual((await db.query('SELECT * FROM projects')).rows,[{id:'p',construction_valuation_method:'expense'}]);
  assert.deepEqual((await db.query('SELECT * FROM construction_material_entries')).rows,[{id:'old',quantity:5,cost_head_id:null,stock_location_id:null,valuation_value_micro:null}]);
  assert.equal((await db.query('SELECT count(*)::int n FROM construction_control_versions')).rows[0].n,0);
  await assert.rejects(db.exec(`UPDATE projects SET construction_valuation_method='latest_price'`),/check constraint/);
  const insert=async(id,qty,value)=>db.query(`INSERT INTO construction_valuation_layers(id,tenant_id,project_id,item_id,location_id,remaining_quantity,value_micro) VALUES ($1,'t','p','i','main',$2,$3)`,[id,qty,value]);
  await insert('valid',3,'1000000');await assert.rejects(insert('negative',-1,'10'),/check constraint/);await assert.rejects(insert('undrained',0,'1'),/check constraint/);
  await db.exec(`UPDATE construction_valuation_layers SET remaining_quantity=0,value_micro=0 WHERE id='valid'`);
  await assert.rejects(db.exec(`DELETE FROM projects WHERE id='p'`),/foreign key/);
  const version=async(id,key,reviewer=null)=>db.query(`INSERT INTO construction_control_versions(id,tenant_id,project_id,kind,revision,payload,note,created_by_id,decided_by_id,request_key,request_hash) VALUES ($1,'t','p','boq',1,'{}','baseline','engineer',$3,$2,'hash')`,[id,key,reviewer]);
  await assert.rejects(version('self','key','engineer'),/check constraint/);await version('first','key');await assert.rejects(version('dupe','other'),/unique/);
  await db.exec(`INSERT INTO construction_measurements(id,tenant_id,project_id,kind,boq_id,base_id,quantity,measurement_date,evidence,note,created_by_id,request_key,request_hash) VALUES ('m','t','p','measurement','b','first',1.125,'2026-01-06','[]','measured','engineer','m','hash')`);
  assert.equal(Number((await db.query('SELECT quantity FROM construction_measurements')).rows[0].quantity),1.125);
  await assert.rejects(db.exec(`UPDATE construction_measurements SET decided_by_id='engineer',status='approved' WHERE id='m'`),/check constraint/);
 }finally{await db.close();}
});
