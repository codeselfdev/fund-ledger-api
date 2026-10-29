import {subscriptionContext} from "../../core/subscription/subscription.repository.js";
import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from '../../core/prisma/client.js';
import { evaluateSubscription } from '../../core/subscription/subscription.service.js';
import { createExport, deliverExport } from './report.service.js';
import { dueRemaining, exportSchema, localParts } from './report.policy.js';
import { sendTelegramPost } from '../integrations/telegram.service.js';
let task:ScheduledTask|null=null,busy=false;
export async function runReportsWorker(now=new Date()) {
  if(process.env.REPORTS_AUTOMATION_ENABLED!=='true'||busy) return;busy=true;
  try {
    const schedules=await prisma.reportSchedule.findMany({where:{enabled:true,project:{isActive:true}},include:{project:{include:{tenant:{ include: { subscription: true } }}}}});
    for(const s of schedules) {
      if(!evaluateSubscription(subscriptionContext(s.project.tenant),now).has_access) continue;
      if(!await prisma.projectMembership.findFirst({where:{tenantId:s.tenantId,projectId:s.projectId,userId:s.updatedById,isActive:true,role:{in:['owner','admin']},user:{ isActive:true}}})) continue;
      const local=localParts(now,s.timezone);
      if(!s.days.includes(local.day)||local.time<s.time) continue;
      const edited=localParts(s.updatedAt,s.timezone);
      if(edited.date===local.date&&edited.time>=s.time) continue;
      const scope={tenantId:s.tenantId,projectId:s.projectId,userId:s.updatedById};
      const slot=`${s.projectId}:${local.date}`;
      if(await prisma.reportExport.findUnique({where:{scheduleSlot:slot},select:{id:true}})) continue;
      try {
        const report=await createExport(scope,exportSchema.parse({sheets:s.sheets,timezone:s.timezone,period:'month',layout:'one'}),slot);
        await deliverExport(scope,report.id,{recipient_ids:s.recipientIds,email:s.email,inbox:s.inbox,telegram:s.telegram});
      } catch(error) {
        if((error as {code?:string}).code!=='P2002') {
          const message=error instanceof Error?error.message:'Scheduled report failed';
          await prisma.reportExport.updateMany({where:{scheduleSlot:slot},data:{error:message}}).catch(()=>undefined);
          console.error('[reports] scheduled export failed',{projectId:s.projectId,message});
        }
      }
    }
    await runIntegrationUpdates(now);
    await prisma.reportDelivery.updateMany({where:{status:'sending',updatedAt:{lt:new Date(now.getTime()-10*60000)}},data:{status:'unknown',error:'Delivery was interrupted. Check the destination before sending a new report.'}});
    await prisma.reportExport.updateMany({where:{status:'building',createdAt:{lt:new Date(now.getTime()-15*60000)}},data:{status:'failed',error:'Report generation was interrupted. Build a new export.'}});
    await prisma.telegramLink.deleteMany({where:{expiresAt:{lt:new Date(now.getTime()-86400000)}}});
  } finally { busy=false; }
}
async function runIntegrationUpdates(now:Date) {
  const connections=await prisma.telegramConnection.findMany({include:{project:{include:{tenant:{ include: { subscription: true } }}}}});
  for(const c of connections) {
    if(!c.project.isActive||!evaluateSubscription(subscriptionContext(c.project.tenant),now).has_access) continue;
    const scope={tenantId:c.tenantId,projectId:c.projectId};
    const since=new Date(Math.max(c.connectedAt.getTime(),c.updatedAt.getTime(),now.getTime()-7*86400000));
    const post=async(label:string,key:string,text:string)=>{
      try { await sendTelegramPost(scope,label,`${c.id}:${key}`,text); } catch(error) { console.error('[integrations] update delivery failed',{projectId:c.projectId,message:error instanceof Error?error.message:'Delivery failed'}); }
    };
    if(c.notices) {
      const notices=await prisma.projectNotice.findMany({where:{...scope,createdAt:{gt:since},expiresAt:{gt:now},deletedAt:null},orderBy:{createdAt:'asc'},take:100});
      for(const n of notices) await post(`Notice · ${n.title}`,`notice:${n.id}`,`${c.project.name}\n${n.title}\n${n.body}`);
    }
    if(c.approvals) {
      const expenses=await prisma.expense.findMany({where:{...scope,amount:{gt:50000},status:{in:['approved','paid']},updatedAt:{gt:since}},take:100});
      for(const e of expenses) await post(`Large expense · ${e.title}`,`expense:${e.id}`,`${c.project.name}\nApproved expense: ${e.title}\nBDT ${e.amount}`);
    }
    if(c.reminders) {
      const local=localParts(now,'Asia/Dhaka');
      if(local.day===1&&local.time>='09:00') {
        const dues=await prisma.due.findMany({where:scope,include:{member:{select:{name:true}}}});
        const totals=new Map<string,{name:string;amount:number}>();
        for(const d of dues) {const v=totals.get(d.memberId)??{name:d.member.name,amount:0};v.amount+=dueRemaining(d);totals.set(d.memberId,v);}
        const outstanding=[...totals.values()].filter(v=>v.amount>0);
        if(outstanding.length) await post('Weekly due reminders',`dues:${local.date}`,`${c.project.name} · Outstanding dues\n${outstanding.slice(0,50).map(v=>`${v.name}: BDT ${v.amount}`).join('\n')}${outstanding.length>50?`\nAnd ${outstanding.length-50} more members`:''}`);
      }
    }
  }
}
export function startReportsWorker() {
  if(process.env.REPORTS_AUTOMATION_ENABLED!=='true'||task) return;
  const run=()=>void runReportsWorker().catch(error=>console.error('[reports] worker failed',error instanceof Error?error.message:'Unknown error'));
  task=cron.schedule('* * * * *',run);run();
}
export function stopReportsWorker() {task?.stop();task=null;}
