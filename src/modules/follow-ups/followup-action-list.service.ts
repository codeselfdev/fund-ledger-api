import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { badRequest } from "../../core/http/api-error.js";
import { calculateDueBalance } from "../members/member-settlement.service.js";
import { addDateDays, dateKey, dhakaDateKey } from "./followups.policy.js";

export const actionListQuerySchema=z.object({
  filter:z.enum(["all","today_upcoming","missed_commitments","no_communication","unreached"]).default("all"),
  upcoming_days:z.coerce.number().int().min(1).max(90).default(7),
  recent_days:z.coerce.number().int().min(1).max(90).default(30),
  page:z.coerce.number().int().min(1).max(1000000).default(1)
}).strict();
type Options=z.infer<typeof actionListQuerySchema>;
type Member={id:string;name:string;mobile:string|null};
type Due={memberId:string;amount:number;paidAmount:number;waivedAmount:number;penaltyDue:number;penaltyPaid:number;dueDate:Date};
type Commitment={memberId:string;amount:number;promisedDate:Date;status:string;createdAt:Date;resolvedAt:Date|null;supersededById:string|null};
type Call={memberId:string;outcome:string;calledAt:Date};
export type ActionListData={members:Member[];dues:Due[];commitments:Commitment[];calls:Call[]};

/** Pure read projection: never resolves commitments, logs calls, or sends reminders. */
export function buildFollowupActionList(data:ActionListData,options:Options,now=new Date()){
  const today=dhakaDateKey(now),through=dateKey(addDateDays(today,options.upcoming_days)),recentFrom=dateKey(addDateDays(today,-options.recent_days));
  const grouped=<T extends {memberId:string}>(rows:T[])=>{const map=new Map<string,T[]>();for(const row of rows){const list=map.get(row.memberId)??[];list.push(row);map.set(row.memberId,list);}return map;};
  const dues=grouped(data.dues),commitments=grouped(data.commitments),calls=grouped(data.calls);
  const all=data.members.flatMap(member=>{
    const unpaid=(dues.get(member.id)??[]).map(d=>({due:d,balance:calculateDueBalance(d).total})).filter(d=>d.balance>0);
    const outstanding=unpaid.reduce((sum,d)=>sum+d.balance,0);if(outstanding<=0)return[];
    const overdue=unpaid.filter(d=>dateKey(d.due.dueDate)<today).sort((a,b)=>a.due.dueDate.getTime()-b.due.dueDate.getTime());
    const open=(commitments.get(member.id)??[]).filter(c=>!c.resolvedAt&&!c.supersededById&&["pending","broken"].includes(c.status));
    const next=open.filter(c=>c.status==="pending"&&dateKey(c.promisedDate)>=today&&dateKey(c.promisedDate)<=through).sort((a,b)=>a.promisedDate.getTime()-b.promisedDate.getTime()||b.createdAt.getTime()-a.createdAt.getTime())[0];
    const missed=open.filter(c=>dateKey(c.promisedDate)<today&&dateKey(c.promisedDate)>=recentFrom).sort((a,b)=>b.promisedDate.getTime()-a.promisedDate.getTime())[0];
    const latest=(calls.get(member.id)??[]).slice().sort((a,b)=>b.calledAt.getTime()-a.calledAt.getTime())[0];
    const deadline=overdue[0]?dateKey(overdue[0].due.dueDate):null;
    const noContact=!!deadline&&(!latest||dhakaDateKey(latest.calledAt)<deadline);
    const unreached=!!deadline&&!noContact&&latest?.outcome==="no_answer";
    const reasons:string[]=[];
    if(next)reasons.push(dateKey(next.promisedDate)===today?"due_today":"upcoming");
    if(missed)reasons.push("missed_commitment");if(noContact)reasons.push("no_communication");if(unreached)reasons.push("unreached");
    if(!reasons.length)return[];
    const priority=reasons.includes("due_today")?0:missed?1:noContact?2:unreached?3:4;
    return[{name:member.name,mobile:member.mobile,reasons,outstanding_amount:outstanding,overdue_amount:overdue.reduce((sum,d)=>sum+d.balance,0),installment_deadline:deadline,
      follow_up_date:priority<4?today:dateKey(next!.promisedDate),commitment_date:next?dateKey(next.promisedDate):null,commitment_amount:next?Math.min(next.amount,outstanding):null,
      missed_commitment_date:missed?dateKey(missed.promisedDate):null,missed_commitment_amount:missed?Math.min(missed.amount,outstanding):null,
      last_call_at:latest?.calledAt.toISOString()??null,last_call_outcome:latest?.outcome??null,priority}];
  }).sort((a,b)=>a.priority-b.priority||a.follow_up_date.localeCompare(b.follow_up_date)||(b.missed_commitment_date??'').localeCompare(a.missed_commitment_date??'')||a.name.localeCompare(b.name));
  const counts={all:all.length,today:all.filter(r=>r.reasons.includes("due_today")).length,upcoming:all.filter(r=>r.reasons.includes("upcoming")).length,missed_commitments:all.filter(r=>r.reasons.includes("missed_commitment")).length,no_communication:all.filter(r=>r.reasons.includes("no_communication")).length,unreached:all.filter(r=>r.reasons.includes("unreached")).length};
  const rows=all.filter(row=>options.filter==="all"||options.filter==="today_upcoming"&&row.reasons.some(r=>["due_today","upcoming"].includes(r))||options.filter==="missed_commitments"&&row.reasons.includes("missed_commitment")||row.reasons.includes(options.filter));
  const page_size=5,total_pages=Math.max(1,Math.ceil(rows.length/page_size));
  if(options.page>total_pages)throw badRequest(`The follow-up list has ${total_pages} pages. Ask for page ${total_pages}.`);
  return{snapshot_at:now.toISOString(),today,upcoming_through:through,recent_from:recentFrom,filter:options.filter,upcoming_days:options.upcoming_days,recent_days:options.recent_days,counts,member_count:rows.length,total_outstanding:rows.reduce((sum,row)=>sum+row.outstanding_amount,0),page:options.page,page_size,total_pages,has_more:options.page<total_pages,
    contact_note:"Communication status is based on recorded call logs only.",follow_up_members:rows.slice((options.page-1)*page_size,options.page*page_size).map(({priority,...row})=>row)};
}

export async function getFollowupActionList(scope:{tenantId:string;projectId:string},options:Options,now=new Date(),db:Pick<PrismaClient,"member"|"due"|"paymentCommitment"|"memberCallLog">=prisma){
  const [members,dues,commitments,calls]=await Promise.all([
    db.member.findMany({where:{...scope,status:"active"},select:{id:true,name:true,mobile:true},orderBy:{name:"asc"}}),
    db.due.findMany({where:scope,select:{memberId:true,amount:true,paidAmount:true,waivedAmount:true,penaltyDue:true,penaltyPaid:true,dueDate:true}}),
    db.paymentCommitment.findMany({where:{...scope,status:{in:["pending","broken"]},resolvedAt:null,supersededById:null},select:{memberId:true,amount:true,promisedDate:true,status:true,createdAt:true,resolvedAt:true,supersededById:true}}),
    // One latest logged call per active project member; never load private summaries.
    db.memberCallLog.findMany({where:{...scope,member:{status:"active"}},distinct:["memberId"],orderBy:[{memberId:"asc"},{calledAt:"desc"},{id:"desc"}],select:{memberId:true,outcome:true,calledAt:true}})
  ]);
  return buildFollowupActionList({members,dues,commitments,calls},options,now);
}
