import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { listDepositDelegatePermissions, upsertDepositDelegatePermission } from "../../core/security/deposit-delegate.service.js";

const router = Router();

const delegateUpsertSchema = z.object({
  user_id: z.string().min(1).optional(),
  member_id: z.string().min(1).optional(),
  is_active: z.boolean().default(true)
}).refine((value) => Boolean(value.user_id || value.member_id), {
  message: "Either user_id or member_id is required"
});

const delegatePatchSchema = z.object({
  is_active: z.boolean()
});

router.get("/deposit-delegates", requireProject, requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });

  const permissions = listDepositDelegatePermissions(tenant.contact, auth.projectId);
  const userIds = [...new Set(permissions.map((permission) => permission.user_id))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({
      where: { tenantId: auth.tenantId, id: { in: userIds } },
      select: { id: true, name: true, mobile: true, email: true, isActive: true }
    })
    : [];
  const memberships = userIds.length > 0
    ? await prisma.projectMembership.findMany({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        role: "member",
        isActive: true,
        userId: { in: userIds }
      },
      select: {
        userId: true,
        member: { select: { id: true, name: true, mobile: true, status: true } }
      }
    })
    : [];
  const userById = new Map(users.map((user) => [user.id, user]));
  const memberByUserId = new Map(memberships.map((membership) => [membership.userId, membership.member]));

  return ok(res, permissions.map((permission) => ({
    ...permission,
    user: userById.get(permission.user_id) ?? null,
    member: memberByUserId.get(permission.user_id) ?? null
  })));
}));

router.post("/deposit-delegates", requireProject, requireRoles("owner", "admin"), validateBody(delegateUpsertSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof delegateUpsertSchema>;

  const membership = await prisma.projectMembership.findFirst({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      role: "member",
      isActive: true,
      ...(body.user_id ? { userId: body.user_id } : {}),
      ...(body.member_id ? { memberId: body.member_id } : {})
    }
  });
  if (!membership) {
    throw badRequest("Delegate permission can only be granted to an active member user in this project");
  }

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });
  const updated = upsertDepositDelegatePermission({
    contact: tenant.contact,
    projectId: auth.projectId,
    userId: membership.userId,
    actorUserId: auth.userId,
    isActive: body.is_active
  });

  await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: updated.contact }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "deposit_delegate.upserted",
    entityType: "deposit_delegate",
    entityId: updated.permission.id,
    after: updated.permission
  });

  return created(res, updated.permission);
}));

router.patch("/deposit-delegates/:id", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), validateBody(delegatePatchSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof delegatePatchSchema>;

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });
  const permissions = listDepositDelegatePermissions(tenant.contact, auth.projectId);
  const target = permissions.find((permission) => permission.id === id);
  if (!target) throw notFound("Delegate permission not found");

  const updated = upsertDepositDelegatePermission({
    contact: tenant.contact,
    projectId: auth.projectId,
    userId: target.user_id,
    actorUserId: auth.userId,
    isActive: body.is_active
  });

  await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: updated.contact }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "deposit_delegate.updated",
    entityType: "deposit_delegate",
    entityId: updated.permission.id,
    before: target,
    after: updated.permission
  });

  return ok(res, updated.permission);
}));

export { router as depositDelegatesRouter };
