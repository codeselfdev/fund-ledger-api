const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function load(file,deps={}){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>n in deps?deps[n]:require(n),m,m.exports);return m.exports;}
const errors=load('src/core/http/api-error.ts'),policy=load('src/modules/institute/institute.policy.ts',{'../../core/http/api-error.js':errors}),notifications=load('src/modules/institute/institute.notifications.ts',{'./institute.policy.js':policy});
test('durable notifications dedupe channels and preserve inbox delivery during quiet hours',async()=>{
 const rows=[],inbox=[];const tx={projectMembership:{findMany:async()=>[{userId:'guardian'},{userId:'guardian'}]},notification:{create:async q=>inbox.push(q.data)},instituteNotificationDelivery:{findFirst:async q=>rows.find(r=>r.userId===q.where.userId&&r.dedupeKey===q.where.dedupeKey&&r.channel===q.where.channel),create:async q=>rows.push(q.data)}};
 const input={tenantId:'t',projectId:'p',userIds:['guardian'],timezone:'Asia/Dhaka',type:'fee.reminder',title:'A fee is due',entityId:'student',dedupe:'remind:student:1',sms:true};
 assert.equal(await notifications.queueInstituteNotifications(tx,input),1);assert.equal(await notifications.queueInstituteNotifications(tx,input),0);assert.equal(inbox.length,1);assert.deepEqual(rows.map(r=>r.channel),['inbox','push','sms']);assert.equal(rows[0].status,'sent');assert.equal(rows[1].status,'pending');assert.equal(rows[2].status,'pending');assert.ok(rows[1].notBefore instanceof Date);
});
test('disabled institute worker makes no database or external delivery calls',async()=>{
 let calls=0;const worker=load('src/modules/institute/institute.worker.ts',{'../../core/prisma/client.js':{prisma:new Proxy({},{get:()=>{calls++;throw Error('Unexpected database access');}})},'../../core/notifications/fcm.service.js':{sendPushMessage:async()=>{calls++;}},'../accounting/transaction.js':{},'./institute.policy.js':{...policy,enabled:()=>false},'./institute.notifications.js':notifications});await worker.deliverInstituteNotifications();assert.equal(calls,0);
});
