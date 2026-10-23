import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { requireProjectContext } from '../../core/security/auth.context.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { lockSetup } from '../business-setup/service.js';
import { dhakaToday } from './expense-input.js';
type Auth=ReturnType<typeof requireProjectContext>;
type Submission={account_id:string;expected_updated_at:string;request_key:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
/** Mutate the saved draft itself; never create a second expense to pay a draft. */
export async function submitDraftExpense(tx:Prisma.TransactionClient,a:Auth,id:string,b:Submission){
 const scope={tenantId:a.tenantId,projectId:a.projectId},paid=a.roles.some(role=>role==='owner'||role==='admin');
 await lockSetup(tx,a);
 const requestHash=hash({id,account_id:b.account_id,expected_updated_at:b.expected_updated_at,paid});
 const recordId='expense-submit-'+hash([a.tenantId,a.projectId,a.userId,b.request_key]);
 const previous=await tx.activity.findFirst({where:{...scope,id:recordId,actorUserId:a.userId,entityType:'expense'}});
 if(previous){
  if((previous.before as {request_hash?:string})?.request_hash!==requestHash)throw conflict('This request key belongs to another expense submission.');
  return tx.expense.findFirstOrThrow({where:{...scope,id}});
 }
 const before=await tx.expense.findFirst({where:{...scope,id}});
 if(!before)throw notFound('Expense not found in this project.');
 if(!paid&&before.createdById!==a.userId)throw forbidden('Only the creator or an administrator can submit this expense draft.');
 if(before.status!=='draft')throw conflict('This expense is no longer a draft. Refresh its current payment or approval status.');
 if(before.updatedAt.toISOString()!==b.expected_updated_at)throw conflict('The expense changed. Reload its details before submitting.');
 if(before.expenseDate&&before.expenseDate.toISOString().slice(0,10)>dhakaToday())throw badRequest('Expense date cannot be in the future.');
 if(!Number.isSafeInteger(before.amount)||before.amount<=0)throw badRequest('The saved expense amount must be positive whole taka.');
 const account=await tx.account.findFirst({where:{...scope,id:b.account_id}});
 if(!account)throw notFound('Account not found in this project.');
 const claimed=await tx.expense.updateMany({where:{...scope,id,status:'draft',updatedAt:before.updatedAt},data:{accountId:account.id,status:paid?'paid':'pending',...(paid?{approvedById:a.userId,disbursedById:a.userId,paidAccountId:account.id,paidAt:new Date()}:{approvedById:null})}});
 if(claimed.count!==1)throw conflict('The expense changed or was already submitted. Refresh its status.');
 let balanceAfter:number|undefined;
 if(paid){
  const debit=await tx.account.updateMany({where:{...scope,id:account.id,balance:{gte:before.amount}},data:{balance:{decrement:before.amount}}});
  if(debit.count!==1)throw badRequest('Source account has insufficient balance.');
  balanceAfter=(await tx.account.findFirstOrThrow({where:{...scope,id:account.id}})).balance;
 }
 const expense=await tx.expense.findFirstOrThrow({where:{...scope,id}});
 await tx.activity.create({data:{...scope,id:recordId,actorUserId:a.userId,action:paid?'expense.posted':'expense.submitted',entityType:'expense',entityId:id,before:json({request_hash:requestHash,expense:before}),after:json(expense)}});
 if(paid){
  const entry=await tx.accountTransaction.create({data:{...scope,accountId:account.id,direction:'money_out',amount:before.amount,referenceType:'expense',referenceId:id,description:before.title,balanceAfter:balanceAfter!,createdById:a.userId}});
  await tx.activity.create({data:{...scope,actorUserId:a.userId,action:'account_transaction.created',entityType:'account_transaction',entityId:entry.id,before:json({account_id:account.id,balance:balanceAfter!+before.amount}),after:json(entry)}});
 }
 return expense;
}
