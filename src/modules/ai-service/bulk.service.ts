import { memberBatchPlan, saveBatchMember } from './member-batch.js';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { entitySchema, lockSetup, scope, type Scope } from '../business-setup/service.js';
import { builtinValues, saveRecord } from '../business-setup/records.js';
import { BUILTINS, businessPhoneIdentity, validateAttributes, type Attributes, type BusinessEntity } from '../business-setup/contract.js';
import { dhakaToday, isCalendarDate } from '../expenses/expense-input.js';
type Auth=Scope & {userId:string;roles:string[]};
type Db=Prisma.TransactionClient;
const id=z.string().trim().min(1).max(200),text=(n:number)=>z.string().trim().min(1).max(n),money=z.number().int().min(0).max(2147483647);
const date=z.string().refine(isCalendarDate,'Use a valid YYYY-MM-DD date').refine(v=>v<=dhakaToday(),'Posting date cannot be in the future');
const attributes=z.record(z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.array(z.string().max(100)).max(100),z.null()])).optional();
const person={name:text(120),email:z.string().email().max(200).optional(),address:text(500).optional(),attributes};
const expenses=z.object({account_id:id,amount:money.positive(),title:text(120),category:z.enum(['materials','construction','professional','services','survey']).optional(),category_def_id:id.optional(),vendor_id:id.optional(),vendor:text(120).optional(),expense_date:date.optional()}).strict().refine(r=>r.category||r.category_def_id,'Choose an expense category');
export const bulkOperations=['bulk_members','bulk_customers','bulk_dealers','bulk_items','bulk_expenses','bulk_incomes'] as const;
export type Operation=typeof bulkOperations[number];
const schemas={
 bulk_members:z.object({name:text(120).min(2),mobile:z.string().regex(/^\+[1-9]\d{6,14}$/),shares:money.positive(),email:z.string().email().max(200).optional(),address:text(500).optional()}).strict(),
 bulk_customers:z.object({...person,mobile:text(32).optional()}).strict(),
 bulk_dealers:z.object({...person,address:text(255).optional(),phone:text(32).optional(),notes:text(2000).optional()}).strict(),
 bulk_items:z.object({name:text(120),description:text(2000).optional(),sku:text(64).optional(),unit:text(16).optional(),category_id:id.optional(),suggested_category:text(64).optional(),suggested_supplier:text(120).optional(),inference_notes:text(1000).optional(),cost_price:money.optional(),sell_price:money.optional(),quantity:money.optional(),reorder_level:money.optional(),attributes}).strict(),
 bulk_expenses:expenses,
 bulk_incomes:z.object({account_id:id,amount:money.positive(),source:text(120),note:text(500).optional(),income_date:date.optional(),category_id:id.optional(),customer_id:id.optional()}).strict(),
};
export const bulkRequest=z.object({operation:z.enum(bulkOperations),fields:z.object({rows:z.array(z.record(z.unknown())).min(1).max(50)}).strict()}).strict();
export type BulkRequest=z.infer<typeof bulkRequest>;
type Row=Record<string,unknown>;
// Review hints are never passed to record creation and cannot create related records.
function itemRecord(row:Row){const {category_id,suggested_category,suggested_supplier,inference_notes,...record}=row;return record;}
function itemHints(row:Row){return Object.fromEntries(['suggested_category','suggested_supplier','inference_notes'].filter(key=>row[key]!=null).map(key=>[key,row[key]]));}
export const bulkJson=(v:unknown)=>JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
function canonical(v:unknown):unknown{return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;}
export const bulkHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const isAdmin=(a:Auth)=>a.roles.some(r=>['owner','admin'].includes(r));
const entities:Partial<Record<Operation,BusinessEntity>>={bulk_customers:'customer',bulk_dealers:'dealer',bulk_items:'item'};
async function projectContext(db:Db,a:Auth,operation?:Operation){
 if(!a.roles.some(r=>['owner','admin','accountant'].includes(r)))throw forbidden('Only accountants and administrators may use bulk AI entry.');
 const project=await db.project.findFirst({where:{id:a.projectId,tenantId:a.tenantId,isActive:true}});
 if(!project||!['fund_shares','accounting','billing','construction'].includes(project.projectType))throw forbidden('Choose an active supported project.');
 const policy=await db.onboardingProgress.findUnique({where:{tenantId:a.tenantId},select:{incomeApprovalFlow:true,expenseApprovalFlow:true}});
 if(operation==='bulk_incomes'&&!isAdmin(a)&&policy?.incomeApprovalFlow&&policy.incomeApprovalFlow!=='accountant_only')throw forbidden('The income approval rule requires an authorized administrator.');
 const tenant=await db.tenant.findUniqueOrThrow({where:{id:a.tenantId},select:{ subscription: true, currency:true}});
 if(operation&&['bulk_incomes','bulk_expenses','bulk_items'].includes(operation)&&tenant.currency!=='BDT')throw badRequest('Bulk AI monetary entries currently require BDT.');
 return{project,policy:{income:policy?.incomeApprovalFlow??'accountant_only',expense:policy?.expenseApprovalFlow??'accountant_and_approver'},currency:tenant.currency};
}
export async function bulkCatalog(db:Db,a:Auth){
 const c=await projectContext(db,a),where=scope(a);
 const [customers,vendors,items,accounts,income_categories,expense_categories,customer_schema,dealer_schema,item_schema,item_categories]=await Promise.all([
  db.customer.findMany({where:{...where,isActive:true},select:{id:true,name:true,mobile:true,email:true},orderBy:{id:'asc'},take:500}),
  db.vendor.findMany({where:{...where,isActive:true},select:{id:true,name:true,phone:true},orderBy:{id:'asc'},take:500}),
  db.inventoryItem.findMany({where:{...where,isActive:true},select:{id:true,name:true,sku:true},orderBy:{id:'asc'},take:500}),
  db.account.findMany({where,select:{id:true,name:true,balance:true}}),
  db.incomeCategory.findMany({where:{...where,isActive:true},select:{id:true,name:true}}),
  db.expenseCategoryDef.findMany({where,select:{id:true,name:true}}),
  entitySchema(db,a,'customer'),entitySchema(db,a,'dealer'),entitySchema(db,a,'item'),
  db.inventoryCategory.findMany({where:{...where,isActive:true},select:{id:true,name:true},orderBy:{name:'asc'},take:500}),
 ]);
 return{tenant_id:a.tenantId,project_id:a.projectId,project_type:c.project.projectType,currency:c.currency,today:dhakaToday(),stock_enabled:c.project.stockManagementEnabled,customers,suppliers:vendors,vendors,products:items,item_categories,accounts,income_categories,expense_categories,entity_schemas:{customer:customer_schema,dealer:dealer_schema,item:item_schema},catalog_limit:500,tool_fields:Object.fromEntries(bulkOperations.map(k=>[k,['rows']]))};
}
export async function previewBulk(db:Db,a:Auth,input:BulkRequest){
 const {operation}=input,c=await projectContext(db,a,operation),entity=entities[operation];
 const rows=input.fields.rows.map((row,i)=>{const parsed=schemas[operation].safeParse(row);if(!parsed.success)throw badRequest(`Row ${i+1}: ${parsed.error.issues.map(e=>`${e.path.join('.')}: ${e.message}`).join('; ')}`);return parsed.data as Row;});
 if(operation==='bulk_members'){const plan=await memberBatchPlan(db,a,rows as {name:string;mobile:string;shares:number;email?:string;address?:string}[]);return{tenant_id:a.tenantId,project_id:a.projectId,project_type:c.project.projectType,operation,row_count:rows.length,currency:c.currency,policy:c.policy,...plan,entries:plan.entries as Row[]};}
 const definition=entity?await entitySchema(db,a,entity):null;
 const existingPeople=entity==='customer'?await db.customer.findMany({where:scope(a),select:{name:true,mobile:true,email:true}}):entity==='dealer'?await db.vendor.findMany({where:scope(a),select:{name:true,phone:true,email:true}}):[];
 const entries:Row[]=[],seen=new Set<string>(),balances=new Map<string,number>();
 let total=0;
 for(const [index,r]of rows.entries()){
  try{
   if(entity){
    const b=builtinValues(entity,entity==='item'?itemRecord(r):r);
    let category:Row={};
    if(entity==='item'&&r.category_id){const selected=await db.inventoryCategory.findFirst({where:{...scope(a),id:String(r.category_id),isActive:true}});if(!selected)throw notFound('Active item category not found in this project.');category={category_id:selected.id,category_name:selected.name};}
    const attrs=validateAttributes(definition!.fields,(r.attributes??{}) as Attributes);
    const keys=[`name:${String(b.name).normalize('NFKC').toLowerCase()}`,...(entity==='item'?(b.sku?[`sku:${b.sku}`]:[]):[b[entity==='customer'?'mobile':'phone']?`phone:${businessPhoneIdentity(String(b[entity==='customer'?'mobile':'phone']))}`:'',b.email?`email:${String(b.email).toLowerCase()}`:''].filter(Boolean))];
    if(keys.some(k=>seen.has(k)))throw conflict('Duplicate name or identity within this batch.');keys.forEach(k=>seen.add(k));
    const where={...scope(a),OR:[{name:{equals:String(b.name),mode:'insensitive' as const}},...(entity==='item'&&b.sku?[{sku:String(b.sku)}]:[])]};
    const existing=entity==='item'?await db.inventoryItem.findMany({where,select:{name:true,sku:true}}):existingPeople;
    if(existing.some(v=>{const row=v as Row;return keys.some(k=>k===`name:${String(row.name).normalize('NFKC').toLowerCase()}`||entity==='item'&&row.sku&&k===`sku:${row.sku}`||entity!=='item'&&row[entity==='customer'?'mobile':'phone']&&k===`phone:${businessPhoneIdentity(String(row[entity==='customer'?'mobile':'phone']))}`||row.email&&k===`email:${String(row.email).toLowerCase()}`);} ))throw conflict('A record with this name or identity already exists. Bulk entry creates new records only.');
    if(entity==='item'&&Number(b.quantity)>0&&!c.project.stockManagementEnabled)throw badRequest('Enable stock management before setting opening quantities.');
    entries.push({row:index+1,...(entity==='item'?{...category,...itemHints(r)}:{}),...Object.fromEntries(BUILTINS[entity].filter(f=>b[f.property]!=null).map(f=>[f.key,b[f.property]])),attributes:attrs,status:'create'});
    continue;
   }
   const account=await db.account.findFirst({where:{...scope(a),id:String(r.account_id)}});if(!account)throw notFound('Account not found in this project.');
   const amount=Number(r.amount),before=balances.get(account.id)??account.balance;
   let after=before,details:Row={};
   if(operation==='bulk_incomes'){
    if(r.category_id){const cat=await db.incomeCategory.findFirst({where:{...scope(a),id:String(r.category_id),isActive:true}});if(!cat)throw notFound('Active income category not found in this project.');details.category=cat.name;}
    if(r.customer_id){const customer=await db.customer.findFirst({where:{...scope(a),id:String(r.customer_id),isActive:true}});if(!customer)throw notFound('Active customer not found in this project.');details.customer=customer.name;}
    if(before>2147483647-amount)throw badRequest('Account balance would exceed the supported amount.');after=before+amount;
   }else{
    if(r.category_def_id){const cat=await db.expenseCategoryDef.findFirst({where:{...scope(a),id:String(r.category_def_id)}});if(!cat)throw notFound('Expense category not found in this project.');details.category_name=cat.name;}
    if(r.vendor_id){const vendor=await db.vendor.findFirst({where:{...scope(a),id:String(r.vendor_id),isActive:true}});if(!vendor)throw notFound('Active dealer not found in this project.');if(r.vendor&&String(r.vendor)!==vendor.name)throw badRequest('Dealer name conflicts with the selected dealer.');details.vendor=vendor.name;details.vendor_phone=vendor.phone;}
    if(isAdmin(a)){if(before<amount)throw badRequest('Source account has insufficient balance for this batch.');after=before-amount;}
   }
   const key=bulkHash(r);if(seen.has(key))throw conflict('Duplicate transaction within this batch.');seen.add(key);
   total+=amount;if(!Number.isSafeInteger(total))throw badRequest('Batch total exceeds the supported range.');
   balances.set(account.id,after);
   const field=operation==='bulk_incomes'?'income_date':'expense_date';
   entries.push({row:index+1,...r,[field]:r[field]??dhakaToday(),...details,account:account.name,balance_before:before,balance_after:after,status:operation==='bulk_incomes'?'posted':isAdmin(a)?'paid':'approved'});
  }catch(e){if(e instanceof Error)throw badRequest(`Row ${index+1}: ${e.message}`);throw e;}
 }
 return{tenant_id:a.tenantId,project_id:a.projectId,project_type:c.project.projectType,operation,row_count:rows.length,currency:c.currency,policy:c.policy,...(entity?{schema_revision:definition!.revision,stock_enabled:c.project.stockManagementEnabled}:{total_amount:total}),entries};
}
export async function executeBulk(db:Db,a:Auth,input:BulkRequest,targets:unknown,requestKey:string,sourceFiles:string[]=[]){
 await lockSetup(db,a);
 const requestHash=bulkHash({input,targets,sourceFiles}),recordId='nesta-bulk-'+bulkHash([a.tenantId,a.projectId,a.userId,requestKey]);
 const old=await db.activity.findFirst({where:{...scope(a),id:recordId,actorUserId:a.userId,entityType:'nesta_ai_bulk'}});
 if(old){if((old.before as {request_hash?:string})?.request_hash!==requestHash)throw conflict('Request key belongs to another batch.');await projectContext(db,a,input.operation);return old.after;}
 const plan=await previewBulk(db,a,input);
 if(bulkHash(plan)!==bulkHash(targets))throw conflict('Batch details, balances, duplicates or project settings changed. Prepare a fresh review.');
 for(const file of sourceFiles)if(!await db.upload.findFirst({where:{...scope(a),id:file,deletedAt:null}}))throw notFound('Source image not found in this project.');
 const records:Row[]=[],entity=entities[input.operation];
 for(const entry of plan.entries){
  const r=input.fields.rows[Number(entry.row)-1]!;
  if(input.operation==='bulk_members'){const saved=await saveBatchMember(db,a,r as {name:string;mobile:string;shares:number;email?:string;address?:string});records.push({row:entry.row,id:saved.id,name:saved.name,status:'created'});continue;}
  if(entity){const saved=await saveRecord(db,a,entity,entity==='item'?itemRecord(r):r);if(entity==='item'&&r.category_id)await db.inventoryItem.update({where:{id:saved.id},data:{categoryId:String(r.category_id)}});records.push({row:entry.row,id:saved.id,name:saved.name,status:'created'});continue;}
  const amount=Number(r.amount),accountId=String(r.account_id);
  if(input.operation==='bulk_incomes'){
   const changed=await db.account.updateMany({where:{...scope(a),id:accountId,balance:{lte:2147483647-amount}},data:{balance:{increment:amount}}});if(changed.count!==1)throw conflict('Account balance changed. Review the batch again.');
   const account=await db.account.findFirstOrThrow({where:{...scope(a),id:accountId}});
   const income=await db.accountTransaction.create({data:{...scope(a),accountId,direction:'money_in',amount,referenceType:'income',referenceId:accountId,incomeSource:String(r.source),incomeCategoryId:r.category_id?String(r.category_id):null,incomeCustomerId:r.customer_id?String(r.customer_id):null,occurredOn:new Date(`${entry.income_date}T00:00:00Z`),description:String(r.note??r.source),balanceAfter:account.balance,createdById:a.userId}});
   records.push({row:entry.row,id:income.id,status:'posted',amount});
   await db.activity.create({data:{...scope(a),actorUserId:a.userId,action:'income.recorded',entityType:'account_transaction',entityId:income.id,after:bulkJson({amount,account_id:accountId,balance_after:account.balance,batch_id:recordId})}});
  }else{
   if(isAdmin(a)){const changed=await db.account.updateMany({where:{...scope(a),id:accountId,balance:{gte:amount}},data:{balance:{decrement:amount}}});if(changed.count!==1)throw conflict('Insufficient account balance. Review the batch again.');}
   const expense=await db.expense.create({data:{...scope(a),title:String(r.title),amount,category:(r.category??'services') as 'services',categoryDefId:r.category_def_id?String(r.category_def_id):null,vendor:entry.vendor?String(entry.vendor):r.vendor?String(r.vendor):null,vendorId:r.vendor_id?String(r.vendor_id):null,vendorPhone:entry.vendor_phone?String(entry.vendor_phone):null,expenseDate:new Date(`${entry.expense_date}T00:00:00Z`),accountId,docFileId:sourceFiles[0],status:isAdmin(a)?'paid':'approved',createdById:a.userId,approvedById:a.userId,...(isAdmin(a)?{disbursedById:a.userId,paidAccountId:accountId,paidAt:new Date()}: {})}});
   if(isAdmin(a)){const account=await db.account.findFirstOrThrow({where:{...scope(a),id:accountId}});await db.accountTransaction.create({data:{...scope(a),accountId,direction:'money_out',amount,referenceType:'expense',referenceId:expense.id,description:expense.title,balanceAfter:account.balance,createdById:a.userId}});}
   records.push({row:entry.row,id:expense.id,status:expense.status,amount});
   await db.activity.create({data:{...scope(a),actorUserId:a.userId,action:isAdmin(a)?'expense.posted':'expense.approved',entityType:'expense',entityId:expense.id,after:bulkJson({amount,account_id:accountId,batch_id:recordId,status:expense.status})}});
  }
 }
 const result={operation:input.operation,status:'completed',row_count:records.length,...('total_amount'in plan?{total_amount:plan.total_amount}:{}),records,source_file_ids:sourceFiles};
 await db.activity.create({data:{id:recordId,...scope(a),actorUserId:a.userId,action:`nesta_ai.${input.operation}`,entityType:'nesta_ai_bulk',before:{request_hash:requestHash},after:bulkJson(result)}});
 return result;
}
