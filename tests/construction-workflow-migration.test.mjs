import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const runtime=process.env.PGLITE_MODULE_PATH;
test('procurement migration preserves old purchases and validates routed reviews and corrected document versions',{skip:!runtime},async()=>{
 const {PGlite}=await import(pathToFileURL(runtime).href),db=new PGlite();try{
  await db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY);CREATE TABLE purchases(id TEXT PRIMARY KEY,vendor_id TEXT);CREATE TABLE construction_supplier_bills(id TEXT PRIMARY KEY);CREATE TABLE construction_change_orders(id TEXT PRIMARY KEY);CREATE TABLE construction_control_versions(id TEXT PRIMARY KEY);INSERT INTO projects VALUES ('p');INSERT INTO purchases VALUES ('old',NULL);INSERT INTO construction_supplier_bills VALUES ('old-bill');`);
  await db.exec(await readFile(new URL('../prisma/migrations/20261027100000_construction_procurement_receipts_scope/migration.sql',import.meta.url),'utf8'));
  const old=(await db.query('SELECT * FROM purchases')).rows[0];assert.equal(old.construction_managed,false);assert.equal(old.construction_cost_head_id,null);assert.equal((await db.query('SELECT procurement_invoice_id FROM construction_supplier_bills')).rows[0].procurement_invoice_id,null);
  await assert.rejects(db.exec(`UPDATE purchases SET construction_managed=true WHERE id='old'`),/check constraint/);
  const req=(actor,approver)=>db.query(`INSERT INTO construction_requisitions(id,tenant_id,project_id,cost_head_id,title,required_by,urgency,lines,note,evidence,approver_id,created_by_id,request_key,request_hash) VALUES ('r','t','p','h','Materials','2026-11-01','urgent','[]','Needed on site','[]',$1,$2,'key','hash')`,[approver,actor]);
  await assert.rejects(req('writer','writer'),/check constraint/);await req('writer','engineer');await assert.rejects(db.exec(`UPDATE construction_requisitions SET status='approved',decided_by_id='someone-else' WHERE id='r'`),/check constraint/);await db.exec(`UPDATE construction_requisitions SET status='approved',decided_by_id='engineer' WHERE id='r'`);
  const invoice=(id,rev)=>db.query(`INSERT INTO construction_purchase_invoices(id,tenant_id,project_id,purchase_id,number,revision,invoice_date,lines,charges,amount,evidence,note,approver_id,created_by_id,request_key,request_hash) VALUES ($1,'t','p','old','INV-1',$2,'2026-01-06','[]',0,100,'[]','Materials invoice','engineer','writer',$1,'hash')`,[id,rev]);
  await invoice('v1',1);await invoice('v2',2);await assert.rejects(invoice('duplicate',2),/unique/);await assert.rejects(db.exec(`DELETE FROM projects WHERE id='p'`),/foreign key/);
 }finally{await db.close();}
});
