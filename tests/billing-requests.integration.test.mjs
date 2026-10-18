import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
const database=process.env.QUOTA_TEST_DATABASE_URL;
test('billing queue counts pending invoices independently of alerts, filters and pagination',{skip:!database},async t=>{
 const url=new URL(database);assert.equal(url.hostname,'127.0.0.1');assert.ok(url.pathname.endsWith('_test'));
 Object.assign(process.env,{DATABASE_URL:database,NODE_ENV:'production',JWT_SECRET:'billing-queue-test-secret',INTERNAL_API_KEY:'billing-queue-internal-key-at-least-32-characters'});
 const {prisma}=await import('../dist/core/prisma/client.js'),{createApp}=await import('../dist/app.js');
 const ids=[];let server;
 const invoice=(id,status)=>({id,amount:2500,currency:'BDT',package:'starter',billing_cycle:'monthly',status,issued_at:'2026-10-18T00:00:00Z',submitted_at:status==='submitted'?'2026-10-19T00:00:00Z':null,payment_reference:status==='submitted'?`BANK-${id}`:null,instructions:'Test only.'});
 try{
  const invoices=Array.from({length:35},(_,n)=>invoice(`queue-${n}`,n%2?'submitted':'open'));
  invoices.push(invoice('closed-approved','approved'),invoice('closed-rejected','rejected'));
  const a=await prisma.tenant.create({data:{name:'Billing queue 100% test',slug:'billing-queue-'+randomUUID(),contact:{billing:{invoices}}}});ids.push(a.id);
  const b=await prisma.tenant.create({data:{name:'Billing queue 100X test',slug:'billing-other-'+randomUUID(),contact:{billing:{invoices:[invoice('queue-0','submitted')]}}}});ids.push(b.id);
  await prisma.platformAlert.createMany({data:[{tenantId:a.id,kind:'billing_upgrade',eventKey:`billing_upgrade:${a.id}`},{tenantId:a.id,kind:'billing_payment',eventKey:`billing_payment:${a.id}:proof`,readAt:new Date()}]});
  server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/v1/internal/`;
  const get=async(path,authenticated=true)=>{const r=await fetch(base+path,{headers:authenticated?{'x-internal-api-key':process.env.INTERNAL_API_KEY}:{}});return{status:r.status,body:await r.json()};};
  await t.test('queue and counts require server admin authorization and validate status',async()=>{assert.equal((await get('billing-requests',false)).status,401);assert.equal((await get('billing-requests/counts',false)).status,401);assert.equal((await get('billing-requests?status=approved')).status,400);});
  await t.test('badges count each pending invoice once including beyond the first page',async()=>{const r=await get('billing-requests/counts');assert.equal(r.status,200);assert.deepEqual(r.body.data,{pending:36,awaiting_approval:18,awaiting_payment:18});await prisma.platformAlert.updateMany({where:{tenantId:a.id},data:{readAt:new Date()}});assert.equal((await get('billing-requests/counts')).body.data.pending,36);});
  await t.test('pages prioritize approvals and preserve exact tenant/invoice scope',async()=>{const first=(await get('billing-requests?search='+a.slug)).body.data;assert.equal(first.requests.length,30);assert.equal(first.next_offset,30);assert.equal(first.requests[0].invoice.status,'submitted');assert.ok(first.requests.every(r=>r.tenant.id===a.id));const next=(await get('billing-requests?search='+a.slug+'&offset=30')).body.data;assert.equal(next.requests.length,5);assert.equal(next.next_offset,null);assert.equal(new Set([...first.requests,...next.requests].map(r=>r.invoice.id)).size,35);});
  await t.test('status, transaction and literal wildcard searches return only the intended requests',async()=>{const submitted=(await get('billing-requests?status=submitted&search='+a.slug)).body.data;assert.equal(submitted.requests.length,17);assert.ok(submitted.requests.every(r=>r.invoice.status==='submitted'));const reference=(await get('billing-requests?search=BANK-queue-33')).body.data;assert.equal(reference.requests.length,1);assert.equal(reference.requests[0].invoice.id,'queue-33');const literal=(await get('billing-requests?search=100%25')).body.data;assert.equal(literal.requests.length,30);assert.ok(literal.requests.every(r=>r.tenant.id===a.id));});
  await t.test('resolved invoices leave the queue and badges drop without changing notification read state',async()=>{invoices[0].status='approved';invoices[1].status='rejected';await prisma.tenant.update({where:{id:a.id},data:{contact:{billing:{invoices}}}});assert.deepEqual((await get('billing-requests/counts')).body.data,{pending:34,awaiting_approval:17,awaiting_payment:17});const remaining=(await get('billing-requests?search='+a.slug)).body.data.requests;assert.ok(!remaining.some(r=>r.invoice.id==='queue-0'||r.invoice.id==='queue-1'));});
 }finally{if(server)await new Promise(r=>server.close(r));for(const id of ids.reverse())await prisma.tenant.delete({where:{id}});await prisma.$disconnect();}
});
