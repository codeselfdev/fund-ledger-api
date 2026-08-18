import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { Role } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import {
  completeOnboarding,
  getOnboardingState,
  markOnboardingStep,
  slugifyOrgName,
  summarizeOnboarding,
  type OnboardingStepId
} from "../../core/onboarding/onboarding.service.js";
import { authenticate, requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireAuthContext, requireProjectContext } from "../../core/security/auth.context.js";
import { evaluateSubscription } from "../../core/subscription/subscription.service.js";
import { validateBody } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { issueOtp } from "../auth/auth.service.js";
import { provisionTenant } from "../tenants/tenants.service.js";

const router = Router();

const signupRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: "RATE_LIMITED", message: "Too many signup attempts. Try again later." } }
});

const signupSchema = z.object({
  org_name: z.string().min(2).max(120),
  slug: z.string().min(3).max(48).regex(/^[a-z0-9-]+$/).optional(),
  name: z.string().min(2).max(120),
  mobile: z.string().min(6).max(32),
  email: z.string().email().optional(),
  currency: z.string().length(3).default("BDT"),
  project_name: z.string().min(2).max(120).optional()
});

const projectSetupSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  total_shares: z.number().int().positive().max(100_000).optional()
}).refine((value) => value.name !== undefined || value.total_shares !== undefined, {
  message: "Provide name and/or total_shares"
});

const inviteItemSchema = z.object({
  name: z.string().min(1).max(120),
  mobile: z.string().min(6).max(32),
  email: z.string().email().optional(),
  role: z.nativeEnum(Role).default("member")
});

const invitesSchema = z.object({
  invites: z.array(inviteItemSchema).min(1).max(25)
});

const skipSchema = z.object({
  step: z.enum(["project", "invites"]).optional()
});

async function loadOnboardingBundle(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { id: true, name: true, slug: true, contact: true }
  });
  const state = getOnboardingState(tenant.contact);
  const summary = summarizeOnboarding(state);
  const subscription = evaluateSubscription(tenant.contact);
  return { tenant, state, summary, subscription };
}

function assertOwnerOnboarding(roles: string[]) {
  if (!roles.includes("owner")) throw forbidden("Only the owner can manage onboarding");
}

router.post("/signup", signupRateLimit, validateBody(signupSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof signupSchema>;
  const slug = body.slug ?? slugifyOrgName(body.org_name);

  let result;
  try {
    result = await provisionTenant({
      name: body.org_name,
      slug,
      currency: body.currency,
      adminName: body.name,
      adminMobile: body.mobile,
      adminEmail: body.email,
      projectName: body.project_name ?? "My Project",
      source: "self_signup"
    });
  } catch (error) {
    if ((error as { code?: string }).code === "SLUG_TAKEN") {
      throw conflict("This organization slug is already taken. Choose another slug.");
    }
    throw error;
  }

  const bundle = await loadOnboardingBundle(result.tenantId);

  return created(res, {
    token: result.token,
    user: {
      id: result.ownerUserId,
      name: result.ownerName,
      mobile: result.ownerMobile,
      email: result.ownerEmail
    },
    tenant: {
      id: result.tenantId,
      name: result.tenantName,
      slug: result.tenantSlug
    },
    project: {
      id: result.defaultProjectId,
      name: result.projectName
    },
    active_project_id: result.defaultProjectId,
    subscription: {
      status: bundle.subscription.status,
      has_access: bundle.subscription.has_access,
      trial_ends_at: bundle.subscription.trial_ends_at,
      days_left: bundle.subscription.days_left,
      renewal_term_years: bundle.subscription.renewal_term_years
    },
    onboarding: bundle.summary
  });
}));

router.get("/status", authenticate, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const bundle = await loadOnboardingBundle(auth.tenantId);
  return ok(res, {
    tenant_id: bundle.tenant.id,
    onboarding: bundle.summary,
    subscription: {
      status: bundle.subscription.status,
      has_access: bundle.subscription.has_access,
      trial_ends_at: bundle.subscription.trial_ends_at,
      days_left: bundle.subscription.days_left,
      renewal_term_years: bundle.subscription.renewal_term_years
    }
  });
}));

router.post(
  "/project",
  authenticate,
  requireProject,
  requireRoles("owner"),
  validateBody(projectSetupSchema),
  asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    assertOwnerOnboarding(auth.roles);
    const body = req.body as z.infer<typeof projectSetupSchema>;

    const project = await prisma.project.findFirst({
      where: { id: auth.projectId, tenantId: auth.tenantId }
    });
    if (!project) throw badRequest("Active project not found");

    if (body.total_shares !== undefined) {
      const activeShares = await prisma.member.aggregate({
        where: {
          tenantId: auth.tenantId,
          projectId: project.id,
          status: "active"
        },
        _sum: { shares: true }
      });
      const assigned = activeShares._sum.shares ?? 0;
      if (body.total_shares < assigned) {
        throw badRequest("Total shares cannot be less than active member shares", {
          assigned_shares: assigned
        });
      }
    }

    const updatedProject = await prisma.project.update({
      where: { id: project.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.total_shares !== undefined ? { totalShares: body.total_shares } : {})
      }
    });

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      select: { contact: true }
    });
    const next = markOnboardingStep(tenant.contact, "project", "done");
    await prisma.tenant.update({
      where: { id: auth.tenantId },
      data: { contact: next.contact }
    });

    await writeAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      action: "onboarding.project_setup",
      entityType: "project",
      entityId: updatedProject.id,
      after: { name: updatedProject.name, total_shares: updatedProject.totalShares }
    });

    return ok(res, {
      project: {
        id: updatedProject.id,
        name: updatedProject.name,
        total_shares: updatedProject.totalShares
      },
      onboarding: next.summary
    });
  })
);

router.post(
  "/invites",
  authenticate,
  requireProject,
  requireRoles("owner"),
  validateBody(invitesSchema),
  asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    assertOwnerOnboarding(auth.roles);
    const body = req.body as z.infer<typeof invitesSchema>;

    const project = await prisma.project.findFirstOrThrow({
      where: { id: auth.projectId!, tenantId: auth.tenantId }
    });

    const invited = [];
    for (const item of body.invites) {
      const { invitation, user } = await prisma.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: {
            tenantId_mobile: {
              tenantId: auth.tenantId,
              mobile: item.mobile
            }
          },
          update: {
            ...(item.email ? { email: item.email } : {}),
            name: item.name
          },
          create: {
            tenantId: auth.tenantId,
            name: item.name,
            mobile: item.mobile,
            email: item.email
          }
        });

        await tx.projectMembership.upsert({
          where: {
            projectId_userId_role: {
              projectId: project.id,
              userId: user.id,
              role: item.role
            }
          },
          update: { isActive: true },
          create: {
            tenantId: auth.tenantId,
            projectId: project.id,
            userId: user.id,
            role: item.role
          }
        });

        const invitation = await tx.invitation.create({
          data: {
            tenantId: auth.tenantId,
            projectId: project.id,
            mobile: item.mobile,
            role: item.role,
            invitedById: auth.userId,
            status: "accepted",
            acceptedAt: new Date()
          }
        });

        return { invitation, user };
      });

      const otp = await issueOtp(user.mobile, user.email);
      invited.push({
        invitation_id: invitation.id,
        user_id: user.id,
        name: user.name,
        mobile: user.mobile,
        role: item.role,
        otp: {
          sent: true,
          emailed: otp.emailed,
          ...(process.env.NODE_ENV === "production" ? {} : { dev_code: otp.code })
        }
      });
    }

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      select: { contact: true }
    });
    const next = markOnboardingStep(tenant.contact, "invites", "done");
    await prisma.tenant.update({
      where: { id: auth.tenantId },
      data: { contact: next.contact }
    });

    await writeAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      action: "onboarding.invites_sent",
      entityType: "invitation",
      after: { count: invited.length }
    });

    return created(res, {
      invited,
      onboarding: next.summary
    });
  })
);

router.post(
  "/skip",
  authenticate,
  requireProject,
  requireRoles("owner"),
  validateBody(skipSchema),
  asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    assertOwnerOnboarding(auth.roles);
    const body = req.body as z.infer<typeof skipSchema>;

    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      select: { contact: true }
    });
    const summary = summarizeOnboarding(getOnboardingState(tenant.contact));
    const step = (body.step ?? summary.current_step) as OnboardingStepId | null;
    if (!step || step === "signup") {
      throw badRequest("No skippable onboarding step available");
    }
    if (step !== "project" && step !== "invites") {
      throw badRequest("Only project and invites steps can be skipped");
    }

    const next = markOnboardingStep(tenant.contact, step, "skipped");
    await prisma.tenant.update({
      where: { id: auth.tenantId },
      data: { contact: next.contact }
    });

    await writeAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      action: "onboarding.step_skipped",
      entityType: "tenant",
      entityId: auth.tenantId,
      after: { step }
    });

    return ok(res, { skipped: step, onboarding: next.summary });
  })
);

router.post("/complete", authenticate, requireProject, requireRoles("owner"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  assertOwnerOnboarding(auth.roles);

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });
  const next = completeOnboarding(tenant.contact);
  await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: next.contact }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "onboarding.completed",
    entityType: "tenant",
    entityId: auth.tenantId,
    after: next.onboarding
  });

  return ok(res, { onboarding: next.summary });
}));

// Prevent unmatched /v1/onboarding/* from falling through to global auth middleware.
router.use((_req, _res, next) => next(notFound("Onboarding endpoint not found")));

export { router as onboardingRouter };
