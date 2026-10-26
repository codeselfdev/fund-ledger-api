import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { forbidden } from '../../core/http/api-error.js';
import { prisma } from '../../core/prisma/client.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody } from '../../core/validation/validate.js';
import { writeAudit } from '../../core/audit/audit.service.js';
import { exportSchema, destinationsSchema, scheduleSchema } from './report.policy.js';
import { buildReport } from './report.workbook.js';
import { createExport, deliverExport, getExport, getSchedule, reportFile, retryExport, staffRecipients, validateDestinations } from './report.service.js';
const router=Router();
router.use(requireProject);
// Inbox recipients can open only exports explicitly delivered to their own account.
router.get('/exports/:id',asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req),id=String(req.params.id);
  if(!s.roles.some(r=>r==='owner'||r==='admin')&&!(s.menuRouteGranted&&s.menuPermissions?.reports?.read)&&!await prisma.reportDelivery.findFirst({where:{exportId:id,channel:'inbox',target:s.userId,status:'sent',report:{tenantId:s.tenantId,projectId:s.projectId}}})) throw forbidden();
  return ok(res,await getExport(s,id));
}));
router.get('/exports/:id/files/:index',asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req),id=String(req.params.id);
  if(!s.roles.some(r=>r==='owner'||r==='admin')&&!(s.menuRouteGranted&&s.menuPermissions?.reports?.read)&&!await prisma.reportDelivery.findFirst({where:{exportId:id,channel:'inbox',target:s.userId,status:'sent',report:{tenantId:s.tenantId,projectId:s.projectId}}})) throw forbidden();
  const index=z.coerce.number().int().min(0).max(3).parse(req.params.index),file=await reportFile(s,id,index);
  return ok(res,{filename:file.filename,base64:file.buffer.toString('base64')});
}));
router.use(requireRoles('owner','admin'));
router.get('/configuration',asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req);
  const [schedule,recipients,history,telegram,project]=await Promise.all([getSchedule(s),staffRecipients({tenantId:s.tenantId,projectId:s.projectId}),prisma.reportExport.findMany({where:{tenantId:s.tenantId,projectId:s.projectId},orderBy:{createdAt:'desc'},take:10,include:{deliveries:true}}),prisma.telegramConnection.findFirst({where:{tenantId:s.tenantId,projectId:s.projectId}}),prisma.project.findFirst({where:{id:s.projectId,tenantId:s.tenantId},select:{name:true}})]);
  return ok(res,{automation_available:process.env.REPORTS_AUTOMATION_ENABLED==='true',schedule,recipients,telegram:telegram?{chat_title:telegram.chatTitle,report:telegram.report}:null,project_name:project?.name,history:history.map(r=>({id:r.id,createdAt:r.createdAt,status:r.status,error:r.error,deliveries:r.deliveries}))});
}));
router.get('/snapshot',asyncHandler(async(req,res)=>{
  const timezone=exportSchema.shape.timezone.parse(req.query.timezone);
  const report=await buildReport(requireProjectContext(req),{sheets:['summary'],period:'today',layout:'one',timezone});
  return ok(res,{date:report.date,...report.stats});
}));
router.put('/schedule',validateBody(scheduleSchema),asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req),v=scheduleSchema.parse(req.body);
  if(v.enabled) await validateDestinations({tenantId:s.tenantId,projectId:s.projectId},v);
  const {recipient_ids,...settings}=v;
  await prisma.reportSchedule.upsert({where:{projectId:s.projectId},create:{tenantId:s.tenantId,projectId:s.projectId,updatedById:s.userId,...settings,recipientIds:recipient_ids},update:{...settings,recipientIds:recipient_ids,updatedById:s.userId}});
  await writeAudit({...s,actorUserId:s.userId,action:'report.schedule_updated',entityType:'report_schedule',entityId:s.projectId,after:v});
  return ok(res,await getSchedule(s));
}));
router.post('/exports',validateBody(exportSchema),asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req),report=await createExport(s,exportSchema.parse(req.body));
  await writeAudit({...s,actorUserId:s.userId,action:'report.generated',entityType:'report_export',entityId:report.id});
  return ok(res,report);
}));
router.post('/exports/:id/send',validateBody(destinationsSchema),asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req),id=String(req.params.id),result=await deliverExport(s,id,destinationsSchema.parse(req.body));
  await writeAudit({...s,actorUserId:s.userId,action:'report.sent',entityType:'report_export',entityId:id});
  return ok(res,result);
}));
router.post('/exports/:id/retry',asyncHandler(async(req,res)=>ok(res,await retryExport(requireProjectContext(req),String(req.params.id)))));
export {router as reportsRouter};
