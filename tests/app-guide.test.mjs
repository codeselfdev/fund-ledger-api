import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
process.env.APP_GUIDE_AI_ENABLED='true';process.env.APP_GUIDE_AI_MODEL='test-guide-model';process.env.OPENAI_API_KEY='test-only-not-sent';
const { prisma }=await import('../dist/core/prisma/client.js');
const policy=await import('../dist/modules/app-guide/app-guide.policy.js');
const {selectGuidePlan}=await import('../dist/modules/app-guide/app-guide.provider.js');
const {askAppGuide,appGuideStatus}=await import('../dist/modules/app-guide/app-guide.service.js');
const {personalAccessPath}=await import('../dist/core/security/menu-access.policy.js');
const originalFetch=globalThis.fetch;after(async()=>{globalThis.fetch=originalFetch;await prisma.$disconnect();});
const admin=()=>policy.authorizedArticles('accounting',['owner','admin'],undefined,'en');
test('only guide endpoints bypass custom menu checks; they do not unlock financial actions',()=>{
 assert.equal(personalAccessPath('/v1/app-guide/status','GET'),true);assert.equal(personalAccessPath('/v1/app-guide/ask','POST'),true);
 assert.ok(!personalAccessPath('/v1/app-guide/ask','GET'));assert.ok(!personalAccessPath('/v1/app-guide/status','POST'));assert.ok(!personalAccessPath('/v1/ai-service/chat','POST'));
});
test('authorized public knowledge includes tiny setup options and excludes unrelated projects or forbidden administration',()=>{
 for(const id of ['item_fields','item_search','customer_fields','customer_search','dealer_fields','dealer_search','pdf_template','pdf_item_details','pricing','tax_pricing'])assert.ok(admin().some(a=>a.id===id),id);
 assert.ok(!policy.authorizedArticles('fund_shares',['owner'],undefined,'en').some(a=>a.id==='pdf_template'));
 const custom=policy.authorizedArticles('accounting',[],{expenses:{read:true,write:false}},'bn');assert.deepEqual(custom.map(a=>a.id).sort(),['all_tools','expenses','overview','recurring_expenses']);
 assert.ok(custom.find(a=>a.id==='expenses').steps.some(s=>s.includes('শুধু দেখার')));
 assert.ok(!policy.authorizedArticles('accounting',['member'],undefined,'en').some(a=>a.id==='business_setup'));
 const settings=policy.authorizedArticles('accounting',[],{business_setup:{read:true,write:true}},'en');assert.ok(settings.some(a=>a.id==='item_fields'));assert.ok(!settings.some(a=>a.id==='project_details'));
});
test('detailed feature options reach guide answers while sales grants cannot unlock financial AI help',()=>{
 const articles=admin();for(const id of ['customers','inventory','quotation','order','sale','quick_sale','tax_pricing','receivables','purchases','pdf_template','overview','ai_sales_help'])assert.ok(articles.find(a=>a.id===id)?.options?.length,id);
 assert.ok(!policy.authorizedArticles('accounting',[],{sale:{read:true,write:true}},'en').some(a=>a.id==='ai_sales_help'));
 assert.ok(!policy.authorizedArticles('accounting',['cashier'],undefined,'en').some(a=>a.id==='ai_sales_help'));
 assert.match(articles.find(a=>a.id==='roles').options.join(' '),/Project owner\/admin access does not grant them/);
});
test('clients cannot submit role claims or arbitrary data context',()=>{
 const request={question:'How do I add an item?',language:'en',request_key:randomUUID()};assert.throws(()=>policy.guideBody.parse({...request,roles:['owner']}));assert.throws(()=>policy.guideBody.parse({...request,context:{account_balance:100}}));assert.equal(policy.guideBody.parse(request).language,'en');
});
test('model output can select only authorized guide IDs, never prose, record details, or arbitrary paths',()=>{
 assert.throws(()=>policy.validatePlan({kind:'guide',topic_ids:['secret-record']},admin()));
 assert.throws(()=>policy.validatePlan({kind:'guide',topic_ids:['expenses'],reply:'internal secret'},admin()));
 assert.throws(()=>policy.validatePlan({kind:'guide',topic_ids:[]},admin()));
 assert.throws(()=>policy.validatePlan({kind:'private_data',topic_ids:['expenses']},admin()));
 assert.deepEqual(policy.validatePlan({kind:'guide',topic_ids:['item_fields','pdf_item_details']},admin()).topic_ids,['item_fields','pdf_item_details']);
});
test('provider sends only public instructions and a redacted question, with no tools or stored conversation',async()=>{
 let sent;
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');sent=JSON.parse(options.body);return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({kind:'guide',topic_ids:['item_fields']})}]}]});};
 await selectGuidePlan('Help me add Color. My email is private@example.test and phone is +8801700000000','bn',admin());
 assert.equal(sent.store,false);assert.equal(sent.tools,undefined);assert.equal(sent.previous_response_id,undefined);assert.equal(sent.text.format.strict,true);
 const data=JSON.stringify(sent.input);assert.ok(!data.includes('private@example.test'));assert.ok(!data.includes('8801700000000'));assert.ok(!data.includes('tenant_id'));assert.ok(!data.includes('account_balance'));
});
let memberships=[{role:'owner',customRoleId:null}], root='identity-root', rows=new Map(), providerCalls=0,fail=false,changeRole=false;
const key=(identity,request)=>`${identity}:${request}`;
prisma.user.findFirst=async({where,select})=>{assert.equal(where.isActive,true);assert.deepEqual(Object.keys(select).sort(),['id','identityRoot','identityRootId']);return {id:where.id,identityRootId:root,identityRoot:{isActive:true}};};
prisma.project.findFirst=async({where,select})=>{assert.equal(where.isActive,true);assert.deepEqual(select,{projectType:true});return {projectType:'accounting'};};
prisma.projectMembership.findMany=async({where})=>{assert.equal(where.isActive,true);return memberships;};
function execute(strings,...v){
 const sql=strings.join('?');
 if(sql.startsWith('DELETE')){
  if(sql.includes('created_at'))return 0;
  const id=key(v[0],v[1]),row=rows.get(id);if(row&&!row.plan){rows.delete(id);return 1;}return 0;
 }
 if(sql.startsWith('INSERT')){const [identity,request,tenant_id,project_id,user_id,prompt_hash,authorization_hash]=v;assert.ok(!rows.has(key(identity,request)));rows.set(key(identity,request),{tenant_id,project_id,user_id,prompt_hash,authorization_hash,plan:null});return 1;}
 if(sql.startsWith('UPDATE')){const [plan,identity,request]=v,row=rows.get(key(identity,request));if(!row||row.plan)return 0;row.plan=JSON.parse(plan);return 1;}
 throw Error('Unexpected SQL');
}
function query(strings,...v){
 const sql=strings.join('?');
 if(sql.includes('FOR UPDATE'))return [{id:v[0]}];
 if(sql.includes('COUNT(*)')){assert.match(sql,/WHERE identity_user_id=\?$/);return [{used:BigInt([...rows.keys()].filter(k=>k.startsWith(v[0]+':')).length)}];}
 if(sql.startsWith('SELECT tenant_id')){const row=rows.get(key(v[0],v[1]));return row?[row]:[];}
 throw Error('Unexpected query');
}
prisma.$executeRaw=async(...args)=>execute(...args);prisma.$queryRaw=async(...args)=>query(...args);
let queue=Promise.resolve();
prisma.$transaction=async fn=>{
 const previous=queue;let release;queue=new Promise(resolve=>release=resolve);await previous;let locked=false;
 try{return await fn({$queryRaw:async(strings,...values)=>{if(strings.join('?').includes('FOR UPDATE'))locked=true;else assert.equal(locked,true);return query(strings,...values);},$executeRaw:async(...args)=>{assert.equal(locked,true);return execute(...args);}});}finally{release();}
};
const auth=(projectId='project',userId='user')=>({tenantId:'tenant',projectId,userId});
const input=(question='How do I record an expense?',request_key=randomUUID())=>({question,language:'en',request_key});
function setup(){rows.clear();root='identity-root';memberships=[{role:'owner',customRoleId:null}];providerCalls=0;fail=false;changeRole=false;
 globalThis.fetch=async()=>{providerCalls++;if(fail)return Response.json({}, {status:503});if(changeRole)memberships=[];return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({kind:'guide',topic_ids:['expenses']})}]}]});};
}
test('20 credits are per linked user across projects; concurrent requests cannot overspend',async()=>{
 setup();const results=await Promise.allSettled(Array.from({length:25},(_,i)=>askAppGuide(auth(`project-${i}`,`linked-user-${i%2}`),input())));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,20);assert.equal(providerCalls,20);assert.equal(rows.size,20);
 assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='APP_GUIDE_QUOTA_EXCEEDED'));
 const status=await appGuideStatus(auth('another-project','linked-user-2'),'en');assert.equal(status.remaining,0);assert.equal(status.limit,20);
 root='second-identity';assert.equal((await appGuideStatus(auth(),'en')).remaining,20);
});
test('replays are idempotent, mismatched questions cannot reuse a key, and other projects cannot replay it',async()=>{
 setup();const question=input(),first=await askAppGuide(auth(),question);assert.equal(first.used,1);await askAppGuide(auth(),question);assert.equal(providerCalls,1);
 await assert.rejects(askAppGuide(auth(),{...question,question:'Different question'}),/different question/);
 await assert.rejects(askAppGuide(auth('other'),question),/access changed/);assert.equal(rows.size,1);
 assert.ok([...rows.values()].every(row=>!('question'in row)&&!('prompt'in row)&&!('reply'in row)));
});
test('provider failures refund the reservation and a revoked role cannot receive a generated answer',async()=>{
 setup();fail=true;await assert.rejects(askAppGuide(auth(),input()),/unavailable/);assert.equal(rows.size,0);
 fail=false;changeRole=true;await assert.rejects(askAppGuide(auth(),input()),/access is no longer active/);assert.equal(rows.size,0);
});

test('Fund/Share knowledge covers personal and staff workflows without elevating custom roles',()=>{
 const owner=policy.authorizedArticles('fund_shares',['owner'],undefined,'en');
 for(const id of ['fund_guided_setup','member_profile','member_documents','member_document_titles','share_changes','share_transfer','fund_dues','member_payments','payment_allocation','fund_receipts','member_settlement','member_removal','account_transfers','report_automation','member_portal_settings','ai_fund_help'])assert.ok(owner.some(a=>a.id===id),id);
 const restricted=['share_changes','share_transfer','member_removal','member_document_titles','report_automation','member_portal_settings','ai_fund_help'];
 const personal=policy.authorizedArticles('fund_shares',['member'],undefined,'bn');assert.ok(personal.some(a=>a.id==='member_portal'));assert.ok(!personal.find(a=>a.id==='members').options.some(text=>text.includes('সদস্য যোগ')));assert.ok(!personal.some(a=>[...restricted,'member_profile','member_documents','member_settlement'].includes(a.id)));
 const accountant=policy.authorizedArticles('fund_shares',['accountant'],undefined,'en');assert.ok(accountant.some(a=>a.id==='member_settlement'));assert.ok(!accountant.some(a=>restricted.filter(id=>id!=='ai_fund_help').includes(a.id)));
 for(const write of [false,true]){const custom=policy.authorizedArticles('fund_shares',[],{members:{read:true,write},deposits:{read:true,write},reports:{read:true,write},business_setup:{read:true,write}},'en');assert.ok(custom.some(a=>a.id==='fund_dues'));assert.ok(custom.some(a=>a.id==='fund_receipts'));assert.ok(!custom.some(a=>[...restricted,'member_settlement'].includes(a.id)));if(!write)assert.ok(custom.find(a=>a.id==='member_payments').steps.some(s=>s.includes('viewing steps')));const visible=new Set(custom.map(a=>a.id));assert.ok(custom.every(a=>a.related.every(id=>visible.has(id))));}
 assert.deepEqual(policy.validatePlan({kind:'guide',topic_ids:['member_settlement','share_transfer']},owner).topic_ids,['member_settlement','share_transfer']);
 assert.throws(()=>policy.validatePlan({kind:'guide',topic_ids:['share_transfer']},personal));
 assert.match(owner.find(a=>a.id==='schedules').options.join(' '),/equal amount per active member, not per share/);
 assert.match(owner.find(a=>a.id==='recurring').options.join(' '),/3 shares × 500 per share = 1,500/);
});
