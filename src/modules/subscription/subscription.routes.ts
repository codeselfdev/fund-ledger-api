import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireRoles } from "../../core/security/auth.middleware.js";
import { requireAuthContext } from "../../core/security/auth.context.js";
import { evaluateSubscription, renewTenantSubscription, startTenantTrial } from "../../core/subscription/subscription.service.js";
import { validateBody } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();

const trialBodySchema = z.object({
  trial_days: z.number().int().min(1).max(365)
});

router.get("/", requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { id: true, name: true, plan: true, contact: true }
  });

  const summary = evaluateSubscription(tenant.contact);
  return ok(res, {
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    plan: tenant.plan,
    ...summary
  });
}));

router.post("/renew", requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });

  const renewed = renewTenantSubscription(tenant.contact);
  const updatedTenant = await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: renewed.contact },
    select: { id: true, name: true, plan: true, contact: true }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "subscription.renewed",
    entityType: "tenant",
    entityId: auth.tenantId,
    after: renewed.subscription
  });

  const summary = evaluateSubscription(updatedTenant.contact);
  return ok(res, {
    tenant_id: updatedTenant.id,
    tenant_name: updatedTenant.name,
    plan: updatedTenant.plan,
    ...summary
  });
}));

router.post("/trial", requireRoles("owner", "admin"), validateBody(trialBodySchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = req.body as z.infer<typeof trialBodySchema>;
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });

  const trial = startTenantTrial(tenant.contact, body.trial_days);
  const updatedTenant = await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: trial.contact },
    select: { id: true, name: true, plan: true, contact: true }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "subscription.trial_started",
    entityType: "tenant",
    entityId: auth.tenantId,
    after: trial.subscription
  });

  const summary = evaluateSubscription(updatedTenant.contact);
  return ok(res, {
    tenant_id: updatedTenant.id,
    tenant_name: updatedTenant.name,
    plan: updatedTenant.plan,
    ...summary
  });
}));

export { router as subscriptionRouter };
