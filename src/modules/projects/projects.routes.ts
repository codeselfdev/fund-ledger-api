import { saveSubscription } from "../../core/subscription/subscription.repository.js";
import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { projectApprovalFlowRouter } from './project-approval-flow.routes.js';
import { seedMemberDocumentTitles, withDefaultMemberDocumentTitles } from "../../core/projects/member-document-titles.js";
import { settingsSchema as instituteSettingsSchema, settings as instituteSettings } from '../institute/institute.policy.js';
import { assertProjectCapacity } from "../../core/subscription/quota.service.js";
import { constructionMenus } from "../construction/construction.menu.js";
import { billingMenus } from "../billing/billing.menu.js";
import { readObject, StorageObjectNotFoundError } from "../../core/storage/object-storage.service.js";
import { randomUUID } from "node:crypto";
import { linkedIdentityUsers } from "../../core/security/linked-identity.js";
import { createOneMonthTrial } from "../../core/subscription/subscription.service.js";
import { Router } from "express";
import { z } from "zod";
import { Role } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { authenticate, authenticateAccount, requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireOrganizationOwnership } from "../../core/security/organization-access.js";
import { requireActiveSubscription } from "../../core/security/subscription.middleware.js";
import { summarizeProjectMemberships } from "../../core/security/project-access.js";
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

import { projectTypeSchema, portalSettingsSchema, normalizePortalSettings } from "../../core/projects/project-settings.js";

const projectsRouter = Router();
const invitationsRouter = Router();
projectsRouter.use(authenticateAccount);
projectsRouter.use("/:id/approval-flow", requireActiveSubscription, validateParams(idParamSchema), projectApprovalFlowRouter);

const createProjectSchema = z.object({
  project_type: projectTypeSchema.default("fund_shares"),
  institute_settings: instituteSettingsSchema.optional(),
  owner_is_member: z.boolean().default(false),
  organization_name: z.string().trim().min(2).max(150),
  name: z.string().min(2),
  total_shares: z.number().int().positive().optional(),
  penalty_policy: optionalPenaltyPolicySchema,
  address: z.string().optional()
});

const requireFundShares = <T extends z.AnyZodObject>(schema: T) => schema.refine(
  value => value.project_type !== "fund_shares" || value.total_shares !== undefined,
  { message: "Total shares are required for Fund / Shares projects", path: ["total_shares"] }
);

const updateProjectSchema = z.object({
  institute_settings: instituteSettingsSchema.optional(),
  portal_settings: portalSettingsSchema.optional(),
  name: z.string().min(2).optional(),
  total_shares: z.number().int().positive().optional(),
  logo_file_id: z.string().min(1).nullable().optional(),
  penalty_policy: optionalPenaltyPolicySchema,
  address: z.string().optional()
}).refine((value) => (
  value.institute_settings !== undefined
  || value.portal_settings !== undefined
  || value.name !== undefined
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
  const identity = auth.impersonation ? { userIds: [auth.userId] } : await linkedIdentityUsers(auth.userId);
  const memberships = await prisma.projectMembership.findMany({
    where: {
      ...(auth.impersonation ? { tenantId: auth.tenantId } : {}),
      userId: { in: identity.userIds },
      isActive: true,
      project: { isActive: true }
    },
    include: { project: true, member: true, customRole: true },
    orderBy: { createdAt: "asc" }
  });

  const choices = summarizeProjectMemberships(memberships).map((access) => {
    const project = memberships.find(row => row.projectId === access.project_id)!.project;
    return {
      ...access, ...(project.projectType === "billing" ? { billing_menus: billingMenus(access.roles) } : {}), ...(project.projectType === "construction" ? { construction_menus: constructionMenus(access.roles) } : {}), name: project.name, address: project.address, total_shares: project.totalShares,
      institute_settings: project.projectType === "institute" ? instituteSettings(project.instituteSettings) : undefined,
    portal_settings: normalizePortalSettings(project.portalSettings, project.projectType),
      logo_file_id: project.logoFileId, logo_url: project.logoFileId ? `/v1/projects/${project.id}/logo` : null,
      is_active: project.isActive,
      is_current: access.project_id === (req.header("x-project-id") ?? auth.sessionProjectId)
    };
  });
  return ok(res, choices);
}));

projectsRouter.post("/owned-organization", requireRoles("any"), validateBody(requireFundShares(createProjectSchema)), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = req.body as z.infer<typeof createProjectSchema>;
  const actor = await tenantAccounts(prisma).findUniqueOrThrow({
    where: { id: auth.userId },
    select: { id: true, name: true, mobile: true, email: true, userId: true, deviceId: true }
  });

  const identity = await linkedIdentityUsers(actor.id);
  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({  data: {
      name: body.organization_name, slug: `org-${randomUUID()}`, currency: "BDT",
      contact: withDefaultMemberDocumentTitles({}, body.project_type)
    } });
    await saveSubscription(tx, tenant.id, createOneMonthTrial(), { event: 'trial_started', actorUserId: auth.userId });
    const owner = await tenantAccounts(tx).create({ data: { tenantId: tenant.id, name: actor.name,
      mobile: actor.mobile, email: actor.email, userId: identity.rootId, deviceId: actor.deviceId } });
    const createdProject = await tx.project.create({
      data: {
        tenantId: tenant.id,
        name: body.name,
        totalShares: body.total_shares ?? 1,
        projectType: body.project_type,
        ...(body.project_type === "institute" ? { instituteSettings: instituteSettings(body.institute_settings) } : {}),
        penaltyPolicy: body.penalty_policy,
        address: body.address
      }
    });

    await tx.projectMembership.create({
      data: {
        tenantId: tenant.id,
        projectId: createdProject.id,
        userId: owner.id,
        role: "owner"
      }
    });

    const member = body.owner_is_member && ["fund_shares", "construction"].includes(body.project_type) ? await ensureUserProjectMember(tx, {
      tenantId: tenant.id,
      projectId: createdProject.id,
      user: owner,
      defaultShares: 1
    }) : null;

    const account = await tx.account.create({
      data: {
        tenantId: tenant.id,
        projectId: createdProject.id,
        name: "Cash",
        type: "cash",
        isDefault: true
      }
    });

    await tx.onboardingProgress.create({ data: { tenantId: tenant.id, projectId: createdProject.id,
      status: "completed", organizationStepStatus: "done", accountantStepStatus: "skipped",
      accountsStepStatus: "done", shareholdersStepStatus: "skipped",
      incomeApprovalFlow: "accountant_only", expenseApprovalFlow: "accountant_only", completedAt: new Date() } });
    return { tenant, owner, project: createdProject, account, memberId: member?.memberId ?? null };
  });

  await writeAudit({
    tenantId: result.tenant.id,
    projectId: result.project.id,
    actorUserId: result.owner.id,
    action: "project.created",
    entityType: "project",
    entityId: result.project.id,
    after: result.project
  });

  await writeAudit({
    tenantId: result.tenant.id,
    projectId: result.project.id,
    actorUserId: result.owner.id,
    action: "account.created",
    entityType: "account",
    entityId: result.account.id,
    after: result.account
  });

  return created(res, {
    tenant_id: result.tenant.id,
    project_id: result.project.id,
    name: result.project.name,
    address: result.project.address,
    total_shares: result.project.totalShares,
    role: "owner",
    roles: body.owner_is_member && result.memberId ? ["owner", "member"] : ["owner"],
    member_id: result.memberId,
    is_active: result.project.isActive,
    project_type: result.project.projectType,
    ...(result.project.projectType === "billing" ? { billing_menus: billingMenus(["admin"]) } : {}),
    ...(result.project.projectType === "construction" ? { construction_menus: constructionMenus(["admin"]) } : {}),
    institute_settings: result.project.projectType === "institute" ? instituteSettings(result.project.instituteSettings) : undefined,
    portal_settings: normalizePortalSettings(result.project.portalSettings, result.project.projectType),
    logo_file_id: result.project.logoFileId,
    logo_url: logoUrl(result.project.logoFileId)
  });
}));

projectsRouter.post("/", authenticate, requireActiveSubscription, requireProject, requireOrganizationOwnership, validateBody(requireFundShares(createProjectSchema.omit({ organization_name: true }))), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = req.body as z.infer<typeof createProjectSchema>;
  await assertProjectCapacity(auth.tenantId);
  const actor = await tenantAccounts(prisma).findUniqueOrThrow({
    where: { id: auth.userId },
    select: { id: true, name: true, mobile: true, email: true }
  });

  const result = await prisma.$transaction(async (tx) => {
    await seedMemberDocumentTitles(tx, auth.tenantId, body.project_type);
    const createdProject = await tx.project.create({
      data: {
        tenantId: auth.tenantId,
        name: body.name,
        totalShares: body.total_shares ?? 1,
        projectType: body.project_type,
        ...(body.project_type === "institute" ? { instituteSettings: instituteSettings(body.institute_settings) } : {}),
        penaltyPolicy: body.penalty_policy,
        address: body.address
      }
    });

    await tx.projectMembership.create({
      data: {
        tenantId: auth.tenantId,
        projectId: createdProject.id,
        userId: auth.userId,
        role: "admin"
      }
    });

    const member = body.owner_is_member && ["fund_shares", "construction"].includes(body.project_type) ? await ensureUserProjectMember(tx, {
      tenantId: auth.tenantId,
      projectId: createdProject.id,
      user: actor,
      defaultShares: 1
    }) : null;

    const account = await tx.account.create({
      data: {
        tenantId: auth.tenantId,
        projectId: createdProject.id,
        name: "Cash",
        type: "cash",
        isDefault: true
      }
    });

    return { project: createdProject, account, memberId: member?.memberId ?? null };
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
    role: "admin",
    roles: body.owner_is_member && result.memberId ? ["admin", "member"] : ["admin"],
    member_id: result.memberId,
    is_active: result.project.isActive,
    project_type: result.project.projectType,
    ...(result.project.projectType === "billing" ? { billing_menus: billingMenus(["admin"]) } : {}),
    ...(result.project.projectType === "construction" ? { construction_menus: constructionMenus(["admin"]) } : {}),
    institute_settings: result.project.projectType === "institute" ? instituteSettings(result.project.instituteSettings) : undefined,
    portal_settings: normalizePortalSettings(result.project.portalSettings, result.project.projectType),
    logo_file_id: result.project.logoFileId,
    logo_url: logoUrl(result.project.logoFileId)
  });
}));

// Discovery can display a granted project's current logo without handing out an operational session.
projectsRouter.get("/:id/logo", validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const identity = auth.impersonation ? { userIds: [auth.userId] } : await linkedIdentityUsers(auth.userId);
  const access = await prisma.projectMembership.findFirst({ where: {
    ...(auth.impersonation ? { tenantId: auth.tenantId } : {}),
    projectId: req.params.id, userId: { in: identity.userIds }, isActive: true, project: { isActive: true }
  } });
  if (!access) throw forbidden();
  const project = await prisma.project.findFirst({ where: { id: access.projectId, tenantId: access.tenantId, isActive: true } });
  if (!project?.logoFileId) throw notFound("Project logo not found");
  const upload = await prisma.upload.findFirst({ where: { id: project.logoFileId, tenantId: project.tenantId,
    projectId: project.id, purpose: "project_logo", mimeType: { startsWith: "image/" } } });
  if (!upload) throw notFound("Project logo not found");
  try {
    const object = await readObject(upload.storageKey);
    res.setHeader("Content-Type", upload.mimeType);
    res.setHeader("Cache-Control", auth.impersonation ? "no-store" : "private, max-age=300");
    return res.send(object.buffer);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) throw notFound("Project logo not found");
    throw error;
  }
}));

projectsRouter.get("/:id", requireActiveSubscription, validateParams(idParamSchema), asyncHandler(async (req, res) => {
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
    project_type: project.projectType,
    ...(project.projectType === "billing" ? { billing_menus: billingMenus(roles) } : {}),
    ...(project.projectType === "construction" ? { construction_menus: constructionMenus(roles) } : {}),
    institute_settings: project.projectType === "institute" ? instituteSettings(project.instituteSettings) : undefined,
    portal_settings: normalizePortalSettings(project.portalSettings, project.projectType),
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

projectsRouter.patch("/:id", requireActiveSubscription, validateParams(idParamSchema), validateBody(updateProjectSchema), asyncHandler(async (req, res) => {
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
  if (body.institute_settings && before.projectType !== "institute") throw badRequest("Institute settings belong to institute projects");

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
      address: body.address,
      instituteSettings: body.institute_settings,
      portalSettings: body.portal_settings
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
    project_type: project.projectType,
    ...(project.projectType === "billing" ? { billing_menus: billingMenus([access.role]) } : {}),
    ...(project.projectType === "construction" ? { construction_menus: constructionMenus([access.role]) } : {}),
    institute_settings: project.projectType === "institute" ? instituteSettings(project.instituteSettings) : undefined,
    portal_settings: normalizePortalSettings(project.portalSettings, project.projectType),
    logo_file_id: project.logoFileId,
    logo_url: logoUrl(project.logoFileId),
    penalty_policy: project.penaltyPolicy
  });
}));

invitationsRouter.post("/", requireProject, requireRoles("owner", "approver", "admin"), validateBody(invitationSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof invitationSchema>;
  const projectId = body.project_id ?? auth.projectId;
  if (projectId !== auth.projectId) {
    const access = await prisma.projectMembership.findFirst({
      where: { tenantId: auth.tenantId, userId: auth.userId, projectId, isActive: true,
        role: { in: ["owner", "admin", "approver"] } }
    });
    if (!access) throw forbidden("No invitation permission for the requested project");
  }

  const project = await prisma.project.findFirstOrThrow({
    where: { id: projectId, tenantId: auth.tenantId }
  });
  const { invitation, user } = await prisma.$transaction(async (tx) => {
    const user = await tenantAccounts(tx).upsert({
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

    if (body.role === "member") {
      await ensureUserProjectMember(tx, {
        tenantId: auth.tenantId,
        projectId: project.id,
        user: { id: user.id,
          name: user.name,
          mobile: user.mobile,
          email: user.email
        },
        defaultShares: 0
      });
    } else {
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
          memberId: null
        },
        create: {
          tenantId: auth.tenantId,
          projectId: project.id,
          userId: user.id,
          role: body.role,
          memberId: null
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
