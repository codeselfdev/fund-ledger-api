import { Router } from "express";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ok } from "../../core/http/response.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import {
  disconnectWhatsApp,
  getWhatsAppConnection
} from "../../core/whatsapp/whatsapp.service.js";

import { ApiError } from "../../core/http/api-error.js";
import { createGroupSchema, createManagedWhatsAppGroup, managedWhatsAppSetup } from "../../core/whatsapp/managed-whatsapp.service.js";
const router = Router();
router.get("/integrations/whatsapp/setup", requireProject, requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  return ok(res, await managedWhatsAppSetup(auth, Boolean(auth.impersonation)));
}));
router.post("/integrations/whatsapp/groups", requireProject, requireRoles("owner", "admin"), validateBody(createGroupSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const setup = await createManagedWhatsAppGroup(auth, createGroupSchema.parse(req.body).name);
  await writeAudit({ ...auth, actorUserId: auth.userId, action: "whatsapp.group_creation_requested", entityType: "whatsapp_connection", entityId: auth.projectId });
  return ok(res, setup);
}));

router.get("/integrations/whatsapp", requireProject, requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  return ok(res, await getWhatsAppConnection(auth.tenantId, auth.projectId));
}));

// Customer-owned business credentials and manual group IDs are no longer accepted.
router.put(["/integrations/whatsapp", "/integrations/whatsapp/group"], requireProject, requireRoles("owner", "admin"), (_req, _res, next) => {
  next(new ApiError(410, "MANAGED_WHATSAPP_REQUIRED", "Use Fund Nesta managed WhatsApp group setup."));
});

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
