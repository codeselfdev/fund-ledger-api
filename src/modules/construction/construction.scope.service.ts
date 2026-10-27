import {randomUUID} from 'node:crypto';
import type {Prisma} from '@prisma/client';
import {badRequest,conflict,notFound} from '../../core/http/api-error.js';
import {json,hash} from '../billing/billing.policy.js';
import {audit,head,decideInTransaction} from './construction.service.js';
import {controls,approvedVersion,submitVersion,decideVersion} from './construction.control.service.js';
import {scopeChangeSchema,type reviewSchema} from './construction.workflow.policy.js';
import {scope,evidence,validateReviewer,routedReview,retryRow,clean,type Tx,type A} from './construction.workflow.shared.js';
import type {ControlBoqLine,ScheduleTask} from './construction.control.engine.js';
import type {z} from 'zod';
export async function submitScopeChange(tx:Tx,a:A,raw:unknown){
 const b=scopeChangeSchema.parse(raw),old=retryRow(await tx.constructionScopeChange.findFirst({where:{...scope(a),requestKey:b.request_key}}),a,b);if(old)return old;
 const setup=await controls(tx,a);if(!setup.config.scope_changes)throw badRequest('Enable coordinated scope changes in Site controls setup.');await validateReviewer(tx,a,b.approver_id);await evidence(tx,a,b.drawing_file_ids);const h=await head(tx,a,b.cost_head_id),contract=b.contract_id?await tx.constructionContract.findFirst({where:{...scope(a),id:b.contract_id,costHeadId:h.id,status:'active'}}):null;if(b.contract_id&&!contract)throw notFound('Active contract for this cost head not found.');if(b.contract_change&&!contract)throw badRequest('Choose a contract when changing its amount.');if(b.contract_change&&contract?.billingMode==='item_rate')throw conflict('Item-rate agreements have fixed quantities and rates. Create a supplementary work agreement for extra scope.');
 if(h.revisedBudget!==b.base_budget||contract&&contract.revisedAmount!==b.base_contract_amount)throw conflict('The budget or contract changed. Reload before submitting this scope change.');
 if(!b.budget_change&&!b.contract_change&&!b.quantity_revisions.length&&!b.schedule_impacts.length&&!b.drawing_file_ids.length)throw badRequest('Add a quantity, cost or time change.');if(new Set(b.quantity_revisions.map(l=>l.boq_id)).size!==b.quantity_revisions.length||new Set(b.schedule_impacts.map(l=>l.task_id)).size!==b.schedule_impacts.length)throw badRequest('Do not repeat a BOQ item or task impact.');
 let boqVersionId:string|null=null,scheduleVersionId:string|null=null,financialChangeId:string|null=null;
 const row=await tx.constructionScopeChange.create({data:{...scope(a),costHeadId:h.id,title:b.title,note:b.note,evidence:json(b.drawing_file_ids),payload:{},approverId:b.approver_id,createdById:a.userId,requestKey:b.request_key,requestHash:hash(b)}});
 if(b.quantity_revisions.length){
  const baseline=await approvedVersion(tx,a,'boq');if(!baseline)throw badRequest('Approve a BOQ baseline before requesting quantity revisions.');if(baseline.id!==b.boq_base_id)throw conflict('The BOQ baseline changed. Reload before submitting.');const original=(baseline.payload as unknown as {lines:ControlBoqLine[]}).lines;
  for(const change of b.quantity_revisions)if(!original.some(l=>l.id===change.boq_id&&l.cost_head_id===h.id))throw badRequest('Quantity changes must belong to the selected cost head.');
  const lines=original.map(({id,cost_head_id,task_id,name,unit,quantity,rate,rate_mode,resources})=>{const change=b.quantity_revisions.find(c=>c.boq_id===id);return {id,cost_head_id,...(task_id?{task_id}:{}),name,unit,quantity:change?.quantity??quantity,rate:change?.rate??rate,rate_mode:change?.rate!==undefined?'manual' as const:rate_mode,resources};});
  const v=await submitVersion(tx,a,'boq',{base_id:baseline.id,lines,note:`${b.title}: ${b.note}`.slice(0,2000),request_key:randomUUID()});boqVersionId=v.id;await tx.constructionControlVersion.update({where:{id:v.id},data:{scopeChangeId:row.id}});
 }
 if(b.schedule_impacts.length){
  const baseline=await approvedVersion(tx,a,'schedule');if(!baseline)throw badRequest('Approve a schedule baseline before requesting schedule impacts.');if(baseline.id!==b.schedule_base_id)throw conflict('The schedule baseline changed. Reload before submitting.');const plan=(baseline.payload as unknown as {plan:{anchor:string;tasks:ScheduleTask[]}}).plan;
  for(const impact of b.schedule_impacts){const task=await tx.constructionTask.findFirst({where:{...scope(a),id:impact.task_id,isActive:true}}),pack=task?await tx.constructionWorkPackage.findFirst({where:{...scope(a),id:task.workPackageId,phaseId:h.phaseId??undefined,isActive:true}}):null;
   if(!plan.tasks.some(t=>t.task_id===impact.task_id)||!pack||h.taskId&&h.taskId!==impact.task_id||h.workPackageId&&h.workPackageId!==pack.id)throw badRequest('Schedule impact must reference a scheduled task in this cost-head scope.');}
  const tasks=plan.tasks.map(({task_id,duration,dependencies,not_before,delay_reason})=>{const impact=b.schedule_impacts.find(i=>i.task_id===task_id);return {task_id,duration:duration+(impact?.duration_delta??0),dependencies,...((impact?.not_before??not_before)?{not_before:impact?.not_before??not_before}:{}),...((impact?.reason??delay_reason)?{delay_reason:impact?.reason??delay_reason}:{})};});
  const v=await submitVersion(tx,a,'schedule',{base_id:baseline.id,anchor:plan.anchor,tasks,note:`${b.title}: ${b.note}`.slice(0,2000),request_key:randomUUID()});scheduleVersionId=v.id;await tx.constructionControlVersion.update({where:{id:v.id},data:{scopeChangeId:row.id}});
 }
 if(b.budget_change||b.contract_change){const change=await tx.constructionChangeOrder.create({data:{...scope(a),scopeChangeId:row.id,costHeadId:h.id,contractId:b.contract_id,budgetChange:b.budget_change,contractChange:b.contract_change,reason:b.note,createdById:a.userId,requestKey:randomUUID(),requestHash:hash(b)}});financialChangeId=change.id;}
 const saved=await tx.constructionScopeChange.update({where:{id:row.id},data:{payload:json({...b,request_key:undefined,base_budget:h.revisedBudget,base_contract_amount:contract?.revisedAmount??null,boq_version_id:boqVersionId,schedule_version_id:scheduleVersionId,financial_change_id:financialChangeId})}});await audit(tx,a,'scope_change.submitted','construction_scope_change',row.id,saved);return saved;
}
export async function decideScopeChange(tx:Tx,a:A,id:string,b:z.infer<typeof reviewSchema>){
 const row=await tx.constructionScopeChange.findFirst({where:{...scope(a),id}});if(!row)throw notFound('Scope change not found.');await routedReview(tx,a,row);const status=b.decision==='approve'?'approved':'rejected';if(row.status===status)return row;if(row.status!=='pending')throw conflict('Scope change already reviewed.');
 const p=row.payload as unknown as z.infer<typeof scopeChangeSchema>&{base_budget:number;base_contract_amount:number|null;boq_version_id:string|null;schedule_version_id:string|null;financial_change_id:string|null};
 if(status==='approved'){
  const h=await head(tx,a,row.costHeadId);if(h.revisedBudget!==p.base_budget)throw conflict('The approved budget changed. Submit a fresh coordinated change.');if(p.contract_id){const contract=await tx.constructionContract.findFirst({where:{...scope(a),id:p.contract_id,costHeadId:h.id,status:'active'}});if(!contract||contract.revisedAmount!==p.base_contract_amount)throw conflict('The contract changed. Submit a fresh coordinated change.');}await evidence(tx,a,row.evidence as string[]);
 }
 if(p.boq_version_id)await decideVersion(tx,a,p.boq_version_id,b,row.id);
 if(p.schedule_version_id)await decideVersion(tx,a,p.schedule_version_id,b,row.id);
 if(p.financial_change_id)await decideInTransaction(tx,a,'change_order',p.financial_change_id,b.decision,row.id);
 const saved=await tx.constructionScopeChange.update({where:{id},data:{status,decidedById:a.userId,decidedAt:new Date(),decisionNote:b.note}});await audit(tx,a,`scope_change.${status}`,'construction_scope_change',id,saved);return saved;
}
export async function scopeChanges(tx:Tx,a:A){return (await tx.constructionScopeChange.findMany({where:scope(a),orderBy:{createdAt:'desc'}})).map(clean);}
