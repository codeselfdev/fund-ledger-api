import type {Prisma} from '@prisma/client';
import {badRequest,conflict,notFound} from '../../core/http/api-error.js';
import {scope,type BillingScope} from '../billing/billing.service.js';
import {siteContentSchema} from './construction.policy.js';
import {validateSiteWorkContext} from './construction.structure.service.js';
import {verifiedOutput,workRows,workforceSummary,type SiteSource} from './construction-workforce.engine.js';
type Tx=Prisma.TransactionClient;
export async function validateContractorWork(tx:Tx,a:BillingScope,raw:unknown,review=false,excludeLogId?:string){
 const content=siteContentSchema.parse(raw),ids=new Set([...content.contractor_work.map(r=>r.contract_id),...content.materials.flatMap(m=>m.contract_id?[m.contract_id]:[])]);
 const contracts=await tx.constructionContract.findMany({where:{...scope(a),id:{in:[...ids]},status:{in:review?['active','suspended','closed']:['active']}}});
 if(contracts.length!==ids.size)throw notFound('Choose an approved contractor agreement from this project.');
 const heads=await tx.constructionCostHead.findMany({where:{...scope(a),id:{in:contracts.map(c=>c.costHeadId)},status:'approved'}});
 if(heads.length!==new Set(contracts.map(c=>c.costHeadId)).size)throw notFound('Approved contractor budget category not found.');
 for(const row of content.contractor_work){const contract=contracts.find(c=>c.id===row.contract_id)!;
  await validateSiteWorkContext(tx,a,{...content,task_id:row.task_id??content.task_id,location_id:row.location_id??content.location_id,labor:[{cost_head_id:contract.costHeadId}],materials:[]});
  const items=(contract.workItems??[]) as {id:string;quantity:number}[];
  for(const output of row.outputs)if(!items.some(i=>i.id===output.work_item_id&&output.quantity<=i.quantity))throw badRequest('Daily completed work must reference an agreed work item and stay within its quantity.');
 }
 for(const material of content.materials.filter(m=>m.contract_id)){
  const contract=contracts.find(c=>c.id===material.contract_id)!,agreementHead=heads.find(h=>h.id===contract.costHeadId)!;
  // The agreement is an attribution link, not the material's financial budget.
  // Company materials may use their own approved cost head within the same work scope.
  await validateSiteWorkContext(tx,a,{...content,phase_id:agreementHead.phaseId??content.phase_id,work_package_id:agreementHead.workPackageId??content.work_package_id,task_id:agreementHead.taskId??content.task_id,location_id:agreementHead.locationId??content.location_id,labor:[{cost_head_id:contract.costHeadId}],materials:[material]});
 }
 if(review&&content.contractor_work.length){
  const previous=await tx.constructionSiteLog.findMany({where:{...scope(a),status:'approved'}});
  for(const contract of contracts){const verified=verifiedOutput(contract.id,previous.filter(l=>l.id!==excludeLogId),'9999-12-31').quantities,added:Record<string,number>=Object.create(null);
   for(const row of content.contractor_work.filter(r=>r.contract_id===contract.id))for(const output of row.outputs)added[output.work_item_id]=(added[output.work_item_id]??0)+Math.round(output.quantity*1000);
   for(const item of (contract.workItems??[]) as {id:string;quantity:number}[])if(Math.round((verified[item.id]??0)*1000)+(added[item.id]??0)>Math.round(item.quantity*1000))throw conflict('Verified site output would exceed the agreed work quantity. Correct the daily log before approval.');
  }
 }
 return contracts;
}
export async function contractorTracking(tx:Tx,a:BillingScope,through:string){
 const contracts=await tx.constructionContract.findMany({where:{...scope(a),status:{in:['active','suspended','closed']}},include:{contractor:true,costHead:true},orderBy:{createdAt:'desc'}});
 const logs=await tx.constructionSiteLog.findMany({where:{...scope(a),workDate:{lte:new Date(`${through}T00:00:00Z`)},status:{in:['approved','pending']}}});
 return {through,contracts,rows:contracts.map(c=>workforceSummary(c,logs,through))};
}
export async function billSiteSources(tx:Tx,a:BillingScope,contractId:string,through:string,quantities:{item_id:string;cumulative_quantity:number}[]){
 const logs=await tx.constructionSiteLog.findMany({where:{...scope(a),status:'approved',workDate:{lte:new Date(`${through}T00:00:00Z`)}}}),verified=verifiedOutput(contractId,logs,through);
 for(const q of quantities)if(Math.round(q.cumulative_quantity*1000)!==Math.round((verified.quantities[q.item_id]??0)*1000))throw conflict('Verified daily output changed. Reload the verified quantities before requesting this bill.');
 return verified.sources;
}
export async function verifyBillSiteSources(tx:Tx,a:BillingScope,contractId:string,billDate:Date,raw:unknown){
 if(!Array.isArray(raw))return;
 const lines=raw as {id:string;cumulative_quantity:number;site_log_sources?:SiteSource[]}[];
 if(!lines.some(l=>l.site_log_sources!==undefined))return;
 for(const line of lines){
  if(!Array.isArray(line.site_log_sources))throw conflict('Daily output references are incomplete.');
  const seen=new Set<string>();let milli=0;
  for(const source of line.site_log_sources){if(seen.has(source.site_log_id))throw conflict('Daily output was referenced twice.');seen.add(source.site_log_id);
   const log=await tx.constructionSiteLog.findFirst({where:{...scope(a),id:source.site_log_id,status:'approved',version:source.version,workDate:{lte:billDate}}});
   if(!log)throw conflict('A verified daily log changed. Submit a fresh measured bill.');
   const actual=workRows(log.content).filter(r=>r.contract_id===contractId).flatMap(r=>r.outputs).filter(o=>o.work_item_id===line.id).reduce((n,o)=>n+Math.round(o.quantity*1000),0);
   if(actual!==Math.round(source.quantity*1000))throw conflict('Daily output references changed.');milli+=actual;
  }
  if(milli!==Math.round(line.cumulative_quantity*1000))throw conflict('Bill quantities do not match their verified daily output.');
 }
}
