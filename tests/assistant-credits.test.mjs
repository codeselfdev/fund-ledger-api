import { fixtureTransactionClient, subscriptionRow } from './helpers/normalized-fixtures.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'ai-credit-tests'});
const {featureLimit,hasAssistant,hasBusinessAssistant,assistantUpgrade}=await import('../dist/modules/assistant/assistant.policy.js');
const {assistantImageInfo,MAX_AI_IMAGE_BYTES}=await import('../dist/modules/assistant/image-policy.js');
const {validateAssistantImage}=await import('../dist/modules/assistant/assistant-upload.js');
const {prisma}=await import('../dist/core/prisma/client.js');
const {reserveReply,assistantStatus}=await import('../dist/modules/assistant/assistant.service.js');
after(()=>prisma.$disconnect());
const contact=(plan,status=plan==='free'?'trial':'active')=>({subscription:{package:plan,status,trial_ends_at:'2099-01-01T00:00:00Z',current_period_end_at:status==='active'?'2099-01-01T00:00:00Z':null}});
test('Free and Starter get fixed credits; WhatsApp remains Business only and expired plans fail closed',()=>{
 for(const [plan,limit,next] of [['free',10,'starter'],['starter',100,'business'],['business',1000,'custom']]){
  const c=contact(plan);assert.equal(featureLimit('ai_chat',c),limit);assert.equal(hasAssistant(c),true);assert.equal(assistantUpgrade(c),next);
  assert.equal(hasAssistant(c,'whatsapp_bot'),plan==='business');assert.equal(hasBusinessAssistant(c),plan==='business');
 }
 assert.equal(hasAssistant(contact('business','trial')),false);
 assert.equal(hasAssistant({subscription:{package:'free',status:'trial',trial_ends_at:'2000-01-01T00:00:00Z'}}),false);
 assert.equal(hasAssistant(null),false);assert.equal(hasAssistant(contact('custom')),false);
});
test('organization credit reservation serializes the final slot across projects, charges failures and permits safe replay',async()=>{
 let plan='free',rows=[],queue=Promise.resolve();
 prisma.$transaction=fn=>{const next=queue.then(()=>fn(fixtureTransactionClient(prisma)));queue=next.catch(()=>{});return next;};
 prisma.$queryRaw=async()=>[];prisma.tenant.findUniqueOrThrow=async()=>({contact:{},subscription:subscriptionRow('tenant',contact(plan).subscription)});
 prisma.assistantReply.findUnique=async({where})=>rows.find(row=>row.requestKey===where.tenantId_channel_requestKey.requestKey);
 prisma.assistantReply.count=async({where})=>rows.filter(row=>row.channel===where.channel&&row.periodStart.getTime()===where.periodStart.getTime()).length;
 prisma.assistantReply.create=async({data})=>{const row={...data,id:String(rows.length)};rows.push(row);return row;};
 prisma.assistantReply.groupBy=async()=>[{channel:'ai_chat',_count:rows.length}];
 const input={tenantId:'tenant',projectId:'project',userId:'user',channel:'ai_chat',prompt:'Balance?'};
 for(let i=0;i<9;i++)await reserveReply({...input,requestKey:String(i)});
 rows[0].status='failed'; // Provider failure still occupies one of the ten credits.
 const final=await Promise.allSettled(Array.from({length:8},(_,i)=>reserveReply({...input,projectId:'project-'+i,requestKey:'last-'+i})));
 assert.equal(final.filter(r=>r.status==='fulfilled').length,1);assert.equal(rows.length,10);
 assert.ok(final.filter(r=>r.status==='rejected').every(r=>r.reason.code==='ASSISTANT_QUOTA_EXCEEDED'&&r.reason.message.includes('Starter')));
 assert.equal((await reserveReply({...input,requestKey:'0'})).status,'failed');assert.equal(rows.length,10);
 await assert.rejects(reserveReply({...input,requestKey:'0',prompt:'Changed prompt'}),/another question/);
 await assert.rejects(reserveReply({...input,requestKey:'0',userId:'another'}));
 plan='starter';assert.equal((await assistantStatus('tenant')).features.ai_chat.limit,100);
 await reserveReply({...input,requestKey:'upgraded'});assert.equal(rows.length,11);
});
function png(width=1600,height=900){const b=Buffer.alloc(45);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);b.write('IEND',37);return b;}
test('server rejects oversized, animated and unbounded-dimension images before provider calls',()=>{
 assert.equal(validateAssistantImage(png()),'image/png');assert.equal(assistantImageInfo(png()).width,1600);
 for(const bytes of [Buffer.alloc(MAX_AI_IMAGE_BYTES),Buffer.from('not an image'),png(1601,1),png(1,0)])assert.throws(()=>validateAssistantImage(bytes));
 const animated=png();animated.write('acTL',37);assert.throws(()=>validateAssistantImage(animated));
});
