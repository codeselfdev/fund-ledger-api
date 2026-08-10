import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();

const updateMembershipSchema = z.object({
  role: z.nativeEnum(Role).optional(),
  is_active: z.boolean().optional()
});

const createMembershipSchema = z
  .object({
    user_id: z.string().min(1).optional(),
    mobile: z.string().min(6).optional(),
    role: z.nativeEnum(Role)
  })
  .refine((v) => v.user_id != null || v.mobile != null, {
    message: "user_id or mobile is required",
    path: ["user_id"]
  });

router.get("/", requireProject, requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const memberships = await prisma.projectMembership.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId },
    include: { user: { select: { id: true, name: true, mobile: true, email: true } } },
    orderBy: { createdAt: "asc" }
  });

  return ok(res, memberships.map((membership) => ({
    id: membership.id,
    role: membership.role,
    is_active: membership.isActive,
    member_id: membership.memberId,
    user: membership.user
  })));
}));

router.post("/", requireProject, requireRoles("owner", "admin"), validateBody(createMembershipSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createMembershipSchema>;

  const user = body.user_id
    ? await prisma.user.findFirst({ where: { id: body.user_id, tenantId: auth.tenantId, isActive: true } })
    : await prisma.user.findFirst({ where: { mobile: body.mobile!, tenantId: auth.tenantId, isActive: true } });
  if (!user) throw notFound("No active user found for the given identity");

  const existing = await prisma.projectMembership.findFirst({
    where: { projectId: auth.projectId, userId: user.id, role: body.role }
  });
  if (existing) {
    if (!existing.isActive) {
      const reactivated = await prisma.projectMembership.update({
        where: { id: existing.id },
        data: { isActive: true }
      });
      await writeAudit({
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        actorUserId: auth.userId,
        action: "membership.reactivated",
        entityType: "project_membership",
        entityId: reactivated.id,
        before: existing,
        after: reactivated
      });
      return ok(res, { id: reactivated.id, role: reactivated.role, is_active: reactivated.isActive, user_id: user.id });
    }
    throw conflict("This user already has that role on the project");
  }

  // If the role being granted is `member`, find (or don't create) a Member row for them.
  let memberLink: string | null = null;
  if (body.role === "member") {
    const memberRow = await prisma.member.findFirst({
      where: { tenantId: auth.tenantId, projectId: auth.projectId, mobile: user.mobile }
    });
    memberLink = memberRow?.id ?? null;
  }

  const membership = await prisma.projectMembership.create({
    data: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      userId: user.id,
      memberId: memberLink,
      role: body.role
    }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "membership.created",
    entityType: "project_membership",
    entityId: membership.id,
    after: membership
  });

  return created(res, {
    id: membership.id,
    role: membership.role,
    is_active: membership.isActive,
    user_id: user.id,
    user: { id: user.id, name: user.name, mobile: user.mobile, email: user.email }
  });
}));

router.patch("/:id", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), validateBody(updateMembershipSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof updateMembershipSchema>;

  const before = await prisma.projectMembership.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Membership not found");

  const disabling = body.is_active === false || (body.role && body.role !== before.role);
  if (before.role === "owner" && before.isActive && disabling) {
    const otherActiveOwners = await prisma.projectMembership.count({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        role: "owner",
        isActive: true,
        id: { not: id }
      }
    });
    if (otherActiveOwners === 0) throw badRequest("Cannot remove the project's only active owner");
  }

  if (body.role && body.role !== before.role) {
    const clash = await prisma.projectMembership.findFirst({
      where: { projectId: auth.projectId, userId: before.userId, role: body.role }
    });
    if (clash) throw conflict("This user already has that role on the project");
  }

  const membership = await prisma.projectMembership.update({
    where: { id },
    data: {
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.is_active !== undefined ? { isActive: body.is_active } : {})
    }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "membership.updated",
    entityType: "project_membership",
    entityId: membership.id,
    before,
    after: membership
  });

  return ok(res, { id: membership.id, role: membership.role, is_active: membership.isActive });
}));

export { router as membershipsRouter };
