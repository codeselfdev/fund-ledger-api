import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, notFound } from '../../core/http/api-error.js';
import { readObject, storeObject } from '../../core/storage/object-storage.service.js';
import { sendMail, describeMailFailure } from '../../core/mail/mailer.service.js';
import { sendTelegramPost } from '../integrations/telegram.service.js';
import { buildReport, workbookFiles } from './report.workbook.js';
import { exportSchema, type ExportConfig, type Scope, type Destinations } from './report.policy.js';
export const MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export type StoredFile={filename:string;storage_key:string;size:number};
export async function staffRecipients(scope:Pick<Scope,'tenantId'|'projectId'>) {
  const rows=await prisma.projectMembership.findMany({where:{tenantId:scope.tenantId,projectId:scope.projectId,isActive:true,role:{not:'member'},user:{ isActive:true}},include:{user:{select:{ id:true, deviceId:true, identity: {select: {name:true, email:true}} }}}});
  return [...new Set(rows.map(r=>r.userId))].map(id=>({id,name:rows.find(r=>r.userId===id)!.user.identity.name,email:rows.find(r=>r.userId===id)!.user.identity.email,roles:[...new Set(rows.filter(r=>r.userId===id).map(r=>r.role))]}));
}
export async function validateDestinations(scope:Pick<Scope,'tenantId'|'projectId'>,d:Destinations) {
  if(!d.email&&!d.inbox&&!d.telegram) throw badRequest('Choose at least one destination');
  const people=await staffRecipients(scope), selected=people.filter(p=>d.recipient_ids.includes(p.id));
  if(d.recipient_ids.some(id=>!people.some(p=>p.id===id))) throw badRequest('Recipients must be active staff in this project');
  if((d.email||d.inbox)&&!selected.length) throw badRequest('Choose staff recipients');
  if(d.email&&selected.some(p=>!p.email)) throw badRequest('Every email recipient must have an email address');
  if(d.telegram) {
    const c=await prisma.telegramConnection.findFirst({where:{tenantId:scope.tenantId,projectId:scope.projectId}});
    if(!c||!c.report) throw badRequest('Connect Telegram and enable Daily report in Integrations');
  }
  return selected;
}
export async function createExport(scope:Scope,config:ExportConfig,slot?:string) {
  const row=await prisma.reportExport.create({data:{tenantId:scope.tenantId,projectId:scope.projectId,createdById:scope.userId,config:json(config),scheduleSlot:slot}});
  try {
    const report=await buildReport(scope,config);
    const files:StoredFile[]=[];
    for(const file of workbookFiles(report,config.layout)) {
      const storage_key=`${scope.tenantId}/${scope.projectId}/reports/${row.id}/${file.filename}`;
      await storeObject({storageKey:storage_key,buffer:file.buffer,contentType:MIME});
      files.push({filename:file.filename,storage_key,size:file.buffer.length});
    }
    const preview={...report,sheets:report.sheets.map(s=>({...s,rows:s.rows.slice(0,21)}))};
    await prisma.reportExport.update({where:{id:row.id},data:{status:'ready',files:json(files),preview:json(preview)}});
    return getExport(scope,row.id);
  } catch(error) {
    await prisma.reportExport.update({where:{id:row.id},data:{status:'failed',error:error instanceof Error?error.message:'Generation failed'}});
    throw error;
  }
}
export async function getExport(scope:Pick<Scope,'tenantId'|'projectId'>,id:string) {
  const row=await prisma.reportExport.findFirst({where:{tenantId:scope.tenantId,projectId:scope.projectId,id},include:{deliveries:{orderBy:{createdAt:'asc'}}}});
  if(!row) throw notFound('Report export not found');
  return {...row,files:((row.files??[]) as StoredFile[]).map((f,index)=>({filename:f.filename,size:f.size,index}))};
}
export async function reportFile(scope:Pick<Scope,'tenantId'|'projectId'>,id:string,index:number) {
  const row=await prisma.reportExport.findFirst({where:{tenantId:scope.tenantId,projectId:scope.projectId,id,status:'ready'}});
  if(!row) throw notFound('Report not found or not ready');
  const file=(row.files as StoredFile[])[index];
  if(!file) throw notFound('Report file not found');
  const stored=await readObject(file.storage_key);
  return {filename:file.filename,buffer:stored.buffer};
}
export async function deliverExport(scope:Scope,id:string,d:Destinations,retry=false) {
  const recipients=await validateDestinations({tenantId:scope.tenantId,projectId:scope.projectId},d);
  const row=await prisma.reportExport.findFirst({where:{id,tenantId:scope.tenantId,projectId:scope.projectId,status:'ready'}});
  if(!row) throw notFound('Report is not ready');
  const files=row.files as StoredFile[], report=row.preview as {project_name:string;date:string;stats:{collected:number;spent:number;balance:number;outstanding:number}};
  const title=`${report.project_name} · Daily report · ${report.date}`;
  const text=`${title}\nCollected: BDT ${report.stats.collected}\nSpent: BDT ${report.stats.spent}\nCash & bank: BDT ${report.stats.balance}\nOutstanding dues: BDT ${report.stats.outstanding}`;
  const tasks:{channel:string;target:string;send:(attempt:number)=>Promise<unknown>}[]=[];
  // Load attachments only when delivery needs them. Never expose storage keys to clients.
  const attachments=d.email||d.telegram?await Promise.all(files.map(async f=>({filename:f.filename,buffer:(await readObject(f.storage_key)).buffer}))):[];
  for(const person of recipients) {
    if(d.email) tasks.push({channel:'email',target:person.id,send:async()=>{
      const sent=await sendMail({to:person.email!,subject:title,text,attachments:attachments.map(f=>({filename:f.filename,content:f.buffer,contentType:MIME}))});
      if(!sent) throw new Error(describeMailFailure().message);
    }});
    if(d.inbox) tasks.push({channel:'inbox',target:person.id,send:async()=>prisma.notification.create({data:{tenantId:scope.tenantId,projectId:scope.projectId,recipientUserId:person.id,actorUserId:scope.userId,type:'report.ready',title,body:`${files.length} Excel file(s) ready. ${text}`,entityType:'report_export',entityId:id}})});
  }
  if(d.telegram) {
    const connection=await prisma.telegramConnection.findFirstOrThrow({where:{tenantId:scope.tenantId,projectId:scope.projectId}});
    attachments.forEach((file,index)=>tasks.push({channel:'telegram',target:`${connection.chatId}:${index}`,send:async attempt=>sendTelegramPost({tenantId:scope.tenantId,projectId:scope.projectId},`Daily report · ${file.filename}`,`report:${id}:${connection.chatId}:${index}:${attempt}`,text,[file])}));
  }
  for(const task of tasks) {
    const delivery=await prisma.reportDelivery.upsert({where:{exportId_channel_target:{exportId:id,channel:task.channel,target:task.target}},create:{exportId:id,channel:task.channel,target:task.target},update:{}});
    const claim=await prisma.reportDelivery.updateMany({where:{id:delivery.id,status:{in:retry?['pending','failed']:['pending']}},data:{status:'sending',attempts:{increment:1},error:null}});
    if(!claim.count) continue;
    try { await task.send(delivery.attempts+1);await prisma.reportDelivery.update({where:{id:delivery.id},data:{status:'sent'}}); }
    catch(error) { await prisma.reportDelivery.update({where:{id:delivery.id},data:{status:'failed',error:error instanceof Error?error.message:'Delivery failed'}}); }
  }
  return getExport(scope,id);
}
export async function retryExport(scope:Scope,id:string) {
  const row=await prisma.reportExport.findFirst({where:{tenantId:scope.tenantId,projectId:scope.projectId,id},include:{deliveries:true}});
  if(!row) throw notFound();
  const failed=row.deliveries.filter(d=>d.status==='failed');
  if(!failed.length) return getExport(scope,id);
  // Retry only failed channels/recipients; successful claims remain sent.
  for(const channel of ['email','inbox','telegram']) {
    const targets=failed.filter(d=>d.channel===channel).map(d=>d.target);
    if(!targets.length) continue;
    if(channel==='telegram') {
      const connection=await prisma.telegramConnection.findFirst({where:{tenantId:scope.tenantId,projectId:scope.projectId}});
      if(!connection||targets.some(target=>!target.startsWith(`${connection.chatId}:`))) throw badRequest('The original Telegram group is no longer connected. Review the new destination before sending this report again.');
    }
    await deliverExport(scope,id,{email:channel==='email',inbox:channel==='inbox',telegram:channel==='telegram',recipient_ids:channel==='telegram'?[]:targets},true);
  }
  return getExport(scope,id);
}
export async function getSchedule(scope:Scope) {
  const row=await prisma.reportSchedule.findFirst({where:{tenantId:scope.tenantId,projectId:scope.projectId}});
  const defaults={enabled:false,time:'21:00',timezone:'Asia/Dhaka',days:[0,1,2,3,4,5,6],sheets:['summary','banks','ie'],recipient_ids:[],email:true,inbox:false,telegram:false};
  return row?{enabled:row.enabled,time:row.time,timezone:row.timezone,days:row.days,sheets:row.sheets,recipient_ids:row.recipientIds,email:row.email,inbox:row.inbox,telegram:row.telegram}:defaults;
}
export async function testTelegram(scope:Scope) { await sendTelegramPost({tenantId:scope.tenantId,projectId:scope.projectId},'Test message',`test:${randomUUID()}`,'FundLedger is connected. Reports and enabled updates will appear in this group.'); }
