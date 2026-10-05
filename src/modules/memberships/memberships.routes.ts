import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { ensureUserProjectMember } from "../../core/security/member-link.service.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { issueOtp } from "../auth/auth.service.js";
import {
  buildProjectInvitationLink,
  buildProjectInvitationSummary,
  projectSignInOptions,
  resolveAppDownloadLink,
  sendProjectInvitationEmail
} from "../../core/invitations/project-invitation.service.js";

const router = Router();

const updateMembershipSchema = z.object({
  role: z.nativeEnum(Role).optional(),
  is_active: z.boolean().optional()
});

const createMembershipSchema = z
  .object({
    user_id: z.string().min(1).optional(),
    mobile: z.string().min(6).optional(),
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    role: z.nativeEnum(Role)
  })
  .refine((v) => v.user_id != null || v.mobile != null || v.email != null, {
    message: "user_id, mobile, or email is required",
    path: ["user_id"]
  });

function isSyntheticMobile(mobile: string) {
  return mobile.startsWith("g:") || mobile.startsWith("e:");
}

function defaultShareSeedForRole(role: Role) {
  return role === "owner" || role === "admin" || role === "accountant" ? 1 : 0;
}

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
    user: {
      ...membership.user,
      mobile: isSyntheticMobile(membership.user.mobile) ? null : membership.user.mobile
    }
  })));
}));

router.post("/", requireProject, requireRoles("owner", "admin"), validateBody(createMembershipSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createMembershipSchema>;

  const project = await prisma.project.findFirstOrThrow({
    where: { id: auth.projectId, tenantId: auth.tenantId }
  });

  const result = await prisma.$transaction(async (tx) => {
    const normalizedEmail = body.email?.trim().toLowerCase();
    const matchingUsers = body.user_id
      ? await tx.user.findMany({
          where: { id: body.user_id, tenantId: auth.tenantId, isActive: true }
        })
      : await tx.user.findMany({
          where: {
            tenantId: auth.tenantId,
            isActive: true,
            OR: [
              ...(body.mobile ? [{ mobile: body.mobile }] : []),
              ...(normalizedEmail ? [{ email: { equals: normalizedEmail, mode: "insensitive" as const } }] : [])
            ]
          },
          take: 2
        });
    if (matchingUsers.length > 1) {
      throw conflict("The supplied mobile and email belong to different users");
    }
    let user = matchingUsers[0] ?? null;
    let userCreated = false;

    if (!user && body.user_id) {
      throw notFound("No active user found for the given identity");
    }
    if (!user) {
      if (!body.mobile) {
        throw notFound("No active user was found for this email. Add the member first or provide mobile and name.");
      }
      if (!body.name) {
        throw badRequest("name is required when creating a new user");
      }
      user = await tx.user.create({
        data: {
          tenantId: auth.tenantId,
          name: body.name,
          mobile: body.mobile!,
          email: normalizedEmail
        }
      });
      userCreated = true;
    } else if (body.name || body.email) {
      user = await tx.user.update({
        where: { id: user.id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(normalizedEmail ? { email: normalizedEmail } : {})
        }
      });
    }

    const existing = await tx.projectMembership.findFirst({
      where: { projectId: auth.projectId, userId: user.id, role: body.role }
    });
    if (existing?.isActive) {
      throw conflict("This user already has that role on the project");
    }

    const ensured = await ensureUserProjectMember(tx, {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email
      },
      defaultShares: defaultShareSeedForRole(body.role)
    });

    if (existing) {
      const membership = await tx.projectMembership.update({
        where: { id: existing.id },
        data: { isActive: true, memberId: ensured.memberId }
      });
      return { user, membership, userCreated, reactivated: true, before: existing };
    }

    if (body.role === "member") {
      const membership = await tx.projectMembership.findFirstOrThrow({
        where: {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          userId: user.id,
          role: "member"
        }
      });
      return { user, membership, userCreated, reactivated: false, before: null };
    }

    const membership = await tx.projectMembership.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        userId: user.id,
        memberId: ensured.memberId,
        role: body.role
      }
    });

    return { user, membership, userCreated, reactivated: false, before: null };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: result.reactivated ? "membership.reactivated" : "membership.created",
    entityType: "project_membership",
    entityId: result.membership.id,
    before: result.before,
    after: result.membership
  });

  const phoneMobile = isSyntheticMobile(result.user.mobile) ? null : result.user.mobile;
  const otp = phoneMobile
    ? await issueOtp(phoneMobile, result.user.email)
    : { code: null, emailed: false };
  const membershipLink = buildProjectInvitationLink(req, {
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    role: result.membership.role,
    mobile: phoneMobile,
    email: result.user.email,
    memberId: result.membership.memberId ?? undefined
  });
  const appDownloadLink = resolveAppDownloadLink(membershipLink);
  let invitationEmailSent = false;
  if (result.user.email) {
    try {
      invitationEmailSent = await sendProjectInvitationEmail({
        to: result.user.email,
        inviteeName: result.user.name,
        projectName: project.name,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        role: result.membership.role,
        mobile: phoneMobile,
        email: result.user.email,
        memberId: result.membership.memberId ?? undefined,
        invitationLink: membershipLink,
        appDownloadLink,
        otpEmailed: otp.emailed
      });
    } catch (error) {
      console.error("[mailer] failed to send membership invitation email", error);
    }
  }

  return created(res, {
    id: result.membership.id,
    role: result.membership.role,
    is_active: result.membership.isActive,
    user_id: result.user.id,
    user_created: result.userCreated,
    user: { id: result.user.id, name: result.user.name, mobile: phoneMobile, email: result.user.email },
    otp: {
      sent: phoneMobile != null,
      emailed: otp.emailed,
      ...(process.env.NODE_ENV === "production" || !otp.code ? {} : { dev_code: otp.code })
    },
    membershipLink,
    membership_link: membershipLink,
    appDownloadLink,
    app_download_link: appDownloadLink,
    invitationEmail: {
      sent: invitationEmailSent,
      to: result.user.email
    },
    signInOptions: projectSignInOptions(phoneMobile != null),
    onboardingSummary: buildProjectInvitationSummary({
      inviteeName: result.user.name,
      projectName: project.name,
      role: result.membership.role,
      phoneOtpAvailable: phoneMobile != null
    })
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

  const nextRole = body.role ?? before.role;
  const nextIsActive = body.is_active ?? before.isActive;
  const removingMemberRole = before.role === "member" && (nextRole !== "member" || !nextIsActive);
  if (removingMemberRole) {
    const otherActiveRoles = await prisma.projectMembership.count({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        userId: before.userId,
        isActive: true,
        id: { not: id }
      }
    });
    if (otherActiveRoles > 0) {
      throw badRequest("A user with project access must keep an active member role");
    }
  }

  const membership = await prisma.$transaction(async (tx) => {
    let memberId: string | undefined;

    if (nextIsActive) {
      const targetUser = await tx.user.findFirstOrThrow({
        where: { id: before.userId, tenantId: auth.tenantId, isActive: true },
        select: { id: true, name: true, mobile: true, email: true }
      });
      const ensured = await ensureUserProjectMember(tx, {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        user: targetUser,
        defaultShares: defaultShareSeedForRole(nextRole)
      });
      memberId = ensured.memberId;
    }

    return tx.projectMembership.update({
      where: { id },
      data: {
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.is_active !== undefined ? { isActive: body.is_active } : {}),
        ...(memberId ? { memberId } : {})
      }
    });
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
