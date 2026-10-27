import type {Prisma} from '@prisma/client';
import {badRequest,conflict,notFound} from '../../core/http/api-error.js';
import {scope,type BillingScope} from '../billing/billing.service.js';
import {hash,json} from '../billing/billing.policy.js';
import {micro,moneyFromMicro,proportional} from './construction.control.engine.js';
type Tx=Prisma.TransactionClient;
type Scope={tenantId:string;projectId:string;userId?:string};
const scoped=(a:Scope)=>({tenantId:a.tenantId,projectId:a.projectId});
const value=(row:{valueMicro:unknown})=>BigInt(String(row.valueMicro));
export async function valuationMethod(tx:Tx,a:Scope){return (await tx.project.findFirst({where:{id:a.projectId,tenantId:a.tenantId}}))?.constructionValuationMethod??'expense';}
export async function capitalizeSupplierBill(tx:Tx,a:Scope,bill:{id:string;purchaseId:string|null;costHeadId:string}){
 if(!bill.purchaseId||await valuationMethod(tx,a)==='expense')return;
 const old=await tx.constructionReclassification.findFirst({where:{...scoped(a),sourceType:'supplier_bill',sourceId:bill.id}});if(old)return;
 const purchase=await tx.purchase.findFirst({where:{...scoped(a),id:bill.purchaseId},include:{lines:true}});if(!purchase)throw notFound('Linked purchase not found for inventory capitalization.');
 const amount=purchase.lines.reduce((n,l)=>n+BigInt(l.quantity)*micro(l.unitCost),0n);
 await tx.constructionReclassification.create({data:{...scoped(a),sourceType:'supplier_bill',sourceId:bill.id,costHeadId:bill.costHeadId,valueMicro:amount.toString(),createdById:a.userId!}});
}
export type ValuedMovement={id:string;itemId:string;locationId:string|null;quantity:number;referenceType:string|null;referenceId:string|null;createdAt:Date};
export async function recordStockValue(tx:Tx,a:Scope,movement:ValuedMovement,input:{unitCost?:number;costHeadId?:string|null;sourceReferenceId?:string;sourceReferenceType?:string;restoring?:boolean}){
 const method=await valuationMethod(tx,a);if(method==='expense')return null;if(!movement.locationId)throw badRequest('Valued stock needs a store location.');
 const base={...scoped(a),itemId:movement.itemId,locationId:movement.locationId};
 const retry=await tx.constructionValuationEntry.findFirst({where:{...scoped(a),movementId:movement.id}});if(retry)return {valueMicro:String(retry.valueMicro),journalId:retry.id};
 let costHeadId=input.costHeadId??null;const quantity=movement.quantity;
 const ref=movement.referenceType??'adjustment';
 const isWork=ref==='construction_consume'||ref==='construction_waste';
 if(isWork&&!costHeadId)throw badRequest('Choose a material cost head or BOQ item before consuming valued stock.');
 if(costHeadId&&!await tx.constructionCostHead.findFirst({where:{...scoped(a),id:costHeadId,status:'approved'}}))throw notFound('Approved material cost head not found.');
 let amount=0n,kind=quantity>0?'receipt':ref==='construction_consume'?'wip':ref==='construction_waste'?'waste':'out';
 let sourceEntryId:string|null=null;let allocations:{quantity:number;value_micro:string;sort_at:string}[]=[];
 if(quantity<0){
  const layers=await tx.constructionValuationLayer.findMany({where:{...base,remainingQuantity:{gt:0}},orderBy:[{sortAt:'asc'},{id:'asc'}]});
  const total=layers.reduce((n,l)=>n+l.remainingQuantity,0),needed=-quantity;if(total<needed)throw conflict('Valuation stock is insufficient. Reconcile the stock ledger before posting.');
  if(method==='weighted_average'){
   const pool=layers.reduce((n,l)=>n+value(l),0n);amount=proportional(pool,needed,total);
   // Weighted-average keeps one pool per store/item, including all return values.
   let remaining=needed,removed=0n;
   for(const layer of layers){const take=Math.min(remaining,layer.remainingQuantity);if(!take)continue;const layerValue=proportional(value(layer),take,layer.remainingQuantity);removed+=layerValue;remaining-=take;await tx.constructionValuationLayer.update({where:{id:layer.id},data:{remainingQuantity:layer.remainingQuantity-take,valueMicro:(value(layer)-layerValue).toString()}});}
   // Pool rounding and physical layer removal are reconciled on the remaining layer.
   const delta=removed-amount;if(delta){const target=await tx.constructionValuationLayer.findFirst({where:{...base,remainingQuantity:{gt:0}},orderBy:{sortAt:'asc'}});if(!target)throw conflict('Valuation rounding could not be reconciled.');await tx.constructionValuationLayer.update({where:{id:target.id},data:{valueMicro:(value(target)+delta).toString()}});}
   allocations=[{quantity:needed,value_micro:amount.toString(),sort_at:movement.createdAt.toISOString()}];
  }else{
   let remaining=needed;
   for(const layer of layers){const take=Math.min(remaining,layer.remainingQuantity);if(!take)break;const used=proportional(value(layer),take,layer.remainingQuantity);amount+=used;remaining-=take;allocations.push({quantity:take,value_micro:used.toString(),sort_at:layer.sortAt.toISOString()});await tx.constructionValuationLayer.update({where:{id:layer.id},data:{remainingQuantity:layer.remainingQuantity-take,valueMicro:(value(layer)-used).toString()}});}
  }
  amount=-amount;
 }else{
  let source=null;
  if(input.sourceReferenceId){source=await tx.constructionValuationEntry.findFirst({where:{...scoped(a),itemId:movement.itemId,referenceId:input.sourceReferenceId,referenceType:input.sourceReferenceType??'construction_consume',quantity:{lt:0}}});if(!source)throw notFound('Original valued stock movement not found.');}
  else if(['sale','sale_cancel','business_sale'].includes(ref)&&movement.referenceId)source=await tx.constructionValuationEntry.findFirst({where:{...scoped(a),itemId:movement.itemId,referenceId:movement.referenceId,referenceType:ref==='sale_cancel'?'sale':ref,quantity:{lt:0}}});
  if(input.restoring&&!source)throw conflict('The original movement predates material valuation. Reconcile this return before restoring stock.');
  if(source){
   if(source.locationId!==movement.locationId)throw badRequest('Restore valued stock to its original store.');
   const returns=await tx.constructionValuationEntry.findMany({where:{...scoped(a),sourceEntryId:source.id}});let skip=returns.reduce((n,r)=>n+r.quantity,0),remaining=quantity;
   if(skip+quantity>-source.quantity)throw conflict('Return exceeds the original valued movement.');
   const original=source.allocations as unknown as typeof allocations;
   for(const allocation of original){const ignored=Math.min(skip,allocation.quantity);skip-=ignored;const available=allocation.quantity-ignored,take=Math.min(remaining,available);if(!take)continue;
    const totalValue=BigInt(allocation.value_micro),restored=proportional(totalValue,ignored+take,allocation.quantity)-proportional(totalValue,ignored,allocation.quantity);
    allocations.push({quantity:take,value_micro:restored.toString(),sort_at:allocation.sort_at});amount+=restored;remaining-=take;
   }
   if(remaining)throw conflict('Original valuation allocation is incomplete.');sourceEntryId=source.id;costHeadId=source.costHeadId;kind='return';
  }else{const item=await tx.inventoryItem.findFirst({where:{...scoped(a),id:movement.itemId}});if(!item)throw notFound('Valued material not found.');amount=BigInt(quantity)*micro(input.unitCost??item.costPrice);allocations=[{quantity,value_micro:amount.toString(),sort_at:movement.createdAt.toISOString()}];}
  for(const allocation of allocations){
   if(method==='weighted_average'){
    const pool=await tx.constructionValuationLayer.findFirst({where:base,orderBy:{sortAt:'asc'}});
    if(pool)await tx.constructionValuationLayer.update({where:{id:pool.id},data:{remainingQuantity:pool.remainingQuantity+allocation.quantity,valueMicro:(value(pool)+BigInt(allocation.value_micro)).toString()}});
    else await tx.constructionValuationLayer.create({data:{...base,remainingQuantity:allocation.quantity,valueMicro:allocation.value_micro,sortAt:new Date(allocation.sort_at)}});
   }else await tx.constructionValuationLayer.create({data:{...base,remainingQuantity:allocation.quantity,valueMicro:allocation.value_micro,sortAt:new Date(allocation.sort_at)}});
  }
 }
 const journal=await tx.constructionValuationEntry.create({data:{...base,movementId:movement.id,kind,costHeadId,quantity,valueMicro:amount.toString(),sourceEntryId,referenceType:ref,referenceId:movement.referenceId,allocations:json(allocations),createdById:a.userId!}});
 if(ref==='purchase'&&quantity>0&&movement.referenceId){
  const old=await tx.constructionReclassification.findFirst({where:{...scoped(a),sourceType:'purchase_item',sourceId:`${movement.referenceId}:${movement.itemId}`}});
  if(old)await tx.constructionReclassification.update({where:{id:old.id},data:{valueMicro:(value(old)+amount).toString()}});
  else await tx.constructionReclassification.create({data:{...scoped(a),sourceType:'purchase_item',sourceId:`${movement.referenceId}:${movement.itemId}`,costHeadId:null,valueMicro:amount.toString(),createdById:a.userId!}});
 }
 return {valueMicro:amount.toString(),journalId:journal.id};
}
export async function valuationAdjustments(tx:Tx,a:Scope){
 const method=await valuationMethod(tx,a);if(method==='expense')return {method,credits:new Map<string,bigint>(),work:new Map<string,bigint>(),inventory:0n,wip:0n,loss:0n,transit:0n};
 const [entries,reclass,layers,bills]=await Promise.all([tx.constructionValuationEntry.findMany({where:scoped(a)}),tx.constructionReclassification.findMany({where:scoped(a)}),tx.constructionValuationLayer.findMany({where:scoped(a)}),tx.constructionSupplierBill.findMany({where:{...scoped(a),status:'approved',receivedAt:null}})]);
 const credits=new Map<string,bigint>(),work=new Map<string,bigint>();let wip=0n,loss=0n,transit=0n;
 for(const r of reclass){const key=r.costHeadId??'';credits.set(key,(credits.get(key)??0n)+value(r));if(r.sourceType==='supplier_bill'&&bills.some(b=>b.id===r.sourceId))transit+=value(r);}
 for(const e of entries)if(!['opening','receipt'].includes(e.kind)){
  const amount=-value(e),key=e.costHeadId??'';work.set(key,(work.get(key)??0n)+amount);
  let origin=e.kind;if(e.kind==='return')origin=entries.find(x=>x.id===e.sourceEntryId)?.kind??'out';if(origin==='wip')wip+=amount;else loss+=amount;
 }
 return {method,credits,work,inventory:layers.reduce((n,l)=>n+value(l),0n),wip,loss,transit};
}
export async function openingPreview(tx:Tx,a:BillingScope){
 const [items,locations,movements,heads,allocations,suppliers,expenses,purchases]=await Promise.all([
  tx.inventoryItem.findMany({where:scope(a)}),tx.inventoryLocation.findMany({where:scope(a)}),tx.stockMovement.findMany({where:scope(a)}),tx.constructionCostHead.findMany({where:{...scope(a),status:'approved'}}),tx.constructionCostAllocation.findMany({where:scope(a)}),tx.constructionSupplierBill.findMany({where:{...scope(a),status:'approved'}}),tx.expense.findMany({where:{...scope(a),status:{in:['approved','paid']}}}),tx.purchase.findMany({where:scope(a),include:{lines:true}}),
 ]);
 const main=locations.find(l=>l.isDefault);const balances:{item_id:string;item_name:string;unit:string;location_id:string;location_name:string;quantity:number;unit_cost:number;cost_head_id:string|null}[]=[];
 for(const item of items){let others=0;for(const location of locations.filter(l=>!l.isDefault)){const quantity=movements.filter(m=>m.itemId===item.id&&m.locationId===location.id).reduce((n,m)=>n+m.quantity,0);others+=quantity;if(quantity<0)throw conflict('Reconcile negative store balances before activating valuation.');if(quantity)balances.push({item_id:item.id,item_name:item.name,unit:item.unit,location_id:location.id,location_name:location.name,quantity,unit_cost:item.costPrice,cost_head_id:null});}
  const quantity=item.quantity-others;if(quantity<0)throw conflict('Reconcile negative main-store balances before activating valuation.');if(quantity){if(!main)throw conflict('Initialize the main inventory store before activating valuation.');balances.push({item_id:item.id,item_name:item.name,unit:item.unit,location_id:main.id,location_name:main.name,quantity,unit_cost:item.costPrice,cost_head_id:null});}
 }
 const transit=suppliers.filter(b=>b.purchaseId&&!b.receivedAt).map(b=>({id:b.id,cost_head_id:b.costHeadId,value:purchases.find(p=>p.id===b.purchaseId)?.lines.reduce((n,l)=>n+l.quantity*l.unitCost,0)??0}));
 const sources=heads.map(h=>({id:h.id,name:`${h.phase} · ${h.name}`,available:allocations.filter(r=>r.costHeadId===h.id&&expenses.some(e=>e.id===r.expenseId)).reduce((n,r)=>n+r.amount,0)+suppliers.filter(b=>b.costHeadId===h.id).reduce((n,b)=>n+b.amount,0)-transit.filter(t=>t.cost_head_id===h.id).reduce((n,t)=>n+t.value,0)}));
 const unallocated=expenses.reduce((n,e)=>n+e.amount,0)-allocations.filter(r=>expenses.some(e=>e.id===r.expenseId)).reduce((n,r)=>n+r.amount,0)+purchases.filter(p=>!p.constructionManaged&&p.status==='received'&&!suppliers.some(b=>b.purchaseId===p.id)).reduce((n,p)=>n+p.totalAmount,0);
 sources.push({id:'',name:'Previously recorded unallocated costs',available:unallocated});
 balances.sort((a,b)=>`${a.item_id}:${a.location_id}`.localeCompare(`${b.item_id}:${b.location_id}`));sources.sort((a,b)=>a.id.localeCompare(b.id));transit.sort((a,b)=>a.id.localeCompare(b.id));
 return {balances,sources,transit,preview_hash:hash({balances:balances.map(({item_id,location_id,quantity})=>({item_id,location_id,quantity})),sources,transit})};
}
export async function activateValuation(tx:Tx,a:BillingScope,b:{method:string;revision:number;request_key:string;preview_hash:string;opening:{item_id:string;location_id:string;quantity:number;unit_cost:number;cost_head_id:string|null}[]}){
 const project=await tx.project.findFirst({where:{id:a.projectId,tenantId:a.tenantId}});if(!project||project.stockManagementEnabled===false)throw badRequest('Enable inventory stock management before material valuation.');
 const setting=await tx.constructionControlSetting.findFirst({where:scope(a)}),activation=setting?.valuationActivation as {request_key:string;request_hash:string;actor:string}|null;
 if(activation?.request_key===b.request_key){if(activation.actor!==a.userId||activation.request_hash!==hash(b))throw conflict('Activation request key already used.');return;}
 if((project.constructionValuationMethod??'expense')!=='expense')throw conflict('The valuation method is locked after activation.');if((setting?.revision??0)!==b.revision)throw conflict('Setup changed. Reload the opening-stock review.');
 const {procurementAccruals}=await import('./construction.procurement.service.js');if((await procurementAccruals(tx,a)).total_unbilled>0)throw conflict('Approve the received material invoices before activating valuation so opening source costs reconcile.');
 const preview=await openingPreview(tx,a);if(preview.preview_hash!==b.preview_hash)throw conflict('Stock or source costs changed. Reload the opening-stock review.');
 if(b.opening.length!==preview.balances.length)throw badRequest('Review every existing item/store balance.');
 const seen=new Set<string>(),totals=new Map<string,bigint>();
 for(const row of b.opening){const key=`${row.item_id}:${row.location_id}`;if(seen.has(key))throw badRequest('Opening stock rows must be unique.');seen.add(key);
  if(!preview.balances.some(p=>p.item_id===row.item_id&&p.location_id===row.location_id&&p.quantity===row.quantity))throw conflict('Opening stock quantity changed.');const amount=BigInt(row.quantity)*micro(row.unit_cost),head=row.cost_head_id??'';
  if(!preview.sources.some(s=>s.id===head))throw badRequest('Choose the previously recorded source cost for each opening stock row.');totals.set(head,(totals.get(head)??0n)+amount);
 }
 for(const [id,amount]of totals){if(amount>micro(preview.sources.find(s=>s.id===id)!.available))throw badRequest('Opening stock value exceeds the selected previously recorded cost. Reconcile the original costs first.');}
 // Keep opening BOQ credits fixed at activation; future invoices must not
 // redistribute historical opening inventory across work items.
 const [openingAllocations,openingExpenses,openingBills]=await Promise.all([tx.constructionCostAllocation.findMany({where:scope(a)}),tx.expense.findMany({where:{...scope(a),status:{in:['approved','paid']}}}),tx.constructionSupplierBill.findMany({where:{...scope(a),status:'approved'}})]);
 const openingBoqCredits:Record<string,string>={};
 for(const [headId,amount]of totals){if(!headId)continue;const source=micro(preview.sources.find(s=>s.id===headId)!.available);if(!source)continue;const weights=new Map<string,bigint>();
  for(const allocation of openingAllocations.filter(x=>x.costHeadId===headId&&x.boqId&&openingExpenses.some(e=>e.id===x.expenseId)))weights.set(allocation.boqId!,(weights.get(allocation.boqId!)??0n)+micro(allocation.amount));
  for(const bill of openingBills.filter(x=>x.costHeadId===headId&&x.boqId)){const credited=preview.transit.find(t=>t.id===bill.id)?.value??0;weights.set(bill.boqId!,(weights.get(bill.boqId!)??0n)+micro(bill.amount-credited));}
  for(const [boqId,weight]of weights)openingBoqCredits[boqId]=(amount*weight/source).toString();
 }
 for(const row of b.opening){const amount=BigInt(row.quantity)*micro(row.unit_cost);await tx.constructionValuationLayer.create({data:{...scope(a),itemId:row.item_id,locationId:row.location_id,remainingQuantity:row.quantity,valueMicro:amount.toString()}});
  await tx.constructionValuationEntry.create({data:{...scope(a),itemId:row.item_id,locationId:row.location_id,costHeadId:row.cost_head_id,kind:'opening',quantity:row.quantity,valueMicro:amount.toString(),referenceType:'opening_reclassification',referenceId:b.request_key,allocations:[],createdById:a.userId}});
  await tx.constructionReclassification.create({data:{...scope(a),sourceType:'opening',sourceId:`${row.item_id}:${row.location_id}`,costHeadId:row.cost_head_id,valueMicro:amount.toString(),createdById:a.userId}});
 }
 await tx.project.update({where:{id:a.projectId},data:{constructionValuationMethod:b.method}});
 for(const bill of preview.transit){const row=await tx.constructionSupplierBill.findFirstOrThrow({where:{...scope(a),id:bill.id}});await capitalizeSupplierBill(tx,a,row);}
 const data={valuationActivation:json({request_key:b.request_key,request_hash:hash(b),actor:a.userId,opening_boq_credits:openingBoqCredits,unallocated_source_expense_ids:(totals.get('')??0n)>0n?openingExpenses.map(e=>e.id):[]}),revision:(setting?.revision??0)+1};
 if(setting)await tx.constructionControlSetting.update({where:{projectId:a.projectId},data});else await tx.constructionControlSetting.create({data:{...scope(a),...data,config:{scheduling:false,progress:false,advanced_boq:false,calendar:{weekdays:[0,1,2,3,4,5,6],holidays:[]}}}});
}
export async function valuationSnapshot(tx:Tx,a:BillingScope){
 const adjustments=await valuationAdjustments(tx,a),entries=await tx.constructionValuationEntry.findMany({where:scope(a),orderBy:{createdAt:'desc'},take:250}),items=await tx.inventoryItem.findMany({where:scope(a)});
 return {method:adjustments.method,inventory_value:moneyFromMicro(adjustments.inventory),wip_value:moneyFromMicro(adjustments.wip),loss_value:moneyFromMicro(adjustments.loss),in_transit_value:moneyFromMicro(adjustments.transit),entries:entries.map(e=>({...e,value:moneyFromMicro(value(e)),valueMicro:String(e.valueMicro),item_name:items.find(i=>i.id===e.itemId)?.name??e.itemId})),opening:adjustments.method==='expense'?await openingPreview(tx,a):null};
}
