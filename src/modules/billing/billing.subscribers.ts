import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/async-handler.js';
import { notFound, conflict } from '../../core/http/api-error.js';
import { created } from '../../core/http/response.js';
import { requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody } from '../../core/validation/validate.js';
import { financialTransaction } from '../accounting/transaction.js';
import { customerSchema } from '../customers/customers.routes.js';
import { attributesFor, lockSetup } from '../business-setup/service.js';
import { scope, generateAssignment } from './billing.service.js';
import { id, requestKey, hash, json, today, atDate, mapInvoice } from './billing.policy.js';
const router=Router();
const schema=z.object({customer:customerSchema.omit({is_active:true}),unit_name:z.string().trim().min(1).max(120),plan_id:id,start:z.enum(['this_month','next_month']),request_key:requestKey}).strict();
router.post('/',requireRoles('accountant'),validateBody(schema),asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req),b=schema.parse(req.body),marker=`billing-subscriber:${a.projectId}:${b.request_key}`;
 const result=await financialTransaction(async tx=>{
  const previous=await tx.activity.findFirst({where:{id:marker,...scope(a)}});
  if(previous){const saved=previous.after as {request_hash:string;result:unknown};if(saved.request_hash!==hash(b))throw conflict('This request key belongs to a different subscriber.');return saved.result;}
  await lockSetup(tx,a);
  const plan=await tx.billingPlan.findFirst({where:{...scope(a),id:b.plan_id,isActive:true,mode:'fixed',intervalMonths:1}});if(!plan)throw notFound('Active monthly billing plan not found');
  if(await tx.billingUnit.findFirst({where:{...scope(a),name:b.unit_name}}))throw conflict('This unit or connection already exists. Assign it from Subscriptions.');
  const attributes=await attributesFor(tx,a,'customer',b.customer.attributes);
  const customer=await tx.customer.create({data:{...scope(a),...b.customer,attributes,isActive:true}});
  const kind=plan.category==='apartment_community'?'flat':plan.category==='isp_subscription'?'connection':plan.category==='rental_property'?'property':'service';
  const unit=await tx.billingUnit.create({data:{...scope(a),name:b.unit_name,kind}});
  const date=atDate(today().slice(0,7)+'-01');if(b.start==='next_month')date.setUTCMonth(date.getUTCMonth()+1);
  const period=date.toISOString().slice(0,10);
  const assignment=await tx.billingAssignment.create({data:{...scope(a),customerId:customer.id,unitId:unit.id,planId:plan.id,label:`${unit.name} · ${plan.name}`,startDate:date}});
  const generated=b.start==='this_month'?await generateAssignment(tx,a,assignment.id,period):null;
  const invoice=generated?await tx.billingInvoice.findFirstOrThrow({where:{id:generated.invoice_id,...scope(a)}}):null;
  const result=json({customer,unit,assignment,invoice:invoice?mapInvoice(invoice):null});
  await tx.activity.create({data:{id:marker,...scope(a),actorUserId:a.userId,action:'billing.subscriber.created',entityType:'billing_assignment',entityId:assignment.id,after:json({request_hash:hash(b),result})}});
  return result;
 });return created(res,result);
}));
export {router as billingSubscribersRouter};
