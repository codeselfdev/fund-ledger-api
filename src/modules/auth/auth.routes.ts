import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, unauthorized } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { authenticate, requireRoles } from "../../core/security/auth.middleware.js";
import { requireAuthContext } from "../../core/security/auth.context.js";
import { hashToken } from "../../core/security/jwt.js";
import { validateBody } from "../../core/validation/validate.js";
import { createSessionToken, issueOtp, verifyOtp } from "./auth.service.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { evaluateSubscription } from "../../core/subscription/subscription.service.js";
import { summarizeOnboarding } from "../../core/onboarding/onboarding.service.js";
import { canUserPayOnBehalf } from "../../core/security/deposit-delegate.service.js";

const router = Router();

const otpRequestSchema = z.object({
  mobile: z.string().min(6)
});

const loginSchema = z.object({
  mobile: z.string().min(6),
  otp: z.string().min(4).optional(),
  tenant_slug: z.string().min(3).optional(),
  project_id: z.string().optional()
});

const switchProjectSchema = z.object({
  project_id: z.string().min(1)
});

router.post("/otp/request", validateBody(otpRequestSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof otpRequestSchema>;
  const user = await prisma.user.findFirst({ where: { mobile: body.mobile, isActive: true } });
  if (!user) throw badRequest("No active user found for this mobile number");

  const { code: devCode, emailed } = await issueOtp(body.mobile, user.email);

  return ok(res, {
    sent: true,
    emailed,
    ...(process.env.NODE_ENV === "production" ? {} : { dev_code: devCode })
  });
}));

router.post("/login", validateBody(loginSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof loginSchema>;
  const validOtp = await verifyOtp(body.mobile, body.otp);
  if (!validOtp) throw unauthorized("Invalid or expired OTP");

  const users = await prisma.user.findMany({
    where: {
      mobile: body.mobile,
      isActive: true,
      ...(body.tenant_slug ? { tenant: { slug: body.tenant_slug } } : {})
    },
    include: {
      memberships: {
        where: { isActive: true },
        include: { project: true, member: true }
      },
      tenant: true
    }
  });

  if (users.length === 0) throw unauthorized("Invalid login");
  if (users.length > 1 && !body.tenant_slug) {
    throw badRequest("tenant_slug is required when a mobile belongs to multiple tenants");
  }

  const user = users[0];
  const activeMembership = body.project_id
    ? user.memberships.find((membership) => membership.projectId === body.project_id)
    : user.memberships[0];

  if (!activeMembership) throw forbidden("No active membership for requested project");

  const { token } = await createSessionToken({
    tenantId: user.tenantId,
    userId: user.id,
    activeProjectId: activeMembership.projectId
  });

  await writeAudit({
    tenantId: user.tenantId,
    projectId: activeMembership.projectId,
    actorUserId: user.id,
    action: "auth.login",
    entityType: "session",
    after: { user_id: user.id }
  });

  return ok(res, {
    token,
    user: { id: user.id, name: user.name, mobile: user.mobile },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
    active_project_id: activeMembership.projectId,
    memberships: user.memberships.map((membership) => ({
      project_id: membership.projectId,
      project_name: membership.project.name,
      role: membership.role,
      member_id: membership.memberId
    }))
  });
}));

router.post("/switch-project", authenticate, requireRoles("any"), validateBody(switchProjectSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = req.body as z.infer<typeof switchProjectSchema>;

  const membership = await prisma.projectMembership.findFirst({
    where: {
      tenantId: auth.tenantId,
      userId: auth.userId,
      projectId: body.project_id,
      isActive: true
    }
  });
  if (!membership) throw forbidden("No active role for requested project");

  await prisma.session.update({
    where: { id: auth.sessionId },
    data: { activeProjectId: body.project_id }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: body.project_id,
    actorUserId: auth.userId,
    action: "auth.switch_project",
    entityType: "project",
    entityId: body.project_id
  });

  return ok(res, { active_project_id: body.project_id });
}));

router.get("/me", authenticate, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const [user, onboardingProgress] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      include: {
        tenant: true,
        memberships: {
          where: { isActive: true },
          include: { project: true, member: true }
        }
      }
    }),
    prisma.onboardingProgress.findUnique({
      where: { tenantId: auth.tenantId },
      select: {
        status: true,
        organizationStepStatus: true,
        accountantStepStatus: true,
        accountsStepStatus: true,
        shareholdersStepStatus: true,
        incomeApprovalFlow: true,
        expenseApprovalFlow: true,
        accountantUserId: true,
        completedAt: true
      }
    })
  ]);
  const canPayForMembersByRole = auth.roles.includes("admin") || auth.roles.includes("accountant") || auth.roles.includes("cashier");
  const canPayForMembers = canPayForMembersByRole || (
    auth.projectId ? canUserPayOnBehalf(user.tenant.contact, auth.projectId, auth.userId) : false
  );
  const onboarding = summarizeOnboarding(onboardingProgress);
  const subscription = evaluateSubscription(user.tenant.contact);

  return ok(res, {
    user: { id: user.id, name: user.name, mobile: user.mobile, email: user.email },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
    active_project_id: auth.projectId,
    roles: auth.roles,
    can_pay_for_members: canPayForMembers,
    member_id: auth.memberId,
    memberships: user.memberships.map((membership) => ({
      project_id: membership.projectId,
      project_name: membership.project.name,
      role: membership.role,
      member_id: membership.memberId
    })),
    onboarding,
    subscription: {
      status: subscription.status,
      has_access: subscription.has_access,
      trial_ends_at: subscription.trial_ends_at,
      days_left: subscription.days_left,
      renewal_term_years: subscription.renewal_term_years
    }
  });
}));

router.post("/logout", authenticate, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const token = req.header("authorization")?.slice("Bearer ".length).trim();

  await prisma.session.updateMany({
    where: {
      id: auth.sessionId,
      tokenHash: token ? hashToken(token) : undefined,
      revokedAt: null
    },
    data: { revokedAt: new Date() }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "auth.logout",
    entityType: "session",
    entityId: auth.sessionId
  });

  return ok(res, { revoked: true });
}));

export { router as authRouter };
