import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {mkdtemp,mkdir,copyFile,symlink,readdir,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {PrismaClient} from '@prisma/client';
const execute=promisify(execFile),target=process.env.NORMALIZATION_TEST_DATABASE_URL;
if(!target)throw Error('Set NORMALIZATION_TEST_DATABASE_URL to a local disposable *_test database.');
const parsed=new URL(target);if(!['127.0.0.1','localhost'].includes(parsed.hostname)||!parsed.pathname.endsWith('_test'))throw Error('Only local *_test databases are supported.');
const cli=resolve('node_modules/prisma/build/index.js'),migration=resolve('prisma/migrations'),root=new PrismaClient({datasources:{db:{url:target}}});
const normalizeSubscriptions='20261030010000_normalize_subscriptions',normalizeUsers='20261030020000_global_users_and_tenant_memberships';
async function isolated(fn){
 const name=`normalization_${Date.now()}_${Math.floor(Math.random()*1e6)}_test`,url=new URL(target);url.pathname='/'+name;
 await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);const directory=await mkdtemp(join(tmpdir(),'fundledger-migrations-')),db=new PrismaClient({datasources:{db:{url:url.href}}});
 try{
  await mkdir(join(directory,'migrations'));await copyFile(resolve('prisma/schema.prisma'),join(directory,'schema.prisma'));
  for(const entry of await readdir(migration)){if(entry.startsWith('202610300'))continue;if(entry==='migration_lock.toml'){await copyFile(join(migration,entry),join(directory,'migrations',entry));continue;}await mkdir(join(directory,'migrations',entry));await copyFile(join(migration,entry,'migration.sql'),join(directory,'migrations',entry,'migration.sql'));}
  await execute(process.execPath,[cli,'migrate','deploy','--schema',join(directory,'schema.prisma')],{env:{...process.env,DATABASE_URL:url.href}});
  const apply=folder=>execute(process.execPath,[cli,'db','execute','--file',join(migration,folder,'migration.sql'),'--url',url.href]);
  await fn(db,apply,url.href);
 }finally{await db.$disconnect();await rm(directory,{recursive:true,force:true});await root.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);}
}
async function seed(db){
 const subscription={status:'active',package:'business',billing_cycle:'yearly',trial_starts_at:'2026-10-01T08:46:08.963Z',trial_ends_at:'2027-04-01T08:46:08.963Z',current_period_start_at:'2026-10-18T19:47:35.558Z',current_period_end_at:'2027-10-18T19:47:35.558Z',updated_at:'2026-10-18T19:47:35.558Z'};
 const invoice={id:'old-invoice',package:'business',billing_cycle:'yearly',amount:80000,currency:'BDT',status:'approved',instructions:'Existing agreement',issued_at:'2026-10-18T18:00:00Z',approved_at:'2026-10-18T19:47:35.558Z',payment_reference:'existing-ref',period_ends_at:subscription.current_period_end_at};
 for(const id of ['one','two'])await db.$executeRawUnsafe(`INSERT INTO tenants(id,name,slug,plan,contact,updated_at) VALUES($1,$1,$1,'free',$2::jsonb,NOW())`,id,JSON.stringify({subscription,billing:{invoices:[{...invoice,id:id+'-invoice'}],payment_instructions:'keep'},custom:'keep'}));
 await db.$executeRawUnsafe(`INSERT INTO users(id,tenant_id,name,mobile,email,updated_at) VALUES('root','one','Owner','01711000001','Owner@EXAMPLE.test',NOW())`);
 await db.$executeRawUnsafe(`INSERT INTO users(id,tenant_id,name,mobile,email,identity_root_id,updated_at) VALUES('linked','two','Owner','+8801711000001','owner@example.test','root',NOW())`);
 await db.$executeRawUnsafe(`INSERT INTO projects(id,tenant_id,name,total_shares,updated_at) VALUES('project','one','Project',1,NOW())`);
 await db.$executeRawUnsafe(`INSERT INTO project_memberships(id,tenant_id,project_id,user_id,role,updated_at) VALUES('grant','one','project','root','owner',NOW())`);
 await db.$executeRawUnsafe(`INSERT INTO members(id,tenant_id,project_id,user_id,name,mobile,shares,updated_at) VALUES('member','one','project','root','Owner','01711000001',1,NOW())`);
 return {subscription,invoice};
}
test('populated legacy schema migrates without changing account IDs, permissions, dates or invoice prices',async()=>{
 try{await isolated(async(db,apply)=>{
  const {subscription}=await seed(db);await apply(normalizeSubscriptions);await apply(normalizeUsers);
  assert.equal(await db.user.count(),1);assert.equal(await db.tenantUser.count(),2);
  assert.equal((await db.user.findUniqueOrThrow({where:{id:'root'}})).email,'owner@example.test');assert.equal((await db.user.findUniqueOrThrow({where:{id:'root'}})).mobile,'+8801711000001');
  assert.equal((await db.tenantUser.findUniqueOrThrow({where:{id:'linked'}})).userId,'root');assert.equal((await db.projectMembership.findUniqueOrThrow({where:{id:'grant'}})).userId,'root');assert.equal((await db.member.findUniqueOrThrow({where:{id:'member'}})).userId,'root');
  const stored=await db.tenantSubscription.findUniqueOrThrow({where:{tenantId:'one'}});assert.equal(stored.package,'business');assert.equal(stored.currentPeriodEndAt.toISOString(),subscription.current_period_end_at);
  assert.equal((await db.subscriptionInvoice.findUniqueOrThrow({where:{tenantId_id:{tenantId:'one',id:'one-invoice'}}})).amount,80000);assert.equal(await db.subscriptionHistory.count(),2);
  const contact=(await db.tenant.findUniqueOrThrow({where:{id:'one'}})).contact;assert.deepEqual(contact,{custom:'keep',billing:{payment_instructions:'keep'}});
  const columns=await db.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='tenant_users'`);assert.equal(columns.some(c=>['email','mobile','password_hash','name'].includes(c.column_name)),false);
 });}finally{await root.$disconnect();}
});
test('unlinked duplicate contacts block and roll back identity migration until explicitly resolved',async()=>{
 try{await isolated(async(db,apply)=>{
  await seed(db);await db.$executeRawUnsafe(`UPDATE users SET identity_root_id=NULL WHERE id='linked'`);await apply(normalizeSubscriptions);
  await assert.rejects(apply(normalizeUsers),/IDENTITY_MIGRATION_BLOCKED/);
  const columns=await db.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='users'`);assert.ok(columns.some(c=>c.column_name==='tenant_id'));
  assert.equal((await db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM users`))[0].count,2);
  await db.$executeRawUnsafe(`UPDATE users SET identity_root_id='root' WHERE id='linked'`);await apply(normalizeUsers);assert.equal(await db.user.count(),1);assert.equal(await db.tenantUser.count(),2);
 });}finally{await root.$disconnect();}
});
