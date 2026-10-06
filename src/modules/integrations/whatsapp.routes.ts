import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ok } from "../../core/http/response.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import {
  connectWhatsApp,
  disconnectWhatsApp,
  getWhatsAppConnection,
  mapWhatsAppGroup
} from "../../core/whatsapp/whatsapp.service.js";

const router = Router();
const connectSchema = z.object({
  waba_id: z.string().min(3).max(100),
  phone_number_id: z.string().min(3).max(100),
  access_token: z.string().min(20).max(4096),
  graph_api_version: z.string().regex(/^v\d+\.\d+$/).default("v22.0")
});
const groupSchema = z.object({
  group_id: z.string().min(3).max(300),
  group_name: z.string().min(2).max(120)
});

router.get("/integrations/whatsapp", requireProject, requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  return ok(res, await getWhatsAppConnection(auth.tenantId, auth.projectId));
}));

router.put("/integrations/whatsapp", requireProject, requireRoles("owner", "admin"), validateBody(connectSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof connectSchema>;
  const connection = await connectWhatsApp({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    wabaId: body.waba_id,
    phoneNumberId: body.phone_number_id,
    accessToken: body.access_token,
    graphApiVersion: body.graph_api_version
  });
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "whatsapp.connected",
    entityType: "whatsapp_connection",
    entityId: connection.id,
    after: connection
  });
  return ok(res, connection);
}));

router.put("/integrations/whatsapp/group", requireProject, requireRoles("owner", "admin"), validateBody(groupSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof groupSchema>;
  const connection = await mapWhatsAppGroup({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    groupId: body.group_id,
    groupName: body.group_name
  });
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "whatsapp.group_mapped",
    entityType: "whatsapp_connection",
    entityId: connection.id,
    after: connection.group
  });
  return ok(res, connection);
}));

router.delete("/integrations/whatsapp", requireProject, requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const result = await disconnectWhatsApp(auth.tenantId, auth.projectId);
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "whatsapp.disconnected",
    entityType: "whatsapp_connection",
    after: result
  });
  return ok(res, result);
}));

export { router as whatsappRouter };
