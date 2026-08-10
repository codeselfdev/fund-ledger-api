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
import { createSessionToken } from "../auth/auth.service.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { createTrialSubscription } from "../../core/subscription/subscription.service.js";

const router = Router();

const provisionTenantSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(3).regex(/^[a-z0-9-]+$/),
  currency: z.string().length(3).default("BDT"),
  admin_name: z.string().min(2),
  admin_mobile: z.string().min(6),
  plan: z.nativeEnum(TenantPlan).default("free"),
  trial_days: z.number().int().min(0).max(365).default(14),
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
  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: body.name,
        slug: body.slug,
        currency: body.currency.toUpperCase(),
        plan: body.plan,
        contact: jsonValue({ subscription: createTrialSubscription(body.trial_days) }),
        penaltyPolicy: body.penalty_policy
      }
    });

    const project = await tx.project.create({
      data: {
        tenantId: tenant.id,
        name: "Default Project",
        totalShares: 1,
        penaltyPolicy: body.penalty_policy
      }
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        name: body.admin_name,
        mobile: body.admin_mobile
      }
    });

    await tx.projectMembership.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        userId: user.id,
        role: "owner"
      }
    });

    await tx.account.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        name: "Cash",
        type: "cash",
        isDefault: true
      }
    });

    return { tenant, project, user };
  });

  const { token } = await createSessionToken({
    tenantId: result.tenant.id,
    userId: result.user.id,
    activeProjectId: result.project.id
  });

  await writeAudit({
    tenantId: result.tenant.id,
    projectId: result.project.id,
    actorUserId: result.user.id,
    action: "tenant.provisioned",
    entityType: "tenant",
    entityId: result.tenant.id,
    after: {
      tenant_id: result.tenant.id,
      default_project_id: result.project.id,
      owner_user_id: result.user.id
    }
  });

  return created(res, {
    tenant_id: result.tenant.id,
    default_project_id: result.project.id,
    token
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
