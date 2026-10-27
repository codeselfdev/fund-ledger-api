import type {Prisma} from '@prisma/client';
import {badRequest,conflict,notFound} from '../../core/http/api-error.js';
import {atDate,hash,json} from '../billing/billing.policy.js';
import {audit,head,scope,type ConstructionScope} from './construction.service.js';
import {evidence,retryRow} from './construction.workflow.shared.js';
import {moneyFromMicro} from './construction.control.engine.js';
import {measuredContractSchema,measuredBillSchema,agreementTotal,measureWork,measuredTotals,type WorkItem} from './construction-contractor.engine.js';
type Tx=Prisma.TransactionClient;type A=ConstructionScope;
export async function submitWorkContract(tx:Tx,a:A,raw:unknown){
 const b=measuredContractSchema.parse(raw),old=retryRow(await tx.constructionContract.findFirst({where:{...scope(a),requestKey:b.request_key}}),a,b);if(old)return old;
 await head(tx,a,b.cost_head_id);if(!await tx.constructionContractor.findFirst({where:{...scope(a),id:b.contractor_id,isActive:true}}))throw notFound('Active contractor not found.');await evidence(tx,a,b.file_ids);
 const amount=agreementTotal(b.items),row=await tx.constructionContract.create({data:{...scope(a),contractorId:b.contractor_id,costHeadId:b.cost_head_id,title:b.title,amount,revisedAmount:amount,retentionBps:b.retention_bps,billingMode:'item_rate',workTerms:json({trade:b.trade,supply_mode:b.supply_mode,scope_note:b.scope_note,start_date:b.start_date,end_date:b.end_date}),workItems:json(b.items),certifiedQuantities:{},agreementFileIds:b.file_ids,status:'pending',requestKey:b.request_key,requestHash:hash(b),createdById:a.userId}});
 await audit(tx,a,'work_contract.submitted','construction_contract',row.id,row);return row;
}
export async function decideWorkContract(tx:Tx,a:A,id:string,decision:'approve'|'reject'){
 const row=await tx.constructionContract.findFirst({where:{...scope(a),id,billingMode:'item_rate'}});if(!row)throw notFound('Measured work contract not found.');if(row.createdById===a.userId)throw conflict('A different administrator or approver must review the work agreement.');const status=decision==='approve'?'active':'rejected';
 if(row.decidedById&&row.status===status)return row;if(row.status!=='pending')throw conflict('This agreement has already been reviewed.');
 if(decision==='approve'){await head(tx,a,row.costHeadId);if(!await tx.constructionContractor.findFirst({where:{...scope(a),id:row.contractorId,isActive:true}}))throw notFound('Active contractor not found.');await evidence(tx,a,row.agreementFileIds);if(agreementTotal(row.workItems as unknown as WorkItem[])!==row.revisedAmount)throw conflict('The agreed work schedule changed.');}
 const saved=await tx.constructionContract.update({where:{id},data:{status,decidedById:a.userId,decidedAt:new Date()}});await audit(tx,a,`work_contract.${decision==='approve'?'approved':'rejected'}`,'construction_contract',id,saved);return saved;
}
export async function submitMeasuredBill(tx:Tx,a:A,raw:unknown){
 const b=measuredBillSchema.parse(raw),old=retryRow(await tx.constructionRunningBill.findFirst({where:{...scope(a),requestKey:b.request_key}}),a,b);if(old)return old;
 const c=await tx.constructionContract.findFirst({where:{...scope(a),id:b.contract_id,status:'active',billingMode:'item_rate'}});if(!c)throw notFound('Approved active item-rate contract not found.');await head(tx,a,c.costHeadId);await evidence(tx,a,b.file_ids);
 if(await tx.constructionRunningBill.findFirst({where:{...scope(a),contractId:c.id,status:'pending'}}))throw conflict('Review the pending bill for this contract before submitting another.');
 const m=measureWork(c.workItems as unknown as WorkItem[],(c.certifiedQuantities??{}) as Record<string,number>,b.quantities);if(m.previousAmount!==c.certifiedAmount)throw conflict('The contract quantities and certified amount do not reconcile.');
 const totals=measuredTotals(c,m.cumulative,b.advance_recovery),wasteIds=[...new Set(b.waste_entry_ids)],waste=await tx.constructionMaterialEntry.findMany({where:{...scope(a),id:{in:wasteIds},kind:'waste',chargeContractId:c.id,chargeBillId:null}});
 if(waste.length!==wasteIds.length)throw conflict('Wastage was already assigned or belongs to another contract.');
 const deduction=waste.reduce((n,e)=>n+(e.valuationValueMicro!==null&&e.valuationValueMicro!==undefined?Math.round(Math.abs(moneyFromMicro(BigInt(String(e.valuationValueMicro))))):e.quantity*(e.unitRate??0)),0);if(deduction>totals.netPayable)throw badRequest('Wastage deductions exceed the current payable.');totals.netPayable-=deduction;
 const row=await tx.constructionRunningBill.create({data:{...scope(a),contractId:c.id,cumulativeCertified:m.cumulative,...totals,measurementLines:json(m.lines),evidenceFileIds:b.file_ids,wastageDeduction:deduction,wasteEntryIds:wasteIds,billDate:atDate(b.bill_date),note:b.note,requestKey:b.request_key,requestHash:hash(b),createdById:a.userId}});
 await tx.constructionMaterialEntry.updateMany({where:{...scope(a),id:{in:wasteIds},chargeBillId:null},data:{chargeBillId:row.id}});await audit(tx,a,'measured_bill.submitted','construction_running_bill',row.id,row);return row;
}
