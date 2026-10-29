import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { prisma } from '../../core/prisma/client.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody } from '../../core/validation/validate.js';
import { writeAudit } from '../../core/audit/audit.service.js';
import { badRequest } from '../../core/http/api-error.js';
import { env } from '../../config/env.js';
import { getWhatsAppConnection } from '../../core/whatsapp/whatsapp.service.js';
import { checkWebhookSecret, confirmTelegramLink, receiveTelegramUpdate, startTelegramLink, telegramConfigured, telegramLinkStatus } from './telegram.service.js';
import { testTelegram } from '../reports/report.service.js';
import { forwardTelegramAssistantUpdate } from './telegram-assistant.service.js';
export const telegramWebhookRouter=Router();
telegramWebhookRouter.post('/',asyncHandler(async(req,res)=>{
  checkWebhookSecret(req.header('X-Telegram-Bot-Api-Secret-Token'));
  await receiveTelegramUpdate(req.body);
  await forwardTelegramAssistantUpdate(req.body);
  return ok(res,{received:true});
}));
const router=Router();
router.use(requireProject,requireRoles('owner','admin'));
router.get('/',asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req),scope={tenantId:s.tenantId,projectId:s.projectId};
  const [telegram,posts,whatsapp,devices,schedule]=await Promise.all([
    prisma.telegramConnection.findFirst({where:scope}),prisma.integrationPost.findMany({where:scope,orderBy:{createdAt:'desc'},take:10}),getWhatsAppConnection(s.tenantId,s.projectId),
    prisma.projectMembership.findMany({where:{...scope,isActive:true,user:{ isActive:true,deviceId:{not:null}}},distinct:['userId'],select:{userId:true}}),
    prisma.reportSchedule.findFirst({where:scope}),
  ]);
  return ok(res,{automation_available:process.env.REPORTS_AUTOMATION_ENABLED==='true',telegram,posts,telegram_available:telegramConfigured(),bot_username:process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/,'')??null,whatsapp,whatsapp_available:env.whatsapp.enabled,email:{active:!!(env.smtp.user&&env.smtp.pass),from:env.smtp.from},push:{devices:devices.length},report_schedule_enabled:schedule?.enabled??false});
}));
router.post('/telegram/links',asyncHandler(async(req,res)=>ok(res,await startTelegramLink(requireProjectContext(req)))));
router.get('/telegram/links/:id',asyncHandler(async(req,res)=>ok(res,await telegramLinkStatus(requireProjectContext(req),String(req.params.id)))));
router.post('/telegram/links/:id/confirm',asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req),connection=await confirmTelegramLink(s,String(req.params.id));
  await writeAudit({...s,actorUserId:s.userId,action:'telegram.connected',entityType:'telegram_connection',entityId:connection.id});
  return ok(res,connection);
}));
const preferences=z.object({report:z.boolean(),notices:z.boolean(),reminders:z.boolean(),approvals:z.boolean()}).strict();
router.patch('/telegram',validateBody(preferences),asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req),data=preferences.parse(req.body);
  const updated=await prisma.telegramConnection.updateMany({where:{tenantId:s.tenantId,projectId:s.projectId},data});
  if(!updated.count) throw badRequest('Connect a Telegram group first');
  await writeAudit({...s,actorUserId:s.userId,action:'telegram.preferences_updated',entityType:'telegram_connection',entityId:s.projectId,after:data});
  return ok(res,await prisma.telegramConnection.findFirst({where:{tenantId:s.tenantId,projectId:s.projectId}}));
}));
router.post('/telegram/test',asyncHandler(async(req,res)=>{await testTelegram(requireProjectContext(req));return ok(res,{sent:true});}));
router.delete('/telegram',asyncHandler(async(req,res)=>{
  const s=requireProjectContext(req);
  await prisma.$transaction(async tx=>{
    await tx.telegramBotIdentity.deleteMany({where:{tenantId:s.tenantId,projectId:s.projectId}});
    await tx.telegramConnection.deleteMany({where:{tenantId:s.tenantId,projectId:s.projectId}});
    await tx.reportSchedule.updateMany({where:{tenantId:s.tenantId,projectId:s.projectId},data:{telegram:false}});
    await tx.telegramLink.updateMany({where:{tenantId:s.tenantId,projectId:s.projectId,consumedAt:null},data:{expiresAt:new Date()}});
  });
  await writeAudit({...s,actorUserId:s.userId,action:'telegram.disconnected',entityType:'telegram_connection',entityId:s.projectId});
  return ok(res,{disconnected:true});
}));
export {router as integrationsRouter};
