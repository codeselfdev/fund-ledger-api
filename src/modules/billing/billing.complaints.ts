import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { notFound } from '../../core/http/api-error.js';
import { ok, created } from '../../core/http/response.js';
import { requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody, validateQuery } from '../../core/validation/validate.js';
import { financialTransaction } from '../accounting/transaction.js';
import { scope, customer, audit, sameRequest } from './billing.service.js';
import { id, requestKey, hash } from './billing.policy.js';
const router=Router();
const status=z.enum(['open','progress','resolved']);
export const complaintSchema=z.object({customer_id:id,category:z.string().trim().min(2).max(80),description:z.string().trim().min(3).max(2000),urgent:z.boolean().default(false),request_key:requestKey}).strict();
const querySchema=z.object({status:status.optional(),limit:z.coerce.number().int().min(1).max(200).default(50),offset:z.coerce.number().int().min(0).default(0)}).strict();
const updateSchema=z.object({status,assigned_to:z.string().trim().max(120).optional()}).strict();
router.get('/',validateQuery(querySchema),asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req),q=querySchema.parse(req.query),where={...scope(a),status:q.status};
 const [entries,total]=await Promise.all([prisma.billingComplaint.findMany({where,include:{customer:{select:{id:true,name:true,mobile:true}}},orderBy:[{urgent:'desc'},{createdAt:'desc'}],take:q.limit,skip:q.offset}),prisma.billingComplaint.count({where})]);
 return ok(res,{entries,total,next_offset:total>q.offset+q.limit?q.offset+q.limit:null});
}));
router.post('/',requireRoles('accountant','cashier'),validateBody(complaintSchema),asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req),b=complaintSchema.parse(req.body);
 const row=await financialTransaction(async tx=>{
  const old=await tx.billingComplaint.findFirst({where:{...scope(a),requestKey:b.request_key}});
  if(old){sameRequest(old,b);return old;}
  await customer(tx,a,b.customer_id,false);
  const row=await tx.billingComplaint.create({data:{...scope(a),customerId:b.customer_id,category:b.category,description:b.description,urgent:b.urgent,requestKey:b.request_key,requestHash:hash(b),createdById:a.userId}});
  await audit(tx,a,'complaint.created','billing_complaint',row.id,row);return row;
 });return created(res,row);
}));
router.patch('/:id',requireRoles('accountant'),validateBody(updateSchema),asyncHandler(async(req,res)=>{
 const a=requireProjectContext(req),b=updateSchema.parse(req.body);
 const row=await financialTransaction(async tx=>{
  const old=await tx.billingComplaint.findFirst({where:{...scope(a),id:req.params.id}});if(!old)throw notFound('Complaint not found');
  const row=await tx.billingComplaint.update({where:{id:old.id},data:{status:b.status,assignedTo:b.assigned_to===undefined?undefined:b.assigned_to||null,resolvedAt:b.status==='resolved'?old.resolvedAt??new Date():null}});
  await audit(tx,a,'complaint.updated','billing_complaint',row.id,{before:old,after:row});return row;
 });return ok(res,row);
}));
export {router as billingComplaintsRouter};
