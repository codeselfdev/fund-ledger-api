import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireAuthContext, requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { optionalPenaltyPolicySchema } from "../../core/validation/common.schemas.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { ensureUserProjectMember } from "../../core/security/member-link.service.js";
import { issueOtp } from "../auth/auth.service.js";

const projectsRouter = Router();
const invitationsRouter = Router();

const createProjectSchema = z.object({
  name: z.string().min(2),
  total_shares: z.number().int().positive(),
  penalty_policy: optionalPenaltyPolicySchema
});

const updateProjectSchema = z.object({
  name: z.string().min(2).optional(),
  total_shares: z.number().int().positive().optional(),
  penalty_policy: optionalPenaltyPolicySchema
}).refine((value) => value.name !== undefined || value.total_shares !== undefined || value.penalty_policy !== undefined, {
  message: "At least one field is required"
});

const invitationSchema = z.object({
  mobile: z.string().min(6),
  name: z.string().min(1),
  email: z.string().email().optional(),
  role: z.nativeEnum(Role),
  project_id: z.string().optional()
});

projectsRouter.get("/", requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const memberships = await prisma.projectMembership.findMany({
    where: {
      tenantId: auth.tenantId,
      userId: auth.userId,
      isActive: true
    },
    include: { project: true, member: true },
    orderBy: { createdAt: "asc" }
  });

  return ok(res, memberships.map((membership) => ({
    project_id: membership.projectId,
    name: membership.project.name,
    total_shares: membership.project.totalShares,
    role: membership.role,
    member_id: membership.memberId,
    is_active: membership.project.isActive,
    is_current: membership.projectId === auth.projectId
  })));
}));

projectsRouter.post("/", requireProject, requireRoles("owner", "admin"), validateBody(createProjectSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createProjectSchema>;
  const actor = await prisma.user.findUniqueOrThrow({
    where: { id: auth.userId },
    select: { id: true, name: true, mobile: true, email: true }
  });

  const project = await prisma.$transaction(async (tx) => {
    const createdProject = await tx.project.create({
      data: {
        tenantId: auth.tenantId,
        name: body.name,
        totalShares: body.total_shares,
        penaltyPolicy: body.penalty_policy
      }
    });

    await tx.projectMembership.create({
      data: {
        tenantId: auth.tenantId,
        projectId: createdProject.id,
        userId: auth.userId,
        role: "owner"
      }
    });

    await ensureUserProjectMember(tx, {
      tenantId: auth.tenantId,
      projectId: createdProject.id,
      user: actor,
      defaultShares: 1
    });

    await tx.account.create({
      data: {
        tenantId: auth.tenantId,
        projectId: createdProject.id,
        name: "Cash",
        type: "cash",
        isDefault: true
      }
    });

    return createdProject;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: project.id,
    actorUserId: auth.userId,
    action: "project.created",
    entityType: "project",
    entityId: project.id,
    after: project
  });

  return created(res, {
    project_id: project.id,
    name: project.name,
    total_shares: project.totalShares
  });
}));

projectsRouter.patch("/:id", validateParams(idParamSchema), validateBody(updateProjectSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof updateProjectSchema>;

  const access = await prisma.projectMembership.findFirst({
    where: {
      tenantId: auth.tenantId,
      projectId: id,
      userId: auth.userId,
      isActive: true,
      role: { in: ["owner", "admin"] }
    }
  });
  if (!access) throw forbidden();

  const before = await prisma.project.findFirst({
    where: { id, tenantId: auth.tenantId }
  });
  if (!before) throw notFound("Project not found");

  if (body.total_shares !== undefined) {
    const activeShares = await prisma.member.aggregate({
      where: {
        tenantId: auth.tenantId,
        projectId: id,
        status: "active"
      },
      _sum: { shares: true }
    });

    const assignedShares = activeShares._sum.shares ?? 0;
    if (body.total_shares < assignedShares) {
      throw badRequest("Total shares cannot be less than active member shares", {
        assigned_shares: assignedShares,
        requested_total_shares: body.total_shares
      });
    }
  }

  const project = await prisma.project.update({
    where: { id },
    data: {
      name: body.name,
      totalShares: body.total_shares,
      penaltyPolicy: body.penalty_policy
    }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: id,
    actorUserId: auth.userId,
    action: "project.updated",
    entityType: "project",
    entityId: id,
    before,
    after: project
  });

  return ok(res, {
    project_id: project.id,
    name: project.name,
    total_shares: project.totalShares,
    penalty_policy: project.penaltyPolicy
  });
}));

invitationsRouter.post("/", requireProject, requireRoles("owner", "approver", "admin"), validateBody(invitationSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof invitationSchema>;
  const projectId = body.project_id ?? auth.projectId;

  const project = await prisma.project.findFirstOrThrow({
    where: { id: projectId, tenantId: auth.tenantId }
  });
  const shouldSeedShareholder = body.role === "owner" || body.role === "admin" || body.role === "accountant";

  const { invitation, user } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: {
        tenantId_mobile: {
          tenantId: auth.tenantId,
          mobile: body.mobile
        }
      },
      update: body.email ? { email: body.email } : {},
      create: {
        tenantId: auth.tenantId,
        name: body.name,
        mobile: body.mobile,
        email: body.email
      }
    });

    const ensuredMember = await ensureUserProjectMember(tx, {
      tenantId: auth.tenantId,
      projectId: project.id,
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email
      },
      defaultShares: shouldSeedShareholder ? 1 : 0
    });

    if (body.role !== "member") {
      await tx.projectMembership.upsert({
        where: {
          projectId_userId_role: {
            projectId: project.id,
            userId: user.id,
            role: body.role
          }
        },
        update: {
          isActive: true,
          memberId: ensuredMember.memberId
        },
        create: {
          tenantId: auth.tenantId,
          projectId: project.id,
          userId: user.id,
          role: body.role,
          memberId: ensuredMember.memberId
        }
      });
    }

    const invitation = await tx.invitation.create({
      data: {
        tenantId: auth.tenantId,
        projectId: project.id,
        mobile: body.mobile,
        role: body.role,
        invitedById: auth.userId,
        status: "accepted",
        acceptedAt: new Date()
      }
    });

    return { invitation, user };
  });

  const otp = await issueOtp(user.mobile, user.email);

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: project.id,
    actorUserId: auth.userId,
    memberIds: [],
    type: "invitation.added",
    title: "Project access granted",
    body: `You were added to ${project.name} as ${body.role}.`,
    entityType: "invitation",
    entityId: invitation.id
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: project.id,
    actorUserId: auth.userId,
    action: "invitation.created",
    entityType: "invitation",
    entityId: invitation.id,
    after: invitation
  });

  return created(res, {
    ...invitation,
    otp: {
      sent: true,
      emailed: otp.emailed,
      ...(process.env.NODE_ENV === "production" ? {} : { dev_code: otp.code })
    }
  });
}));

export { invitationsRouter, projectsRouter };
