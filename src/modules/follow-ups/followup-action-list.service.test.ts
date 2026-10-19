import test from 'node:test';
import assert from 'node:assert/strict';
import {actionListQuerySchema,buildFollowupActionList,getFollowupActionList,type ActionListData} from './followup-action-list.service.js';
const now=new Date('2026-10-18T18:30:00Z'); // 19 October in Dhaka.
const options=(raw={})=>actionListQuerySchema.parse(raw);
const date=(s:string)=>new Date(s+'T00:00:00Z');
const member=(id:string)=>({id,name:id,mobile:'01700000000'});
const due=(memberId:string,dueDate='2026-10-18',amount=100,paidAmount=0)=>({memberId,dueDate:date(dueDate),amount,paidAmount,waivedAmount:0,penaltyDue:0,penaltyPaid:0});
const promise=(memberId:string,promisedDate:string,status='pending')=>({memberId,amount:100,promisedDate:date(promisedDate),status,createdAt:date('2026-10-01'),resolvedAt:null,supersededById:null});
const empty=():ActionListData=>({members:[],dues:[],commitments:[],calls:[]});
test('Dhaka today is included, upcoming is bounded, and deadlines today are not overdue',()=>{
 const data={members:['today','upcoming','too-far','deadline-today'].map(member),dues:['today','upcoming','too-far'].map(id=>due(id,'2026-11-01')).concat(due('deadline-today','2026-10-19')),commitments:[promise('today','2026-10-19'),promise('upcoming','2026-10-26'),promise('too-far','2026-10-27')],calls:[]};
 const result=buildFollowupActionList(data,options(),now);assert.equal(result.today,'2026-10-19');assert.equal(result.upcoming_through,'2026-10-26');assert.deepEqual(result.follow_up_members.map(m=>m.name),['today','upcoming']);assert.deepEqual(result.follow_up_members[0].reasons,['due_today']);assert.equal(result.counts.today,1);
 const filter=buildFollowupActionList(data,options({filter:'today_upcoming',upcoming_days:1}),now);assert.equal(filter.member_count,1);
});
test('missed promises include the last 30 days and exclude resolved, cancelled, rescheduled and superseded promises',()=>{
 const ids=['recent','boundary','old','cancelled','resolved','rescheduled','superseded'];const data:ActionListData={members:ids.map(member),dues:ids.map(id=>due(id,'2026-11-01')),calls:[],commitments:[promise('recent','2026-10-18'),promise('boundary','2026-09-19','broken'),promise('old','2026-09-18'),promise('cancelled','2026-10-18','cancelled'),{...promise('resolved','2026-10-18'),resolvedAt:date('2026-10-18')},promise('rescheduled','2026-10-18','rescheduled'),{...promise('superseded','2026-10-18'),supersededById:'new'}]};
 const result=buildFollowupActionList(data,options({filter:'missed_commitments'}),now);assert.deepEqual(result.follow_up_members.map(m=>m.name),['recent','boundary']);assert.equal(result.recent_from,'2026-09-19');assert.equal(result.follow_up_members[0].missed_commitment_date,'2026-10-18');
});
test('overdue no-call and latest-unanswered are distinct and never infer unrecorded conversations',()=>{
 const ids=['never','old-call','no-answer','reached','future'];const data:ActionListData={members:ids.map(member),dues:ids.map(id=>due(id,id==='future'?'2026-10-20':'2026-10-17')),commitments:[],calls:[{memberId:'old-call',outcome:'committed',calledAt:new Date('2026-10-16T12:00Z')},{memberId:'no-answer',outcome:'no_answer',calledAt:new Date('2026-10-18T12:00Z')},{memberId:'reached',outcome:'no_answer',calledAt:new Date('2026-10-17T12:00Z')},{memberId:'reached',outcome:'dispute',calledAt:new Date('2026-10-18T12:00Z')}]};
 const none=buildFollowupActionList(data,options({filter:'no_communication'}),now);assert.deepEqual(none.follow_up_members.map(m=>m.name),['never','old-call']);
 const unanswered=buildFollowupActionList(data,options({filter:'unreached'}),now);assert.deepEqual(unanswered.follow_up_members.map(m=>m.name),['no-answer']);assert.equal(unanswered.follow_up_members[0].overdue_amount,100);assert.match(unanswered.contact_note,/recorded call logs only/);
});
test('paid and waived dues are excluded, overdue penalties remain due, and overlapping reasons count each member once',()=>{
 const data:ActionListData={members:['paid','waived','penalty'].map(member),dues:[due('paid','2026-10-17',100,100),{...due('waived'),waivedAmount:100},{...due('penalty','2026-10-17',100,100),penaltyDue:20}],commitments:[promise('paid','2026-10-18'),promise('waived','2026-10-19'),promise('penalty','2026-10-18'),promise('penalty','2026-10-20')],calls:[]};
 const result=buildFollowupActionList(data,options(),now);assert.equal(result.member_count,1);assert.equal(result.total_outstanding,20);assert.equal(result.follow_up_members[0].missed_commitment_amount,20);assert.deepEqual(result.follow_up_members[0].reasons,['upcoming','missed_commitment','no_communication']);assert.equal(result.counts.all,1);assert.equal(result.counts.upcoming,1);assert.equal(result.counts.missed_commitments,1);
});
test('five-row pages preserve every member and validate dates/filter window inputs',()=>{
 const ids=Array.from({length:7},(_,i)=>'Member '+i),data={members:ids.map(member),dues:ids.map(id=>due(id)),commitments:[],calls:[]};
 const first=buildFollowupActionList(data,options(),now),second=buildFollowupActionList(data,options({page:2}),now);assert.equal(first.follow_up_members.length,5);assert.equal(second.follow_up_members.length,2);assert.equal(first.has_more,true);assert.equal(second.has_more,false);assert.equal(new Set([...first.follow_up_members,...second.follow_up_members].map(m=>m.name)).size,7);
 assert.throws(()=>buildFollowupActionList(data,options({page:3}),now));for(const raw of [{page:0},{recent_days:0},{upcoming_days:91},{filter:'all_members'},{member_id:'injected'}])assert.equal(actionListQuerySchema.safeParse(raw).success,false);
 const result=buildFollowupActionList(empty(),options(),now);assert.equal(result.total_pages,1);assert.equal(result.member_count,0);
});
test('database reads enforce tenant/project and active-member scope and never select call summaries or mutate records',async()=>{
 const requested:any[]=[];const db:any={};
 for(const table of ['member','due','paymentCommitment','memberCallLog'])db[table]={findMany:async(query:any)=>{requested.push({table,query});return[];},create:()=>{throw Error('No writes');},update:()=>{throw Error('No writes');}};
 const result=await getFollowupActionList({tenantId:'tenant',projectId:'project'},options(),now,db);assert.equal(result.member_count,0);assert.equal(requested.length,4);
 for(const {query}of requested){assert.equal(query.where.tenantId,'tenant');assert.equal(query.where.projectId,'project');assert.equal(query.select.summary,undefined);}
 assert.equal(requested.find(r=>r.table==='member').query.where.status,'active');assert.equal(requested.find(r=>r.table==='memberCallLog').query.where.member.status,'active');
});
