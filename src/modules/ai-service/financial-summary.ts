import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest } from '../../core/http/api-error.js';
import { dateSchema } from '../accounting/workflow.js';
export const financialSummaryQuery=z.object({kind:z.enum(['income','expense']),from:dateSchema,to:dateSchema,date_basis:z.enum(['payment_date','expense_date']).optional(),account_id:z.string().trim().min(1).max(200).optional(),account_name:z.string().trim().min(1).max(200).optional()}).strict().refine(value=>value.from<=value.to,'Start must be before end').refine(value=>value.kind==='income'?!value.date_basis:!value.account_id&&!value.account_name,'Account filters apply to income; date basis applies to expenses');
function compact(rows: Array<{label:string;total:number;count:number}>) {
 const grouped=new Map<string,{label:string;total:number;count:number}>();
 for(const row of rows){const current=grouped.get(row.label)??{label:row.label,total:0,count:0};current.total+=row.total;current.count+=row.count;grouped.set(row.label,current);}
 const sorted=[...grouped.values()].sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label));
 return sorted.length<=5?sorted:[...sorted.slice(0,4),{label:'Other',total:sorted.slice(4).reduce((sum,row)=>sum+row.total,0),count:sorted.slice(4).reduce((sum,row)=>sum+row.count,0)}];
}
/** Group in SQL; transaction details and unrelated sales never enter the response. */
export async function financialSummary(db: Prisma.TransactionClient,scope:{tenantId:string;projectId:string},query:z.infer<typeof financialSummaryQuery>) {
 const start=new Date(query.from+'T00:00:00Z'),end=new Date(Date.parse(query.to+'T00:00:00Z')+86400000);
 // Ledger calendar dates use UTC midnight; legacy timestamps use Bangladesh day boundaries.
 const legacy={gte:new Date(start.getTime()-6*3600000),lt:new Date(end.getTime()-6*3600000)};
 if(query.kind==='expense'){
  const basis=query.date_basis??'payment_date';
  const where:Prisma.ExpenseWhereInput=basis==='payment_date'
   ? {...scope,status:'paid',OR:[{paidAt:legacy},{paidAt:null,createdAt:legacy}]}
   : {...scope,status:{in:['approved','paid']},OR:[{expenseDate:{gte:start,lt:end}},{expenseDate:null,paidAt:legacy},{expenseDate:null,paidAt:null,createdAt:legacy}]};
  const [groups,states,categories]=await Promise.all([
   db.expense.groupBy({by:['category','categoryDefId'],where,_sum:{amount:true},_count:true}),
   db.expense.groupBy({by:['status'],where,_sum:{amount:true},_count:true}),
   db.expenseCategoryDef.findMany({where:scope,select:{id:true,name:true}}),
  ]);
  const total=groups.reduce((sum,row)=>sum+(row._sum.amount??0),0),count=groups.reduce((sum,row)=>sum+row._count,0);
  return{summary_type:'expense',date_basis:basis,project_id:scope.projectId,from:query.from,to:query.to,total,count,
   breakdown:compact(groups.map(row=>({label:categories.find(category=>category.id===row.categoryDefId)?.name??row.category,total:row._sum.amount??0,count:row._count}))),
   paid:states.find(row=>row.status==='paid')?._sum.amount??0,awaiting_payment:states.find(row=>row.status==='approved')?._sum.amount??0,
   snapshot_at:new Date().toISOString()};
 }
 let selectedAccount:{id:string;name:string}|undefined;
 if(query.account_id||query.account_name){
  const matches=await db.account.findMany({where:{...scope,...(query.account_id?{id:query.account_id}:{}),...(query.account_name?{name:{equals:query.account_name,mode:'insensitive' as const}}:{})},select:{id:true,name:true}});
  if(matches.length!==1)throw badRequest(matches.length?'More than one project account has that name. Please specify the account.':'No matching account in this project. Please check the account name.');
  selectedAccount=matches[0];
 }
 const where={...scope,...(selectedAccount?{accountId:selectedAccount.id}:{}),referenceType:'income',direction:'money_in' as const,OR:[{occurredOn:{gte:start,lt:end}},{occurredOn:null,createdAt:legacy}]};
 const [groups,accountGroups,categories,accounts]=await Promise.all([
  db.accountTransaction.groupBy({by:['incomeCategoryId','incomeSource'],where,_sum:{amount:true},_count:true}),
  db.accountTransaction.groupBy({by:['accountId'],where,_sum:{amount:true},_count:true}),
  db.incomeCategory.findMany({where:scope,select:{id:true,name:true}}),db.account.findMany({where:scope,select:{id:true,name:true}}),
 ]);
 return{summary_type:'income',...(selectedAccount?{account:selectedAccount}:{}),project_id:scope.projectId,from:query.from,to:query.to,
  total:groups.reduce((sum,row)=>sum+(row._sum.amount??0),0),count:groups.reduce((sum,row)=>sum+row._count,0),
  breakdown:compact(groups.map(row=>({label:categories.find(category=>category.id===row.incomeCategoryId)?.name??(row.incomeSource?.trim()||'Uncategorized'),total:row._sum.amount??0,count:row._count}))),
  accounts:compact(accountGroups.map(row=>({label:accounts.find(account=>account.id===row.accountId)?.name??'Account',total:row._sum.amount??0,count:row._count}))),snapshot_at:new Date().toISOString()};
}
