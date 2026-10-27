import {randomUUID} from 'node:crypto';
import type {Prisma} from '@prisma/client';
import {badRequest,conflict,notFound} from '../../core/http/api-error.js';
import {scope,sameRequest,type BillingScope} from '../billing/billing.service.js';
import {atDate,hash,json,today} from '../billing/billing.policy.js';
import {audit} from './construction.service.js';
import {resolveWorkContext} from './construction.structure.service.js';
import {calculateSchedule,compareBoq,micro,priceBoq,scheduleFraction,type ControlBoqLine,type WorkCalendar} from './construction.control.engine.js';
import {controlConfig,defaultConfig,scheduleSchema,boqVersionSchema,measureSchema,completionSchema,type decisionSchema} from './construction.control.policy.js';
import type {z} from 'zod';
type Tx=Prisma.TransactionClient;type A=BillingScope;
export async function controls(tx:Tx,a:A){const saved=await tx.constructionControlSetting.findFirst({where:scope(a)});return {revision:saved?.revision??0,config:saved?controlConfig.parse(saved.config):defaultConfig};}
export async function approvedVersion(tx:Tx,a:A,kind:string){return tx.constructionControlVersion.findFirst({where:{...scope(a),kind,status:'approved'},orderBy:{revision:'desc'}});}
export async function forbidDirectBoqEdit(tx:Tx,a:A){if(await approvedVersion(tx,a,'boq'))throw conflict('An approved BOQ baseline exists. Submit a BOQ revision in Site planning & control.');}
const versionPayload=(row:{payload:Prisma.JsonValue})=>row.payload as unknown as {lines:ReturnType<typeof priceBoq>[];plan:ReturnType<typeof calculateSchedule>;config_revision:number};
export async function validateBoq(tx:Tx,a:A,lines:ControlBoqLine[]){
 if(new Set(lines.map(l=>l.id)).size!==lines.length)throw badRequest('BOQ line IDs must be unique.');
 const measured=await tx.constructionMeasurement.findMany({where:{...scope(a),kind:'measurement',status:'approved'}});
 const old=await approvedVersion(tx,a,'boq');const before=old?versionPayload(old).lines:[];
 for(const previous of before){const certified=measured.filter(m=>m.boqId===previous.id).reduce((n,m)=>n+micro(Number(m.quantity)),0n),next=lines.find(l=>l.id===previous.id);
  if(certified>0n&&(!next||micro(next.quantity)<certified||next.unit!==previous.unit||next.cost_head_id!==previous.cost_head_id||next.task_id!==previous.task_id))throw conflict('A BOQ revision cannot remove, reassign or reduce already certified work.');
 }
 const result=[];
 for(const line of lines){
  const h=await tx.constructionCostHead.findFirst({where:{...scope(a),id:line.cost_head_id,status:'approved'}});if(!h)throw notFound('Approved BOQ cost head not found.');
  const existing=await tx.constructionBoq.findFirst({where:{...scope(a),id:line.id}});if(existing&&existing.costHeadId!==h.id)throw badRequest('An existing BOQ item cannot move to another cost head.');
  if(line.task_id){const context=await resolveWorkContext(tx,a,{task_id:line.task_id},h.phaseId??undefined);if(h.workPackageId&&h.workPackageId!==context.workPackageId||h.taskId&&h.taskId!==line.task_id)throw badRequest('BOQ task must match its cost-head scope.');}
  for(const resource of line.resources){if(resource.kind==='material'){if(!resource.item_id)throw badRequest('Material recipes need a catalog item.');const item=await tx.inventoryItem.findFirst({where:{...scope(a),id:resource.item_id,isActive:true}});if(!item)throw notFound('Recipe material not found.');if(item.unit!==resource.unit)throw badRequest('Recipe material units must match stock units.');}}
  try{result.push(priceBoq(line));}catch(e){throw badRequest((e as Error).message);}
 }
 return {lines:result,comparison:compareBoq(before,result)};
}
export async function submitVersion(tx:Tx,a:A,kind:'schedule'|'boq',raw:unknown){
 const b=kind==='schedule'?scheduleSchema.parse(raw):boqVersionSchema.parse(raw),fingerprint={kind,...b};
 const retry=await tx.constructionControlVersion.findFirst({where:{...scope(a),requestKey:b.request_key}});
 if(retry){if(retry.createdById!==a.userId)throw conflict('Request key already used.');sameRequest(retry,fingerprint);return retry;}
 const settings=await controls(tx,a);if(!(kind==='schedule'?settings.config.scheduling:settings.config.advanced_boq))throw badRequest('Enable this optional control in setup first.');
 const current=await approvedVersion(tx,a,kind);if((current?.id??null)!==b.base_id)throw conflict('The baseline changed. Refresh and submit a new revision.');
 let payload;
 if(kind==='schedule'){
  const input=scheduleSchema.parse(b);
  for(const line of input.tasks)await resolveWorkContext(tx,a,{task_id:line.task_id});
  try{payload={plan:calculateSchedule(input.anchor,input.tasks,settings.config.calendar),config_revision:settings.revision};}catch(e){throw badRequest((e as Error).message);}
 }else{payload=await validateBoq(tx,a,boqVersionSchema.parse(b).lines);}
 const versions=await tx.constructionControlVersion.findMany({where:{...scope(a),kind}});
 const row=await tx.constructionControlVersion.create({data:{...scope(a),kind,revision:Math.max(0,...versions.map(v=>v.revision))+1,baseId:b.base_id,payload:json(payload),note:b.note,createdById:a.userId,requestKey:b.request_key,requestHash:hash(fingerprint)}});
 await audit(tx,a,`${kind}.submitted`,'construction_control_version',row.id,row);return row;
}
export async function decideVersion(tx:Tx,a:A,id:string,b:z.infer<typeof decisionSchema>,scopeChangeId?:string){
 const row=await tx.constructionControlVersion.findFirst({where:{...scope(a),id}});if(!row)throw notFound('Revision not found.');if(row.scopeChangeId&&row.scopeChangeId!==scopeChangeId)throw conflict('Review this version through its coordinated scope change.');
 const status=b.decision==='approve'?'approved':'rejected';
 if(row.status===status)return row;if(row.status!=='pending')throw conflict('Revision already reviewed.');if(row.createdById===a.userId)throw conflict('A different authorized person must review this revision.');
 if(status==='approved'){
  const current=await approvedVersion(tx,a,row.kind);if((current?.id??null)!==row.baseId)throw conflict('The baseline changed. Submit a fresh revision.');
  const payload=versionPayload(row);
  if(row.kind==='schedule'){
   const setting=await controls(tx,a);if(setting.revision!==payload.config_revision)throw conflict('The calendar or setup changed. Submit a fresh schedule.');
   for(const task of payload.plan.tasks)await resolveWorkContext(tx,a,{task_id:task.task_id});
  }else{
   const checked=await validateBoq(tx,a,payload.lines);
   const previous=await tx.constructionBoq.findMany({where:scope(a)});
   for(const old of previous)if(!checked.lines.some(l=>l.id===old.id))await tx.constructionBoq.update({where:{id:old.id},data:{isActive:false}});
   for(const line of checked.lines){const existing=previous.find(x=>x.id===line.id),data={name:line.name,unit:line.unit,quantity:line.quantity,rate:line.rate,estimated:line.estimated,isActive:true};
    if(existing)await tx.constructionBoq.update({where:{id:existing.id},data});else await tx.constructionBoq.create({data:{...scope(a),id:line.id,costHeadId:line.cost_head_id,...data}});
   }
  }
 }
 const saved=await tx.constructionControlVersion.update({where:{id:row.id},data:{status,decidedById:a.userId,decidedAt:new Date(),decisionNote:b.note}});await audit(tx,a,`${row.kind}.${status}`,'construction_control_version',row.id,{before:row,after:saved});return saved;
}
export async function progressSnapshot(tx:Tx,a:A,asOf=today()){
 const baseline=await approvedVersion(tx,a,'boq'),schedule=await approvedVersion(tx,a,'schedule');
 const lines=baseline?versionPayload(baseline).lines:[],plan=schedule?versionPayload(schedule).plan:null;
 const measurements=await tx.constructionMeasurement.findMany({where:scope(a),orderBy:{createdAt:'desc'}}),heads=await tx.constructionCostHead.findMany({where:scope(a)});
 const rows=lines.map(line=>{const certified=measurements.filter(m=>m.kind==='measurement'&&m.status==='approved'&&m.boqId===line.id).reduce((n,m)=>n+Number(m.quantity),0),task=plan?.tasks.find(t=>t.task_id===line.task_id),h=heads.find(h=>h.id===line.cost_head_id);
  const planned=task&&plan?line.quantity*scheduleFraction(task.start,task.end,asOf,plan.calendar):null;
  return {...line,phase_id:h?.phaseId??null,phase:h?.phase??'',certified_quantity:certified,planned_quantity:planned,percent:Math.min(100,certified/line.quantity*100)};
 });
 const weighted=(items:typeof rows,key:'percent'|'planned_quantity')=>{const total=items.reduce((n,l)=>n+l.estimated,0);if(!items.length||!total||key==='planned_quantity'&&items.some(l=>l.planned_quantity===null))return null;return items.reduce((n,l)=>n+l.estimated*(key==='percent'?l.percent:(l.planned_quantity??0)/l.quantity*100),0)/total;};
 const phases=[...new Set(rows.map(r=>r.phase))].map(phase=>{const items=rows.filter(r=>r.phase===phase),certificate=measurements.find(m=>m.kind==='completion'&&m.phaseId===items[0]?.phase_id&&m.status==='approved'&&m.baseId===baseline?.id);
  return {phase,phase_id:items[0]?.phase_id,percent:weighted(items,'percent'),planned_percent:weighted(items,'planned_quantity'),certified_complete:!!certificate&&items.every(l=>l.certified_quantity>=l.quantity)&&!measurements.some(m=>m.kind==='measurement'&&m.status==='approved'&&items.some(l=>l.id===m.boqId)&&m.decidedAt&&certificate.decidedAt&&m.decidedAt>certificate.decidedAt),certificate_id:certificate?.id??null};
 });
 const tasks=[...new Set(rows.map(r=>r.task_id).filter((id):id is string=>!!id))].map(task_id=>{const items=rows.filter(l=>l.task_id===task_id),certificate=measurements.find(m=>m.kind==='completion'&&m.taskId===task_id&&m.status==='approved'&&m.baseId===baseline?.id);return {task_id,percent:weighted(items,'percent'),planned_percent:weighted(items,'planned_quantity'),certified_complete:!!certificate&&items.every(l=>l.certified_quantity>=l.quantity)&&!measurements.some(m=>m.kind==='measurement'&&m.status==='approved'&&items.some(l=>l.id===m.boqId)&&m.decidedAt&&certificate.decidedAt&&m.decidedAt>certificate.decidedAt),certificate_id:certificate?.id??null};});
 return {baseline_id:baseline?.id??null,rows,phases,tasks,percent:weighted(rows,'percent'),planned_percent:weighted(rows,'planned_quantity'),measurements:measurements.map(m=>({...m,quantity:Number(m.quantity),requestHash:undefined,requestKey:undefined})),weighting:'Approved BOQ planned value; only independently certified quantities count.'};
}
async function evidence(tx:Tx,a:A,ids:string[]){for(const id of ids){const file=await tx.upload.findFirst({where:{...scope(a),id,deletedAt:null}});if(!file)throw notFound('Project evidence file not found.');}}
export async function submitMeasurement(tx:Tx,a:A,kind:'measurement'|'completion',raw:unknown){
 const b=kind==='measurement'?measureSchema.parse(raw):completionSchema.parse(raw),fingerprint={kind,...b};
 const retry=await tx.constructionMeasurement.findFirst({where:{...scope(a),requestKey:b.request_key}});if(retry){if(retry.createdById!==a.userId)throw conflict('Request key already used.');sameRequest(retry,fingerprint);return retry;}
 const setting=await controls(tx,a);if(!setting.config.progress)throw badRequest('Enable verified progress in setup.');
 const progress=await progressSnapshot(tx,a);if(!progress.baseline_id)throw badRequest('Approve a BOQ baseline before recording measured progress.');await evidence(tx,a,b.evidence_file_ids);
 let boqId:string|null=null,phaseId:string|null=null,taskId=b.task_id??null,quantity=0,reversesId:string|null=null;
 if(kind==='measurement'){
  const input=measureSchema.parse(b),line=progress.rows.find(l=>l.id===input.boq_id);if(!line)throw notFound('BOQ item is outside the approved baseline.');
  if(taskId&&taskId!==line.task_id)throw badRequest('Measurement task must match the baseline BOQ item.');taskId=line.task_id??null;boqId=line.id;phaseId=line.phase_id;quantity=input.quantity;
  if(input.reverses_id){const source=await tx.constructionMeasurement.findFirst({where:{...scope(a),id:input.reverses_id,kind:'measurement',status:'approved',boqId:line.id}});if(!source||Number(source.quantity)<=0)throw notFound('Certified source measurement not found.');const reversals=await tx.constructionMeasurement.findMany({where:{...scope(a),reversesId:source.id,status:'approved'}});if(input.quantity>Number(source.quantity)+reversals.reduce((n,r)=>n+Number(r.quantity),0))throw conflict('Correction exceeds the remaining source quantity.');quantity=-input.quantity;reversesId=source.id;}
  if(micro(line.certified_quantity)+micro(quantity)<0n||micro(line.certified_quantity)+micro(quantity)>micro(line.quantity))throw conflict('Measured work must remain within the approved BOQ quantity.');
 }else{
  const input=completionSchema.parse(b);phaseId=input.phase_id??null;const items=progress.rows.filter(l=>phaseId?l.phase_id===phaseId:l.task_id===taskId);
  if(!items.length||items.some(l=>micro(l.certified_quantity)<micro(l.quantity)))throw conflict('Certify all work quantities before requesting completion.');
 }
 const row=await tx.constructionMeasurement.create({data:{...scope(a),kind,boqId,phaseId,taskId,quantity,baseId:progress.baseline_id,measurementDate:atDate(b.measurement_date),evidence:json(b.evidence_file_ids),note:b.note,reversesId,createdById:a.userId,requestKey:b.request_key,requestHash:hash(fingerprint)}});await audit(tx,a,'progress.submitted','construction_measurement',row.id,row);return row;
}
export async function decideMeasurement(tx:Tx,a:A,id:string,b:z.infer<typeof decisionSchema>){
 const row=await tx.constructionMeasurement.findFirst({where:{...scope(a),id}});if(!row)throw notFound('Progress submission not found.');const status=b.decision==='approve'?'approved':'rejected';
 if(row.status===status)return row;if(row.status!=='pending')throw conflict('Submission already reviewed.');if(row.createdById===a.userId)throw conflict('An independent engineer or authorized approver must certify this work.');
 if(status==='approved'){
  const progress=await progressSnapshot(tx,a);if(progress.baseline_id!==row.baseId)throw conflict('The BOQ baseline changed. Submit a fresh measurement or completion request.');
  if(row.kind==='measurement'){
   const line=progress.rows.find(l=>l.id===row.boqId);if(!line||micro(line.certified_quantity)+micro(Number(row.quantity))<0n||micro(line.certified_quantity)+micro(Number(row.quantity))>micro(line.quantity))throw conflict('Another certification changed the available BOQ quantity.');
   if(row.reversesId){const source=await tx.constructionMeasurement.findFirst({where:{...scope(a),id:row.reversesId,status:'approved'}}),reversals=await tx.constructionMeasurement.findMany({where:{...scope(a),reversesId:row.reversesId,status:'approved'}});if(!source||Number(source.quantity)+reversals.reduce((n,r)=>n+Number(r.quantity),0)+Number(row.quantity)<0)throw conflict('Source quantity was already corrected.');}
  }else{const items=progress.rows.filter(l=>row.taskId?l.task_id===row.taskId:l.phase_id===row.phaseId);if(!items.length||items.some(l=>micro(l.certified_quantity)<micro(l.quantity)))throw conflict('Work quantities are not fully certified.');}
 }
 const saved=await tx.constructionMeasurement.update({where:{id:row.id},data:{status,decidedById:a.userId,decidedAt:new Date(),decisionNote:b.note}});await audit(tx,a,`progress.${status}`,'construction_measurement',row.id,{before:row,after:saved});return saved;
}
export async function importBoqRows(tx:Tx,a:A,rows:Record<string,unknown>[]){
 const heads=await tx.constructionCostHead.findMany({where:{...scope(a),status:'approved'}}),tasks=await tx.constructionTask.findMany({where:{...scope(a),isActive:true}}),issues:{row:number;message:string}[]=[],lines:ControlBoqLine[]=[];
 const current=await approvedVersion(tx,a,'boq'),legacy=current?[]:await tx.constructionBoq.findMany({where:{...scope(a),isActive:true}}),existing=current?versionPayload(current).lines:legacy.map(b=>({id:b.id,cost_head_id:b.costHeadId,name:b.name,unit:b.unit,quantity:Number(b.quantity),rate:b.rate,rate_mode:'manual' as const,resources:[],task_id:heads.find(h=>h.id===b.costHeadId)?.taskId??undefined}));
 for(const [i,row]of rows.entries())try{
  const select=(idKey:string,nameKey:string,items:{id:string;name:string}[],required:boolean)=>{const id=String(row[idKey]??'').trim(),name=String(row[nameKey]??'').trim();const matches=id?items.filter(x=>x.id===id):name?items.filter(x=>x.name.toLowerCase()===name.toLowerCase()):[];if(matches.length!==1&&(required||id||name))throw new Error(`Choose a unique ${nameKey}; use its ID if names repeat.`);return matches[0]?.id;};
  const head=select('cost_head_id','cost_head',heads,true)!,task=select('task_id','task',tasks,false);
  const matches=existing.filter(l=>l.cost_head_id===head&&l.name.toLowerCase()===String(row.name??'').trim().toLowerCase());if(matches.length>1&&!row.id)throw new Error('Use the BOQ ID when work-item names repeat.');
  const line={id:String(row.id??'').trim()||matches[0]?.id||randomUUID(),cost_head_id:head,...(task?{task_id:task}:{}),name:String(row.name??'').trim(),unit:String(row.unit??'').trim(),quantity:Number(row.quantity),rate:Number(row.rate),rate_mode:'manual' as const,resources:[]};
  const checked=boqVersionSchema.shape.lines.element.parse(line);lines.push(checked);
 }catch(e){issues.push({row:i+2,message:(e as Error).message});}
 if(issues.length)return {valid:false,issues,lines:[]};
 const merged=[...existing.filter(l=>!lines.some(n=>n.id===l.id)),...lines];const checked=await validateBoq(tx,a,merged);return {valid:true,issues:[],lines,comparison:checked.comparison};
}
