import { saveReviewedExpense } from './business-expense.js';
import { normalizeExpenseFields, receiptInvoiceParty, sameReceiptInvoice } from './expense-payee.js';
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { env } from '../../config/env.js';
import { sendMail } from '../../core/mail/mailer.service.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { requireRoles } from '../../core/security/auth.middleware.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { financialTransaction } from '../accounting/transaction.js';
import { dateSchema, lineSchema, workflow } from '../accounting/workflow.js';
import { quotationPerson } from '../contact-persons/contact-persons.service.js';
import { documentTax, taxSetup, lockSetup } from '../business-setup/service.js';
const router=Router(),id=z.string().trim().min(1).max(200),money=z.number().int().min(0).max(2147483647),text=z.string().trim().min(1).max(1000);
const scope=(a:{tenantId:string;projectId:string})=>({tenantId:a.tenantId,projectId:a.projectId});
const json=(v:unknown)=>JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const today=()=>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
router.use(requireRoles('owner','admin','accountant'),asyncHandler(async(req,_res,next)=>{
 const a=requireProjectContext(req),p=await prisma.project.findFirst({where:{id:a.projectId,tenantId:a.tenantId,isActive:true}});
 if(!p||!['fund_shares','accounting','billing','construction'].includes(p.projectType))throw forbidden('Choose an active supported project.');
 const sharedExpense=req.method==='GET'&&req.path==='/expense-snapshot'||req.method==='POST'&&req.path==='/actions'&&req.body?.operation==='create_expense_draft';
 if(p.projectType!=='accounting'&&!sharedExpense)throw forbidden('These tools belong to the active Accounting project.');
 const t=await prisma.tenant.findUniqueOrThrow({where:{id:a.tenantId},select:{currency:true}});
 if(t.currency!=='BDT')throw badRequest('Nesta Accounting AI currently requires a BDT project.');
 next();
}));
// Ordinary expense review is shared; sales and purchase capabilities remain Accounting-only.
router.get('/expense-snapshot',asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req),where=scope(a);
 const snapshot=await financialTransaction(async tx=>{
  const [p,suppliers,accounts,records,expense_categories,items]=await Promise.all([
   tx.project.findFirstOrThrow({where:{id:a.projectId,tenantId:a.tenantId}}),
   tx.vendor.findMany({where:{...where,isActive:true},select:{id:true,name:true}}),
   tx.account.findMany({where,select:{id:true,name:true,balance:true}}),
   tx.activity.findMany({where:{...where,entityType:'nesta_ai_business',action:{in:['nesta_ai.create_expense_draft','nesta_ai.create_purchase_bill_draft']}},select:{id:true,after:true,createdAt:true}}),
   tx.expenseCategoryDef.findMany({where,select:{id:true,name:true}}),
   tx.inventoryItem.findMany({where:{...where,isActive:true},select:{id:true,name:true}}),
  ]);
  return{tenant_id:a.tenantId,project_id:a.projectId,project_type:p.projectType,snapshot_at:new Date().toISOString(),suppliers,accounts,records,expense_categories,items,purchases:[],workflow:null};
 });return ok(res,snapshot);
}));
router.get('/snapshot',asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req),where=scope(a);
 const snapshot=await financialTransaction(async tx=>{
  const [p,customers,items,suppliers,documents,expenses,accounts,purchases,records,expense_categories]=await Promise.all([
   tx.project.findFirstOrThrow({where:{id:a.projectId,tenantId:a.tenantId}}),
   tx.customer.findMany({where:{...where,isActive:true},select:{id:true,name:true,email:true,mobile:true}}),
   tx.inventoryItem.findMany({where:{...where,isActive:true},select:{id:true,name:true,sku:true,unit:true,sellPrice:true,costPrice:true,quantity:true,reorderLevel:true}}),
   tx.vendor.findMany({where:{...where,isActive:true},select:{id:true,name:true}}),
   tx.businessDocument.findMany({where,select:{id:true,number:true,kind:true,status:true,revision:true,customerId:true,customerSnapshot:true,documentDate:true,dueDate:true,lines:true,subtotal:true,discount:true,tax:true,taxSnapshot:true,total:true,paidAmount:true,sourceId:true,events:true}}),
   tx.expense.findMany({where,select:{id:true,amount:true,status:true,category:true,expenseDate:true,createdAt:true}}),
   tx.account.findMany({where,select:{id:true,name:true,balance:true}}),
   tx.purchase.findMany({where,select:{id:true,vendorId:true,totalAmount:true,createdAt:true}}),
   tx.activity.findMany({where:{...where,entityType:'nesta_ai_business'},select:{id:true,after:true,createdAt:true},orderBy:{createdAt:'desc'}}),
   tx.expenseCategoryDef.findMany({where,select:{id:true,name:true}}),
  ]);
  return{tenant_id:a.tenantId,project_id:a.projectId,project_type:p.projectType,stock_enabled:p.stockManagementEnabled,workflow:workflow(p.commerceSettings),snapshot_at:new Date().toISOString(),email_enabled:!!(env.smtp.user&&env.smtp.pass),customers,items,suppliers,documents,expenses,accounts,purchases,records,expense_categories};
 });return ok(res,snapshot);
}));
const docFields=z.object({quotation_person_id:id.optional(),customer_id:id,document_date:dateSchema,due_date:dateSchema.optional(),lines:z.array(lineSchema.pick({item_id:true,description:true,quantity:true,unit_price:true})).min(1).max(100),discount_percent:z.number().min(0).max(100),vat_percent:z.number().min(0).max(100),note:text.optional(),source_id:id.optional()}).strict();
router.post('/document-preview',asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req),b=z.object({kind:z.enum(['quotation','sale']),fields:docFields,calculation:z.object({subtotal:money,discount:money,tax:money,total:money,currency:z.literal('BDT'),rounding:z.string()}).strict()}).strict().parse(req.body);
 const result=await financialTransaction(async tx=>{
  const c=await tx.customer.findFirst({where:{...scope(a),id:b.fields.customer_id,isActive:true}});if(!c)throw notFound('Customer not found in this project.');
  const amounts=b.fields.lines.map(l=>Math.round(l.quantity*l.unit_price)),subtotal=amounts.reduce((s,v)=>s+v,0),discount=Math.round(subtotal*b.fields.discount_percent/100),tax=Math.round((subtotal-discount)*b.fields.vat_percent/100);
  if(subtotal!==b.calculation.subtotal||discount!==b.calculation.discount||tax!==b.calculation.tax||subtotal-discount+tax!==b.calculation.total)throw badRequest('The requested totals do not reconcile.');
  for(const l of b.fields.lines)if(l.item_id&&!await tx.inventoryItem.findFirst({where:{...scope(a),id:l.item_id,isActive:true}}))throw notFound('Product not found in this project.');
  const contact=await quotationPerson(tx,a,c.id,b.fields.quotation_person_id);
  const setup=await taxSetup(tx,a);
  if(!setup.rates.length)return{tax_selection:null,total:b.calculation.total,tax_revision:setup.revision,...(b.fields.quotation_person_id?{quotation_person:contact.quotationPersonSnapshot}:{})};
  const rates=setup.rates.filter(r=>r.active&&r.kind==='add'&&r.documents.includes(b.kind)&&r.rateBps===Math.round(b.fields.vat_percent*100));
  if(b.fields.vat_percent>0&&rates.length!==1)throw badRequest('Choose a unique configured VAT rate matching the requested percentage.');
  const selection={revision:setup.revision,rateId:b.fields.vat_percent?rates[0]!.id:null,withholdingId:null,inclusive:false};
  const calculated=await documentTax(tx,a,b.kind,amounts,discount,selection);
  if(calculated?.payable!==b.calculation.total||calculated?.tax!==tax)throw conflict('Configured taxes differ from the requested total. Review the tax setup.');
  return{tax_selection:selection,total:calculated.payable,tax_revision:setup.revision,...(b.fields.quotation_person_id?{quotation_person:contact.quotationPersonSnapshot}:{})};
 });return ok(res,result);
}));
const bill={supplier_id:id,invoice_number:z.string().trim().min(1).max(120),invoice_date:dateSchema,lines:z.array(lineSchema.pick({item_id:true,description:true,quantity:true,unit_price:true})).min(1).max(100),discount:money,tax:money,total:money.positive(),note:text.optional()};
const fieldsSchemas={
 send_payment_reminder:z.object({invoice_id:id,channel:z.literal('email'),message:text}).strict(),
 log_collection_followup:z.object({customer_id:id,invoice_id:id.optional(),note:text,outcome:z.enum(['no_answer','promised_payment','reported_paid','disputed','contacted']),followup_date:dateSchema.optional()}).strict(),
 schedule_followup:z.object({quotation_id:id,followup_date:dateSchema,note:text}).strict(),
 create_purchase_order_draft:z.object({supplier_id:id,lines:z.array(lineSchema.pick({item_id:true,description:true,quantity:true,unit_price:true}).extend({item_id:id})).min(1).max(100),note:text.optional()}).strict(),
 create_expense_draft:z.object({...bill,title:z.string().trim().min(1).max(120).optional(),category_def_id:id.optional(),submission:z.enum(['draft','post']).optional(),invoice_number:bill.invoice_number.optional(),supplier_id:id.optional(),payee_name:z.string().trim().min(1).max(120).optional(),service_charge:money.optional(),category:z.enum(['materials','construction','professional','services','survey']),account_id:id.optional()}).strict(),
 create_purchase_bill_draft:z.object(bill).strict(),
};
type Operation=keyof typeof fieldsSchemas;
const actionSchema=z.object({operation:z.enum(Object.keys(fieldsSchemas) as [Operation,...Operation[]]),fields:z.record(z.unknown()),targets:z.record(z.unknown()),request_key:z.string().uuid(),verified_source_records:z.literal(true),proof_file_id:id.optional()}).strict();
router.post('/actions',asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req),b=actionSchema.parse(req.body),f=fieldsSchemas[b.operation].parse(normalizeExpenseFields(b.operation,b.fields)) as Record<string,unknown>,where=scope(a),requestHash=hash({operation:b.operation,fields:f,targets:b.targets}),recordId='nesta-ai-'+hash([a.tenantId,a.projectId,a.userId,b.request_key]);
 // Claim before the external send. Never retry an uncertain send automatically.
 const claimed=await financialTransaction(async tx=>{
  await lockSetup(tx,a);
  const old=await tx.activity.findFirst({where:{...where,id:recordId,actorUserId:a.userId,entityType:'nesta_ai_business'}});
  if(old){if((old.before as {request_hash?:string})?.request_hash!==requestHash)throw conflict('Request key belongs to another reviewed action.');return{fresh:false,record:old};}
  if(f.customer_id&&!await tx.customer.findFirst({where:{...where,id:String(f.customer_id),isActive:true}}))throw notFound('Customer not found in this project.');
  const supplier=f.supplier_id?await tx.vendor.findFirst({where:{...where,id:String(f.supplier_id),isActive:true}}):null;
  if(f.supplier_id&&!supplier)throw notFound('Supplier not found in this project.');
  if(f.account_id&&!await tx.account.findFirst({where:{...where,id:String(f.account_id)}}))throw notFound('Account not found in this project.');
  if(b.proof_file_id&&!await tx.upload.findFirst({where:{...where,id:b.proof_file_id,deletedAt:null}}))throw notFound('Proof file not found in this project.');
  if(Array.isArray(f.lines))for(const l of f.lines as {item_id?:string}[])if(l.item_id&&!await tx.inventoryItem.findFirst({where:{...where,id:l.item_id,isActive:true}}))throw notFound('Product not found in this project.');
  if(f.followup_date&&String(f.followup_date)<today())throw badRequest('Follow-up date cannot be in the past.');
  let customerId=f.customer_id?String(f.customer_id):null;
  if(f.quotation_id){const q=await tx.businessDocument.findFirst({where:{...where,id:String(f.quotation_id),kind:'quotation',status:'sent'}});if(!q)throw conflict('Quotation no longer awaits acceptance.');customerId=q.customerId;
   if((b.targets.quotation as {revision?:number})?.revision!==q.revision)throw conflict('Quotation changed. Review a fresh draft.');}
  if(f.invoice_id){const invoice=await tx.businessDocument.findFirst({where:{...where,id:String(f.invoice_id),kind:'sale'}});if(!invoice||customerId&&invoice.customerId!==customerId)throw notFound('Invoice not found for this customer in the project.');customerId=invoice.customerId;
   if(b.operation==='send_payment_reminder'){
    const c=await tx.customer.findFirst({where:{...where,id:invoice.customerId,isActive:true}}),reviewed=b.targets.recipient as {address?:string}|undefined,reviewedInvoice=b.targets.invoice as {outstanding?:number,status?:string}|undefined;
    if(invoice.status!=='issued'||invoice.total<=invoice.paidAmount||reviewedInvoice?.outstanding!==invoice.total-invoice.paidAmount||reviewedInvoice?.status!==invoice.status)throw conflict('Invoice balance changed. Review the reminder again.');
    if(!c?.email||reviewed?.address!==c.email||!env.smtp.user||!env.smtp.pass)throw conflict('The recipient or email configuration changed. Review the reminder again.');
   }
  }
  if(['create_expense_draft','create_purchase_bill_draft'].includes(b.operation)){
   const lines=f.lines as {quantity:number;unit_price:number}[],subtotal=lines.reduce((s,l)=>s+Math.round(l.quantity*l.unit_price),0);
   if(subtotal-Number(f.discount)+Number(f.tax)+Number(f.service_charge??0)!==f.total||Number(f.discount)>subtotal)throw badRequest('Invoice totals do not reconcile.');
   const existing=await tx.activity.findMany({where:{...where,entityType:'nesta_ai_business',action:{in:['nesta_ai.create_expense_draft','nesta_ai.create_purchase_bill_draft']}},select:{after:true}});
   if(existing.some(r=>{const after=r.after as {fields?:Record<string,unknown>;targets?:Record<string,unknown>};return after?.fields&&sameReceiptInvoice(receiptInvoiceParty(after.fields,after.targets),receiptInvoiceParty(f,{supplier:supplier??undefined}));}))throw conflict('This supplier invoice already has a saved draft.');
  }
  let result:Record<string,unknown>={status:b.operation==='send_payment_reminder'?'sending':b.operation==='schedule_followup'?'scheduled':b.operation==='log_collection_followup'?'recorded':'draft',operation:b.operation,posted:false};
  if(b.operation==='create_expense_draft'){
   if(f.submission==='post'){const reviewed=b.targets.expense_submission as {status?:string}|undefined,expected=a.roles.some(role=>role==='owner'||role==='admin')?'paid':'pending';if(reviewed?.status!==expected)throw conflict('Expense posting permissions changed. Review a fresh proposal.');}
   const e=await saveReviewedExpense(tx,a,f,supplier,b.proof_file_id);
   result={...result,expense_id:e.id,status:e.status,posted:e.status==='paid',approval_required:e.status==='pending'};
  }
  const record=await tx.activity.create({data:{id:recordId,...where,actorUserId:a.userId,action:`nesta_ai.${b.operation}`,entityType:'nesta_ai_business',entityId:customerId??(f.supplier_id?String(f.supplier_id):null),before:json({request_hash:requestHash}),after:json({...result,fields:{...f,...(customerId?{customer_id:customerId}:{})},targets:b.targets,...(b.proof_file_id?{proof_file_id:b.proof_file_id}:{})})}});
  return{fresh:true,record};
 });
 const saved=claimed.record.after as Record<string,unknown>;
 if(!claimed.fresh){if(['sending','outcome_unknown'].includes(String(saved.status)))throw conflict('Delivery may already have occurred. Check email delivery before any new attempt.');return ok(res,{id:claimed.record.id,...saved});}
 if(b.operation==='send_payment_reminder'){
  const recipient=b.targets.recipient as {address:string};
  // Mailer returning false can include an interrupted SMTP response after acceptance.
  const sent=await sendMail({to:recipient.address,subject:'Payment reminder',text:String(f.message)});
  const after={...saved,status:sent?'sent':'outcome_unknown',delivery_status:sent?'accepted_by_email_provider':'unknown',sent:sent?true:null};
  await prisma.activity.updateMany({where:{...where,id:recordId,actorUserId:a.userId},data:{after:json(after)}});
  return ok(res,{id:recordId,...after});
 }
 return ok(res,{id:claimed.record.id,...saved});
}));
export {router as businessAssistantRouter};
