import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { notFound } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireAuthContext, requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();
const notificationDeviceTokenSchema = z.object({
  fcm_token: z.string().min(20).max(2048)
});
const notificationBroadcastSchema = z.object({
  title: z.string().min(2).max(120),
  body: z.string().min(2).max(1000),
  roles: z.array(z.nativeEnum(Role)).max(6).optional(),
  member_ids: z.array(z.string().min(1)).max(500).optional(),
  type: z.string().min(2).max(80).default("announcement.manual")
}).refine((value) => !(value.roles && value.member_ids), {
  message: "Use either roles or member_ids, not both"
});

router.get("/activity", requireProject, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const activity = await prisma.activity.findMany({
    where: {
      tenantId: auth.tenantId,
      OR: [
        { projectId: auth.projectId },
        { projectId: null }
      ]
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return ok(res, activity);
}));

router.get("/notifications", requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const notifications = await prisma.notification.findMany({
    where: {
      tenantId: auth.tenantId,
      recipientUserId: auth.userId,
      ...(auth.projectId ? { OR: [{ projectId: auth.projectId }, { projectId: null }] } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return ok(res, notifications);
}));

router.patch("/notifications/:id/read", requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const notification = await prisma.notification.findFirst({
    where: {
      id,
      tenantId: auth.tenantId,
      recipientUserId: auth.userId
    }
  });
  if (!notification) throw notFound("Notification not found");

  const updated = await prisma.notification.update({
    where: { id },
    data: { readAt: new Date() }
  });

  return ok(res, updated);
}));

router.post("/notifications/device-token", requireRoles("any"), validateBody(notificationDeviceTokenSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = req.body as z.infer<typeof notificationDeviceTokenSchema>;
  await prisma.user.updateMany({
    where: { id: auth.userId, tenantId: auth.tenantId },
    data: { deviceId: body.fcm_token.trim() }
  });
  return ok(res, { registered: true });
}));

router.delete("/notifications/device-token", requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  await prisma.user.updateMany({
    where: { id: auth.userId, tenantId: auth.tenantId },
    data: { deviceId: null }
  });
  return ok(res, { removed: true });
}));

router.post("/notifications/broadcast", requireProject, requireRoles("owner", "admin", "accountant"), validateBody(notificationBroadcastSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof notificationBroadcastSchema>;

  const result = await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    type: body.type,
    title: body.title.trim(),
    body: body.body.trim(),
    entityType: "announcement",
    roles: body.roles,
    memberIds: body.member_ids
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "notification.broadcasted",
    entityType: "notification",
    after: {
      type: body.type,
      title: body.title.trim(),
      target_roles: body.roles ?? [],
      target_member_ids: body.member_ids ?? [],
      recipient_count: result.count
    }
  });

  return ok(res, {
    sent: true,
    recipient_count: result.count
  });
}));

export { router as activityRouter };
