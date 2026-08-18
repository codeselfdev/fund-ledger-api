import { Router } from "express";
import { z } from "zod";
import { Prisma, TenantPlan } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProvisioningApiKey } from "../../core/security/api-key.middleware.js";
import { authenticate, requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireActiveSubscription } from "../../core/security/subscription.middleware.js";
import { requireAuthContext, requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";
import { optionalPenaltyPolicySchema } from "../../core/validation/common.schemas.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { provisionTenant } from "./tenants.service.js";

const router = Router();

const provisionTenantSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(3).regex(/^[a-z0-9-]+$/),
  currency: z.string().length(3).default("BDT"),
  admin_name: z.string().min(2),
  admin_mobile: z.string().min(6),
  plan: z.nativeEnum(TenantPlan).default("free"),
  trial_days: z.number().int().min(0).max(365).default(182),
  penalty_policy: optionalPenaltyPolicySchema
});

const updateTenantSchema = z.object({
  name: z.string().min(2).optional(),
  branding: z.record(z.unknown()).optional(),
  contact: z.record(z.unknown()).optional(),
  currency: z.string().length(3).optional()
});

function jsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeContact(currentContact: unknown, patchContact: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!patchContact) return undefined;
  const base = isRecord(currentContact) ? { ...currentContact } : {};
  return jsonValue({
    ...base,
    ...patchContact
  });
}

router.post("/", requireProvisioningApiKey, validateBody(provisionTenantSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof provisionTenantSchema>;
  const result = await provisionTenant({
    name: body.name,
    slug: body.slug,
    currency: body.currency,
    adminName: body.admin_name,
    adminMobile: body.admin_mobile,
    plan: body.plan,
    trialDays: body.trial_days,
    penaltyPolicy: jsonValue(body.penalty_policy)
  });

  return created(res, {
    tenant_id: result.tenantId,
    default_project_id: result.defaultProjectId,
    token: result.token
  });
}));

router.get("/current", authenticate, requireActiveSubscription, asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      currency: true,
      plan: true,
      branding: true,
      contact: true,
      penaltyPolicy: true
    }
  });

  return ok(res, tenant);
}));

router.patch(
  "/current",
  authenticate,
  requireActiveSubscription,
  requireProject,
  requireRoles("owner"),
  validateBody(updateTenantSchema),
  asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    const body = req.body as z.infer<typeof updateTenantSchema>;
    if (Object.keys(body).length === 0) throw badRequest("No fields to update");

    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
    const tenant = await prisma.tenant.update({
      where: { id: auth.tenantId },
      data: {
        name: body.name,
        branding: jsonValue(body.branding),
        contact: mergeContact(before.contact, body.contact),
        currency: body.currency?.toUpperCase()
      }
    });

    await writeAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      action: "tenant.updated",
      entityType: "tenant",
      entityId: tenant.id,
      before,
      after: tenant
    });

    return ok(res, tenant);
  })
);

export { router as tenantsRouter };
