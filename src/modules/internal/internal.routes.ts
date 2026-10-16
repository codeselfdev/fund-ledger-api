import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../../core/prisma/client.js";
import { requireInternalApiKey, internalActor } from "../../core/security/internal-api-key.middleware.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { tenantQuota } from "../../core/subscription/quota.service.js";
import { assistantStatus } from "../assistant/assistant.service.js";
import { buildSupportRouter } from "../support/support.routes.js";
import { overallUsage, tenantSummaries, summariesFor } from "./monitoring.service.js";
import { manualPaymentSchema, recordManualPayment } from "./payments.service.js";
import { organizationWorkbook } from "./export.service.js";
import { beginCleanup, cleanupPreview, runCleanup } from "./cleanup.service.js";
const router = Router();
router.use(requireInternalApiKey,rateLimit({windowMs:60000,limit:120,standardHeaders:true,legacyHeaders:false}));
const page = z.object({ offset:z.coerce.number().int().min(0).max(100000).default(0),search:z.string().trim().max(120).optional() });
router.use("/support",buildSupportRouter(true));
router.get("/summary",asyncHandler(async(_req,res)=>ok(res,await overallUsage())));
router.get("/tenants",asyncHandler(async(req,res)=>{const q=page.parse(req.query);return ok(res,await tenantSummaries(q.offset,q.search));}));
router.get("/tenants/:id",asyncHandler(async(req,res)=>{
  const tenant=await prisma.tenant.findUnique({where:{id:String(req.params.id)}});if(!tenant)throw notFound("Organization not found");
  const [summary,quota,assistant]=await Promise.all([summariesFor([tenant]),tenantQuota(tenant.id),assistantStatus(tenant.id)]);
  return ok(res,{...summary[0],quota,assistant});
}));
router.get("/tenants/:id/payments",asyncHandler(async(req,res)=>{
  const q=page.parse(req.query),rows=await prisma.platformPayment.findMany({where:{tenantId:String(req.params.id)},orderBy:[{paidAt:"desc"},{id:"desc"}],skip:q.offset,take:51});
  return ok(res,{payments:rows.slice(0,50),next_offset:rows.length>50?q.offset+50:null});
}));
router.post("/tenants/:id/payments",asyncHandler(async(req,res)=>ok(res,await recordManualPayment(String(req.params.id),manualPaymentSchema.parse(req.body),internalActor(req)))));
router.get("/tenants/:id/export.xlsx",rateLimit({windowMs:60000,limit:5}),asyncHandler(async(req,res)=>{
  const actor=internalActor(req),q=z.object({project_id:z.string().min(1).max(100).optional()}).parse(req.query),id=String(req.params.id);
  const file=await organizationWorkbook(id,q.project_id);
  await prisma.internalAudit.create({data:{tenantId:id,actor,action:"tenant.exported",metadata:{project_id:q.project_id??null,bytes:file.buffer.length}}});
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");res.setHeader("Content-Disposition",`attachment; filename="${file.filename}"`);res.send(file.buffer);
}));
router.post("/tenants/:id/cleanup",asyncHandler(async(req,res)=>{
  const b=z.object({dry_run:z.boolean().default(true),confirm:z.boolean().optional(),preview_token:z.string().max(2000).optional(),confirmation:z.string().max(200).optional()}).strict().parse(req.body??{});
  if(b.dry_run)return ok(res,await cleanupPreview(String(req.params.id)));
  if(b.confirm!==true||!b.preview_token||!b.confirmation)throw badRequest("Review a dry run and provide confirm, preview_token and the exact organization confirmation");
  return ok(res,await beginCleanup(String(req.params.id),b.preview_token,b.confirmation,internalActor(req)));
}));
router.get("/cleanup-jobs/:id",asyncHandler(async(req,res)=>{const job=await prisma.tenantDeletionJob.findUnique({where:{id:String(req.params.id)}});if(!job)throw notFound("Cleanup job not found");return ok(res,job);}));
router.post("/cleanup-jobs/:id/run",asyncHandler(async(req,res)=>ok(res,await runCleanup(String(req.params.id),internalActor(req)))));
export {router as internalRouter};
