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
import {
  PROJECT_SIGN_IN_OPTIONS,
  buildProjectInvitationLink,
  buildProjectInvitationSummary,
  resolveAppDownloadLink,
  sendProjectInvitationEmail
} from "../../core/invitations/project-invitation.service.js";

const projectsRouter = Router();
const invitationsRouter = Router();

const createProjectSchema = z.object({
  name: z.string().min(2),
  total_shares: z.number().int().positive(),
  penalty_policy: optionalPenaltyPolicySchema,
  address: z.string().optional()
});

const updateProjectSchema = z.object({
  name: z.string().min(2).optional(),
  total_shares: z.number().int().positive().optional(),
  logo_file_id: z.string().min(1).nullable().optional(),
  penalty_policy: optionalPenaltyPolicySchema,
  address: z.string().optional()
}).refine((value) => (
  value.name !== undefined
  || value.total_shares !== undefined
  || value.logo_file_id !== undefined
  || value.penalty_policy !== undefined
  || value.address !== undefined
), {
  message: "At least one field is required"
});

const invitationSchema = z.object({
  mobile: z.string().min(6),
  name: z.string().min(1),
  email: z.string().email().optional(),
  role: z.nativeEnum(Role),
  project_id: z.string().optional()
});

function logoUrl(logoFileId: string | null) {
  return logoFileId ? `/v1/uploads/${logoFileId}/view` : null;
}

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
    address: membership.project.address,
    total_shares: membership.project.totalShares,
    logo_file_id: membership.project.logoFileId,
    logo_url: logoUrl(membership.project.logoFileId),
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

  const result = await prisma.$transaction(async (tx) => {
    const createdProject = await tx.project.create({
      data: {
        tenantId: auth.tenantId,
        name: body.name,
        totalShares: body.total_shares,
        penaltyPolicy: body.penalty_policy,
        address: body.address
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

    const account = await tx.account.create({
      data: {
        tenantId: auth.tenantId,
        projectId: createdProject.id,
        name: "Cash",
        type: "cash",
        isDefault: true
      }
    });

    return { project: createdProject, account };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: result.project.id,
    actorUserId: auth.userId,
    action: "project.created",
    entityType: "project",
    entityId: result.project.id,
    after: result.project
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: result.project.id,
    actorUserId: auth.userId,
    action: "account.created",
    entityType: "account",
    entityId: result.account.id,
    after: result.account
  });

  return created(res, {
    project_id: result.project.id,
    name: result.project.name,
    address: result.project.address,
    total_shares: result.project.totalShares,
    logo_file_id: result.project.logoFileId,
    logo_url: logoUrl(result.project.logoFileId)
  });
}));

projectsRouter.get("/:id", validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const access = await prisma.projectMembership.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: id,
      userId: auth.userId,
      isActive: true
    }
  });
  if (access.length === 0) throw forbidden();

  const project = await prisma.project.findFirst({
    where: { id, tenantId: auth.tenantId }
  });
  if (!project) throw notFound("Project not found");

  const activeShares = await prisma.member.aggregate({
    where: {
      tenantId: auth.tenantId,
      projectId: id,
      status: "active"
    },
    _sum: { shares: true }
  });
  const assignedShares = activeShares._sum.shares ?? 0;
  const roles = Array.from(new Set(access.map((membership) => membership.role)));
  const primaryAccess = access.find((membership) => membership.role !== "member") ?? access[0];

  return ok(res, {
    project_id: project.id,
    name: project.name,
    address: project.address,
    total_shares: project.totalShares,
    assigned_shares: assignedShares,
    remaining_shares: Math.max(0, project.totalShares - assignedShares),
    penalty_policy: project.penaltyPolicy,
    is_active: project.isActive,
    role: primaryAccess.role,
    roles,
    member_id: access.find((membership) => membership.memberId)?.memberId ?? null,
    logo_file_id: project.logoFileId,
    logo_url: logoUrl(project.logoFileId),
    can_edit: roles.includes("owner") || roles.includes("admin")
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

  if (body.logo_file_id) {
    const logoUpload = await prisma.upload.findFirst({
      where: {
        id: body.logo_file_id,
        tenantId: auth.tenantId,
        projectId: id,
        mimeType: { startsWith: "image/" }
      },
      select: { id: true }
    });
    if (!logoUpload) {
      throw badRequest("Choose an image uploaded for this project", {
        logo: "The selected project logo is invalid"
      });
    }
  }

  const project = await prisma.project.update({
    where: { id },
    data: {
      name: body.name,
      totalShares: body.total_shares,
      logoFileId: body.logo_file_id,
      penaltyPolicy: body.penalty_policy,
      address: body.address
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
    address: project.address,
    total_shares: project.totalShares,
    logo_file_id: project.logoFileId,
    logo_url: logoUrl(project.logoFileId),
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
      update: {
        name: body.name,
        ...(body.email ? { email: body.email } : {})
      },
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
  const invitationLink = buildProjectInvitationLink(req, {
    tenantId: auth.tenantId,
    projectId: project.id,
    role: body.role,
    mobile: user.mobile,
    email: user.email,
    invitationId: invitation.id
  });
  const appDownloadLink = resolveAppDownloadLink(invitationLink);
  let invitationEmailSent = false;
  if (user.email) {
    try {
      invitationEmailSent = await sendProjectInvitationEmail({
        to: user.email,
        inviteeName: user.name,
        projectName: project.name,
        tenantId: auth.tenantId,
        projectId: project.id,
        role: body.role,
        mobile: user.mobile,
        email: user.email,
        invitationId: invitation.id,
        invitationLink,
        appDownloadLink,
        otpEmailed: otp.emailed
      });
    } catch (error) {
      console.error("[mailer] failed to send project invitation email", error);
    }
  }

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
    },
    invitationLink,
    invitation_link: invitationLink,
    appDownloadLink,
    app_download_link: appDownloadLink,
    invitationEmail: {
      sent: invitationEmailSent,
      to: user.email
    },
    signInOptions: PROJECT_SIGN_IN_OPTIONS,
    onboardingSummary: buildProjectInvitationSummary({
      inviteeName: user.name,
      projectName: project.name,
      role: body.role
    })
  });
}));

export { invitationsRouter, projectsRouter };
