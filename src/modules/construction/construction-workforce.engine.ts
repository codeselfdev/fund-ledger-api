import {z} from 'zod';
import {id} from '../billing/billing.policy.js';
const text=z.string().trim().min(2).max(150);
const outputQuantity=z.number().positive().max(100000000).refine(n=>Math.abs(n*1000-Math.round(n*1000))<0.00001,'Use up to 3 quantity decimal places');
export const contractorWorkSchema=z.object({
 id:z.string().uuid(),contract_id:id,task_id:id.optional(),location_id:id.optional(),
 crew:z.array(z.object({trade:text,workers:z.number().int().min(1).max(10000)}).strict()).min(1).max(20),
 outputs:z.array(z.object({work_item_id:z.string().uuid(),quantity:outputQuantity}).strict()).max(100).default([]),
 note:z.string().trim().max(2000).default(''),delay_reason:z.string().trim().max(1000).default(''),
}).strict().refine(row=>new Set(row.outputs.map(o=>o.work_item_id)).size===row.outputs.length,'Record each work item once per crew card');
export type ContractorWork=z.infer<typeof contractorWorkSchema>;
export type WorkLog={id:string;version:number;workDate:Date;status:string;content:unknown};
export type SiteSource={site_log_id:string;version:number;quantity:number};
export type TrackedContract={id:string;workItems:unknown;workTerms:unknown};
export const workRows=(content:unknown):ContractorWork[]=>z.array(contractorWorkSchema).parse((content as {contractor_work?:unknown})?.contractor_work??[]);
export function verifiedOutput(contractId:string,logs:WorkLog[],through:string){
 const totals:Record<string,number>=Object.create(null),sources:Record<string,SiteSource[]>=Object.create(null);
 for(const log of logs){if(log.status!=='approved'||log.workDate.toISOString().slice(0,10)>through)continue;
  const daily:Record<string,number>=Object.create(null);
  for(const row of workRows(log.content).filter(row=>row.contract_id===contractId))for(const output of row.outputs)daily[output.work_item_id]=(daily[output.work_item_id]??0)+Math.round(output.quantity*1000);
  for(const [item,milli] of Object.entries(daily)){totals[item]=(totals[item]??0)+milli;(sources[item]??=[]).push({site_log_id:log.id,version:log.version,quantity:milli/1000});}
 }
 return {quantities:Object.fromEntries(Object.entries(totals).map(([id,milli])=>[id,milli/1000])),sources};
}
export function workforceSummary(contract:TrackedContract,logs:WorkLog[],through:string){
 const verified=verifiedOutput(contract.id,logs,through),items=(contract.workItems??[]) as {id:string;name:string;unit:string;quantity:number;rate:number}[];
 const reported:Record<string,number>=Object.create(null);let workersToday=0,workerDays=0;const verifiedDays=new Map<string,Record<string,number>>();
 for(const log of logs){const day=log.workDate.toISOString().slice(0,10);if(day>through||!['approved','pending'].includes(log.status))continue;
  for(const row of workRows(log.content).filter(row=>row.contract_id===contract.id)){
   const workers=row.crew.reduce((n,c)=>n+c.workers,0);workerDays+=workers;if(day===through)workersToday+=workers;
   for(const output of row.outputs)reported[output.work_item_id]=(reported[output.work_item_id]??0)+Math.round(output.quantity*1000);
   if(log.status==='approved'){const daily=verifiedDays.get(day)??{};for(const output of row.outputs)daily[output.work_item_id]=(daily[output.work_item_id]??0)+Math.round(output.quantity*1000);verifiedDays.set(day,daily);}
  }
 }
 const value=items.reduce((n,i)=>n+i.quantity*i.rate,0),done=items.reduce((n,i)=>n+Math.min(i.quantity,verified.quantities[i.id]??0)*i.rate,0),percent=value>0?Math.round(done/value*10000)/100:null;
 const terms=(contract.workTerms??{}) as {start_date?:string;end_date?:string},dayMs=86400000,daysLeft=terms.end_date?Math.round((Date.parse(terms.end_date)-Date.parse(through))/dayMs):null;
 const recent=[...verifiedDays.keys()].filter(day=>day>=new Date(Date.parse(through)-13*dayMs).toISOString().slice(0,10)).sort();
 let forecastFinish:string|null=null;
 if(recent.length>=2&&items.length){
  const elapsed=Math.round((Date.parse(through)-Date.parse(recent[0]))/dayMs)+1;let remainingDays=0,available=true;
  for(const item of items){const remaining=Math.max(0,Math.round((item.quantity-(verified.quantities[item.id]??0))*1000));if(!remaining)continue;const produced=recent.reduce((n,day)=>n+(verifiedDays.get(day)?.[item.id]??0),0);if(!produced){available=false;break;}remainingDays=Math.max(remainingDays,Math.ceil(remaining/(produced/elapsed)));}
  if(available&&remainingDays<=36500)forecastFinish=new Date(Date.parse(through)+remainingDays*dayMs).toISOString().slice(0,10);
 }
 const status=percent!==null&&percent>=100?'complete':daysLeft!==null&&daysLeft<0?'overdue':forecastFinish&&terms.end_date?(forecastFinish>terms.end_date?'at_risk':'on_track'):'insufficient_data';
 return {contract_id:contract.id,workers_today:workersToday,worker_days:workerDays,verified_percent:percent,days_left:daysLeft,forecast_finish:forecastFinish,schedule_status:status,
  items:items.map(item=>({...item,reported_quantity:(reported[item.id]??0)/1000,verified_quantity:verified.quantities[item.id]??0})),verified_quantities:verified.quantities};
}
