import {z} from 'zod';
import {badRequest,conflict} from '../../core/http/api-error.js';
import {id,money,requestKey,dateSchema,pastDateSchema,checkedMoney} from '../billing/billing.policy.js';

const precision=(n:number,scale:number)=>Number.isFinite(n)&&Math.abs(n*scale-Math.round(n*scale))<0.00001;
const qty=z.number().min(0).max(100000000).refine(n=>precision(n,1000),'Use up to 3 quantity decimal places');
const rate=z.number().positive().max(2147483647).refine(n=>precision(n,100),'Use up to 2 rate decimal places');
export const workItemSchema=z.object({id:z.string().uuid(),name:z.string().trim().min(2).max(150),unit:z.string().trim().min(1).max(30),quantity:qty.refine(n=>n>0),rate}).strict();
const files=z.array(id).max(20).default([]);
export const measuredContractSchema=z.object({contractor_id:id,cost_head_id:id,title:z.string().trim().min(2).max(150),trade:z.string().trim().min(2).max(100),supply_mode:z.enum(['labour_only','labour_and_materials']),scope_note:z.string().trim().min(5).max(2000),start_date:dateSchema.optional(),end_date:dateSchema.optional(),items:z.array(workItemSchema).min(1).max(100),retention_bps:z.number().int().min(0).max(10000).default(500),file_ids:files,request_key:requestKey}).strict().refine(b=>!b.start_date||!b.end_date||b.end_date>=b.start_date,'End date must follow start date');
export const measuredBillSchema=z.object({contract_id:id,quantities:z.array(z.object({item_id:z.string().uuid(),cumulative_quantity:qty}).strict()).min(1).max(100),advance_recovery:money.default(0),waste_entry_ids:z.array(id).max(100).default([]),bill_date:pastDateSchema,note:z.string().trim().min(5).max(2000),file_ids:files,request_key:requestKey}).strict();
export type WorkItem=z.infer<typeof workItemSchema>;
export type MeasuredLine=WorkItem&{previous_quantity:number;cumulative_quantity:number;current_quantity:number;previous_amount:number;cumulative_amount:number;current_amount:number};

// Round each item's cumulative value once, in the app's existing whole-currency ledger.
// Fixed-point integer arithmetic prevents quantity/rate floating-point drift across bills.
export function workValue(quantity:number,rate:number){return checkedMoney(Number((BigInt(Math.round(quantity*1000))*BigInt(Math.round(rate*100))+50000n)/100000n));}
export function agreementTotal(items:WorkItem[]){
 if(new Set(items.map(i=>i.id)).size!==items.length)throw badRequest('Do not repeat a work-item identifier.');
 let total=0;for(const item of items){const value=workValue(item.quantity,item.rate);if(value<=0)throw badRequest('Each agreed work item must have a positive whole-currency value.');total=checkedMoney(total+value);}return total;
}
export function measureWork(items:WorkItem[],previous:Record<string,number>,quantities:{item_id:string;cumulative_quantity:number}[]){
 if(quantities.length!==items.length||new Set(quantities.map(q=>q.item_id)).size!==items.length||quantities.some(q=>!items.some(i=>i.id===q.item_id)))throw badRequest('Include every agreed work item exactly once.');
 const next:Record<string,number>={},lines:MeasuredLine[]=[];let cumulative=0,previousAmount=0,progress=false;
 for(const item of items){const before=previous[item.id]??0,after=quantities.find(q=>q.item_id===item.id)!.cumulative_quantity;
  if(!precision(after,1000)||after<before||after>item.quantity)throw badRequest(`Completed quantity for ${item.name} must be between ${before} and ${item.quantity}.`);
  const prev=workValue(before,item.rate),value=workValue(after,item.rate);next[item.id]=after;progress ||= after>before;cumulative=checkedMoney(cumulative+value);previousAmount=checkedMoney(previousAmount+prev);
  lines.push({...item,previous_quantity:before,cumulative_quantity:after,current_quantity:(Math.round(after*1000)-Math.round(before*1000))/1000,previous_amount:prev,cumulative_amount:value,current_amount:value-prev});
 }
 if(!progress)throw badRequest('Enter additional completed work for at least one item.');return {lines,next,cumulative,previousAmount};
}
type FinancialContract={certifiedAmount:number;revisedAmount:number;retentionBps:number;advancePaid:number;advanceRecovered:number;retentionHeld:number};
export function measuredTotals(c:FinancialContract,cumulative:number,recovery:number){
 if(cumulative<c.certifiedAmount||cumulative>c.revisedAmount)throw badRequest('Certified work is outside the agreed contract value.');
 if(recovery>c.advancePaid-c.advanceRecovered)throw badRequest('Advance recovery exceeds the outstanding advance.');
 const current=cumulative-c.certifiedAmount,retention=Math.round(cumulative*c.retentionBps/10000)-c.retentionHeld;
 if(current===0&&recovery)throw badRequest('A quantity-only completion cannot recover an advance.');
 return {previousCertified:c.certifiedAmount,currentCertified:current,retention:checkedMoney(retention),advanceRecovery:recovery,netPayable:checkedMoney(current-retention-recovery)};
}
export function verifyMeasuredBill(c:FinancialContract&{workItems:unknown;certifiedQuantities:unknown},b:{measurementLines:unknown;cumulativeCertified:number;previousCertified:number}){
 if(!Array.isArray(c.workItems)||!Array.isArray(b.measurementLines))throw conflict('Use measured billing for this item-rate contract.');
 const saved=b.measurementLines as MeasuredLine[],previous=(c.certifiedQuantities??{}) as Record<string,number>;
 if(saved.some(l=>l.previous_quantity!==(previous[l.id]??0)))throw conflict('Certified quantities changed. Submit fresh measurements.');
 const m=measureWork(c.workItems as WorkItem[],previous,saved.map(l=>({item_id:l.id,cumulative_quantity:l.cumulative_quantity})));
 if(m.previousAmount!==c.certifiedAmount||m.previousAmount!==b.previousCertified||m.cumulative!==b.cumulativeCertified||m.lines.some((l,i)=>Object.entries(l).some(([key,value])=>value!==saved[i][key as keyof MeasuredLine])))throw conflict('Certified quantities changed. Reject this bill and submit fresh measurements.');return m;
}
