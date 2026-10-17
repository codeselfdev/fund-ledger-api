import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {prisma} from '../dist/core/prisma/client.js';
import {fundImportSchema,previewFundImport,commitFundImport} from '../dist/modules/members/fund-import.service.js';
import {isSelfOrRole} from '../dist/core/security/auth.context.js';
import {authenticate} from '../dist/core/security/auth.middleware.js';
import {signAccessToken} from '../dist/core/security/jwt.js';
let db,failDue=false;
const context={tenantId:'tenant',projectId:'project',userId:'owner'};
const row=(mid='S1')=>({serial:mid,mid,name:'Member One',mobile:'+8801711000001',email:'',shares:1,previous_due_amount:500,current_installment_amount:1000,total_due_amount:1000,previous_paid_amount:10000,total_paid_amount:10500,comment:''});
const body=()=>fundImportSchema.parse({request_id:'ade2c5a7-0925-4d3c-b8ba-530074325fce',installment_name:'23rd installment',as_of_date:'2026-10-10',rows:[row(),row('S2')]});
beforeEach(()=>{
 failDue=false;db={members:[],schedules:[],dues:[],activities:[],users:[],memberships:[]};
 prisma.project.findFirstOrThrow=async({where})=>{assert.deepEqual(where,{id:'project',tenantId:'tenant'});return{id:'project',name:'Fund',projectType:'fund_shares',totalShares:54,updatedAt:new Date('2026-01-01')};};
 prisma.member.findMany=async({where})=>{assert.equal(where.tenantId,'tenant');assert.equal(where.projectId,'project');return structuredClone(db.members);};
 prisma.member.create=async({data})=>{const member={id:`m${db.members.length+1}`,...data};db.members.push(member);return member;};
 prisma.member.update=async({where,data})=>Object.assign(db.members.find(row=>row.id===where.id),data);
 prisma.due.count=async()=>db.dues.length;prisma.deposit.count=async()=>0;prisma.schedule.count=async()=>db.schedules.length;
 prisma.schedule.create=async({data})=>{const item={id:`s${db.schedules.length+1}`,...data};db.schedules.push(item);return item;};
 prisma.due.create=async({data})=>{if(failDue)throw Error('simulated write failure');db.dues.push(data);return data;};
 prisma.user.upsert=async({create})=>{const item={id:`u${db.users.length+1}`,...create};db.users.push(item);return item;};
 prisma.projectMembership.upsert=async({create,update})=>{const existing=db.memberships.find(r=>r.userId===create.userId);if(existing)return Object.assign(existing,update);db.memberships.push(create);return create;};
 prisma.activity.findUnique=async({where})=>db.activities.find(r=>r.id===where.id)??null;
 prisma.activity.create=async({data})=>{if(db.activities.some(r=>r.id===data.id))throw Object.assign(Error('duplicate'),{code:'P2002'});db.activities.push(data);return data;};
 prisma.activity.update=async({where,data})=>Object.assign(db.activities.find(r=>r.id===where.id),data);
 prisma.account.update=async()=>{throw Error('Opening import must not change cash/bank balances');};
 prisma.accountTransaction.create=async()=>{throw Error('Opening import must not create cash transactions');};
 prisma.deposit.create=async()=>{throw Error('Opening import must not invent deposits');};
 prisma.$transaction=async(fn,options)=>{assert.equal(options.isolationLevel,'Serializable');const snapshot=structuredClone(db);try{return await fn(prisma);}catch(error){db=snapshot;throw error;}};
});
after(async()=>{await prisma.$disconnect();});
test('preview validates and reconciles balances without inserting anything',async()=>{
 const preview=await previewFundImport(context,body());assert.equal(preview.summary.members,2);assert.equal(preview.summary.shares,2);assert.equal(preview.summary.total_due,2000);assert.equal(preview.summary.total_paid,21000);
 assert.equal(db.members.length+db.dues.length+db.activities.length+db.schedules.length,0);
});
test('commit keeps repeated phones separate, preserves history and leaves accounts untouched',async()=>{
 const input=body(),preview=await previewFundImport(context,input);const saved=await commitFundImport(context,input,preview.review_token);
 assert.equal(saved.result.imported_count,2);assert.deepEqual(db.members.map(m=>m.mid),['S1','S2']);assert.equal(db.users.length,1);assert.equal(db.memberships.length,1);assert.equal(saved.invitations.length,0);
 assert.equal(db.dues.reduce((n,r)=>n+r.amount-r.paidAmount,0),2000);assert.equal(db.dues.reduce((n,r)=>n+r.paidAmount,0),21000);assert.equal(db.activities.length,1);
});
test('retry is idempotent and never repeats members, schedules, balances or invitations',async()=>{
 const input=body();input.rows[0].email='member@example.com';input.rows[1].email='member@example.com';
 const preview=await previewFundImport(context,input);const first=await commitFundImport(context,input,preview.review_token);assert.equal(first.invitations.length,1);
 const replay=await commitFundImport(context,input,preview.review_token);assert.equal(replay.result.replayed,true);assert.equal(replay.invitations.length,0);assert.equal(db.members.length,2);assert.equal(db.dues.length,4);
 input.rows[0].name='Changed';await assert.rejects(commitFundImport(context,input,preview.review_token),/different rows/);
});
test('a write failure rolls the entire opening import back',async()=>{
 const input=body(),preview=await previewFundImport(context,input);failDue=true;await assert.rejects(commitFundImport(context,input,preview.review_token),/write failure/);
 assert.deepEqual(db,{members:[],schedules:[],dues:[],activities:[],users:[],memberships:[]});
});
test('duplicate MIDs, inconsistent financials and conflicting emails fail before insert',async()=>{
 for(const mutate of [input=>input.rows[1].mid='s1',input=>input.rows[0].total_paid_amount=1,input=>{input.rows[0].email='one@example.com';input.rows[1].email='two@example.com';}]){
  const input=body();mutate(input);await assert.rejects(previewFundImport(context,input));assert.equal(db.members.length,0);
 }
});
test('stale review, existing history and share-cap violations prevent writes',async()=>{
 const input=body(),preview=await previewFundImport(context,input);input.rows[0].name='Changed';await assert.rejects(commitFundImport(context,input,preview.review_token),/changed after review/);
 input.rows[0].shares=55;await assert.rejects(previewFundImport(context,input),/limit/);input.rows[0].shares=1;
 db.dues.push({});await assert.rejects(previewFundImport(context,input),/before this fund/);
});
test('linked share access allows only explicitly owned member IDs or staff roles',()=>{
 const auth={memberId:'m1',memberIds:['m1','m2'],roles:['member']};assert.equal(isSelfOrRole(auth,'m2',['admin']),true);assert.equal(isSelfOrRole(auth,'foreign',['admin']),false);
});
test('a requested share context is accepted only within the signed-in user, tenant and project',async()=>{
 const token=signAccessToken({sessionId:'session',userId:'user',tenantId:'tenant'});
 prisma.session.findFirst=async()=>({id:'session',tenantId:'tenant',userId:'user',activeProjectId:'project',user:{isActive:true}});
 prisma.projectMembership.findMany=async()=>[{role:'member',memberId:'m1'}];
 prisma.member.findMany=async({where})=>{assert.deepEqual(where,{tenantId:'tenant',projectId:'project',userId:'user',status:'active'});return[{id:'m1'},{id:'m2'}];};
 for(const [selected,allowed]of [['m2',true],['foreign',false]]){
  const req={header:name=>({authorization:`Bearer ${token}`,'x-project-id':'project','x-member-id':selected})[name]};let error;
  await authenticate(req,{},e=>{error=e;});
  if(allowed){assert.equal(error,undefined);assert.equal(req.auth.memberId,'m2');assert.deepEqual(req.auth.memberIds,['m1','m2']);}else assert.equal(error.statusCode,403);
 }
});

test('saved owner and accountant are updated by member ID while only remaining CSV members are created',async()=>{
 db.members=[{id:'owner-member',mid:null,mobile:'+8801711000002',shares:1,status:'active',updatedAt:new Date('2026-01-01')},{id:'accountant-member',mid:null,mobile:'+8801711000003',shares:1,status:'active',updatedAt:new Date('2026-01-01')}];
 const input=body();input.rows=[{...row('OWNER'),member_id:'owner-member',mobile:'+8801711000002'},{...row('ACC'),member_id:'accountant-member',mobile:'+8801711000003'}, {...row('N1'),mobile:'+8801711000004'}, {...row('N2'),mobile:'+8801711000005'}, {...row('N3'),mobile:'+8801711000006'}];
 const preview=await previewFundImport(context,input);assert.deepEqual(preview.matched_member_ids,['owner-member','accountant-member']);assert.equal(preview.existing_members,2);
 await commitFundImport(context,input,preview.review_token);assert.equal(db.members.length,5);assert.equal(db.members.filter(m=>m.id==='owner-member').length,1);assert.equal(db.members.filter(m=>m.id==='accountant-member').length,1);
 assert.equal(db.dues.filter(d=>d.memberId==='owner-member').length,2);assert.equal(db.dues.filter(d=>d.memberId==='accountant-member').length,2);
});
test('duplicate, unknown or changed saved member bindings fail before writing',async()=>{
 db.members=[{id:'saved',mid:null,mobile:'+8801711000001',shares:1,status:'active',updatedAt:new Date('2026-01-01')}];
 for(const mutate of [input=>{input.rows[0].member_id='missing';},input=>{input.rows[0].member_id='saved';input.rows[0].shares=2;},input=>{input.rows[0].member_id='saved';input.rows[0].mobile='+8801711000009';},input=>{input.rows[0].member_id='saved';input.rows[1].member_id='saved';}]){
  const input=body();mutate(input);await assert.rejects(previewFundImport(context,input));assert.equal(db.members.length,1);assert.equal(db.dues.length,0);
 }
});
test('opening advance is usable credit and creates no account transaction or receipt, including on retry',async()=>{
 const deposits=[];prisma.deposit.create=async({data})=>{deposits.push(data);return{id:'opening-advance',...data};};prisma.receipt.create=async()=>{throw Error('Opening advance must not create a payment receipt');};
 const input=body();input.rows[0].advance_amount=750;const preview=await previewFundImport(context,input);assert.equal(preview.summary.advance,750);
 await commitFundImport(context,input,preview.review_token);assert.equal(deposits.length,1);assert.equal(deposits[0].amount,750);assert.equal(deposits[0].allocate,'advance');assert.equal(deposits[0].status,'confirmed');assert.match(deposits[0].reference,/Opening advance/);
 await commitFundImport(context,input,preview.review_token);assert.equal(deposits.length,1);
});
test('a zero-share accountant can receive opening history only when explicitly bound to its saved record',async()=>{
 db.members=[{id:'accountant',mid:null,mobile:'+8801711000001',shares:0,status:'active',updatedAt:new Date('2026-01-01')}];
 const input=body();input.rows=[{...row('ACC'),member_id:'accountant',shares:0}];const preview=await previewFundImport(context,input);await commitFundImport(context,input,preview.review_token);assert.equal(db.members.length,1);assert.equal(db.members[0].shares,0);
});


test('a saved member with a national phone retains its member and user identities',async()=>{
 db.members=[{id:'owner-member',userId:'owner-user',mid:null,mobile:'01711000001',shares:1,status:'active',updatedAt:new Date('2026-01-01')}];
 const input=body();input.rows=[{...row('OWNER'),member_id:'owner-member'}];const preview=await previewFundImport(context,input);await commitFundImport(context,input,preview.review_token);
 assert.equal(db.members.length,1);assert.equal(db.members[0].userId,'owner-user');assert.equal(db.members[0].mobile,'01711000001');assert.equal(db.users.length,0);
});
