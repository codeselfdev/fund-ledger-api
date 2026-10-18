import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const databaseUrl = process.env.SMS_TEST_DATABASE_URL;
if (!databaseUrl) {
  test('login activity and SMS quota PostgreSQL integration (set SMS_TEST_DATABASE_URL)', {skip:true}, () => {});
} else {
  assert.match(new URL(databaseUrl).pathname,/test/i,'Use a disposable test database');
  process.env.DATABASE_URL=databaseUrl;
  const {prisma}=await import('../dist/core/prisma/client.js');
  const {reserveSms}=await import('../dist/modules/auth/otp-delivery.service.js');
  const {recordUserLogin,recordUserActivity,clientActivityContext}=await import('../dist/core/security/client-activity.js');
  const prefix='quota-test:'+randomUUID();let tenantId;
  after(async()=>{
    await prisma.smsDailyUsage.deleteMany({where:{scope:{startsWith:prefix}}});
    if(tenantId)await prisma.tenant.delete({where:{id:tenantId}});
    await prisma.$disconnect();
  });
  test('20 concurrent requests reserve exactly two SMS with PostgreSQL row locks',async()=>{
    const results=await Promise.all(Array.from({length:20},()=>reserveSms([prefix+':concurrent'],'2026-10-18')));
    assert.equal(results.filter(Boolean).length,2);
    const row=await prisma.smsDailyUsage.findUnique({where:{scope_day:{scope:prefix+':concurrent',day:new Date('2026-10-18')}}});
    assert.equal(row.count,2);
  });
  test('multi-tenant reservations rollback completely when one tenant has exhausted its limit',async()=>{
    await reserveSms([prefix+':b'],'2026-10-18');await reserveSms([prefix+':b'],'2026-10-18');
    assert.equal(await reserveSms([prefix+':a',prefix+':b'],'2026-10-18'),false);
    assert.equal(await prisma.smsDailyUsage.count({where:{scope:prefix+':a'}}),0);
  });
  test('quota persists across Prisma connections and resets for a new date',async()=>{
    await reserveSms([prefix+':persistent'],'2026-10-18');await reserveSms([prefix+':persistent'],'2026-10-18');
    await prisma.$disconnect();
    assert.equal(await reserveSms([prefix+':persistent'],'2026-10-18'),false);
    assert.equal(await reserveSms([prefix+':persistent'],'2026-10-19'),true);
  });
  test('login metadata is stored on users and authenticated activity leaves the login unchanged',async()=>{
    const tenant=await prisma.tenant.create({data:{name:'Disposable activity test',slug:prefix.replaceAll(':','-'),users:{create:{name:'Owner',mobile:'+8801700000999'}}},include:{users:true}});tenantId=tenant.id;
    const user=tenant.users[0];
    assert.equal(user.lastLoginAt,null);assert.equal(user.lastActiveAt,null);
    await new Promise((resolve,reject)=>clientActivityContext({header:name=>name==='x-client-platform'?'android':undefined},{},()=>recordUserLogin(user.id).then(resolve,reject)));
    const loggedIn=await prisma.user.findUniqueOrThrow({where:{id:user.id}});
    assert.equal(loggedIn.lastLoginPlatform,'android');assert.ok(loggedIn.lastLoginAt instanceof Date);
    await prisma.user.update({where:{id:user.id},data:{lastActiveAt:new Date('2020-01-01')}});
    await Promise.all([recordUserActivity(user.id),recordUserActivity(user.id)]);
    const active=await prisma.user.findUniqueOrThrow({where:{id:user.id}});
    assert.ok(active.lastActiveAt>new Date('2020-01-01'));assert.equal(active.lastLoginAt.toISOString(),loggedIn.lastLoginAt.toISOString());assert.equal(active.lastLoginPlatform,'android');
  });
}
