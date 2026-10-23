import type { Prisma } from '@prisma/client';
import type { requireProjectContext } from '../../core/security/auth.context.js';
import { badRequest, notFound } from '../../core/http/api-error.js';
import { dhakaToday } from '../expenses/expense-input.js';
type Auth=ReturnType<typeof requireProjectContext>;
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
/** Called inside the request-key claim transaction: expense, debit and audits commit together. */
export async function saveReviewedExpense(tx:Prisma.TransactionClient,a:Auth,f:Record<string,unknown>,supplier:{name:string}|null,proof?:string){
 const where={tenantId:a.tenantId,projectId:a.projectId},post=f.submission==='post',paid=post&&a.roles.some(role=>role==='owner'||role==='admin');
 if(post&&!f.account_id)throw badRequest('Choose the project account for this expense.');
 if(post&&String(f.invoice_date)>dhakaToday())throw badRequest('Expense date cannot be in the future.');
 if(f.category_def_id&&!await tx.expenseCategoryDef.findFirst({where:{...where,id:String(f.category_def_id)}}))throw notFound('Expense category not found in this project.');
 const amount=Number(f.total),accountId=f.account_id?String(f.account_id):undefined;
 let balanceAfter:number|undefined;
 if(paid){
  const debit=await tx.account.updateMany({where:{...where,id:accountId!,balance:{gte:amount}},data:{balance:{decrement:amount}}});
  if(debit.count!==1)throw badRequest('Source account has insufficient balance.');
  balanceAfter=(await tx.account.findFirstOrThrow({where:{...where,id:accountId!}})).balance;
 }
 const title=f.title?String(f.title):[f.payee_name||supplier?.name,f.invoice_number?`Receipt ${String(f.invoice_number)}`:String((f.lines as {description:string}[])[0]!.description)].filter(Boolean).join(' · ').slice(0,120);
 const status=paid?'paid':post?'pending':'draft';
 const expense=await tx.expense.create({data:{...where,title,amount,category:f.category as 'services',categoryDefId:f.category_def_id?String(f.category_def_id):undefined,vendorId:f.supplier_id?String(f.supplier_id):undefined,vendor:f.payee_name?String(f.payee_name):supplier?.name??undefined,expenseDate:new Date(`${f.invoice_date}T00:00:00Z`),accountId,docFileId:proof,status,createdById:a.userId,...(paid?{approvedById:a.userId,disbursedById:a.userId,paidAccountId:accountId,paidAt:new Date()}:{})}});
 if(post)await tx.activity.create({data:{...where,actorUserId:a.userId,action:paid?'expense.posted':'expense.submitted',entityType:'expense',entityId:expense.id,after:json(expense)}});
 if(paid){
  const entry=await tx.accountTransaction.create({data:{...where,accountId:accountId!,direction:'money_out',amount,referenceType:'expense',referenceId:expense.id,description:title,balanceAfter:balanceAfter!,createdById:a.userId}});
  await tx.activity.create({data:{...where,actorUserId:a.userId,action:'account_transaction.created',entityType:'account_transaction',entityId:entry.id,before:json({account_id:accountId,balance:balanceAfter!+amount}),after:json(entry)}});
 }
 return expense;
}
