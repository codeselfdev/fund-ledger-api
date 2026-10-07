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
import { findActiveUsersByEmail, findActiveUsersByMobile, googlePlaceholderMobile, issueLoginSession, issueOtp, resolveFirebaseIdentity, verifyOtp } from "./auth.service.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { buildGoogleAuthorizationUrl, handleGoogleOAuthCallback, resolveGoogleAuthTicket, sendOAuthResult, signupWithGoogleTicket } from "./google-oauth.service.js";
import { evaluateSubscription } from "../../core/subscription/subscription.service.js";
import { summarizeOnboardingForClient } from "../../core/onboarding/onboarding.service.js";
import { hasDelegatedPayerAccess } from "../../core/security/deposit-delegate.service.js";

const router = Router();

const otpRequestSchema = z.object({
  mobile: z.string().min(6)
});

const loginSchema = z
  .object({
    mobile: z.string().min(6).optional(),
    otp: z.string().min(4).optional(),
    id_token: z.string().min(20).optional(),
    tenant_slug: z.string().min(3).optional(),
    project_id: z.string().optional()
  })
  .refine((value) => Boolean(value.id_token || value.mobile), {
    message: "id_token or mobile is required"
  });

const switchProjectSchema = z.object({
  project_id: z.string().min(1)
});

const googleCompleteSchema = z.object({
  ticket: z.string().min(8)
});

const googleSignupSchema = z.object({
  ticket: z.string().min(8),
  org_name: z.string().min(2).max(120),
  owner_name: z.string().min(2).max(120).optional(),
  owner_mobile: z.string().min(6).max(32).optional(),
  project_name: z.string().min(2).max(120).optional(),
  total_shares: z.number().int().positive().max(100_000).optional()
});

router.get("/google", asyncHandler(async (req, res) => {
  const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
  try {
    return res.redirect(buildGoogleAuthorizationUrl(req));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google sign-in failed.";
    return sendOAuthResult(res, redirectUri, { error: message });
  }
}));

router.get("/google/callback", asyncHandler(async (req, res) => {
  return handleGoogleOAuthCallback(req, res);
}));

router.post("/google/complete", validateBody(googleCompleteSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof googleCompleteSchema>;
  return ok(res, await resolveGoogleAuthTicket(body.ticket));
}));

router.post("/google/signup", validateBody(googleSignupSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof googleSignupSchema>;
  const payload = await signupWithGoogleTicket({
    ticket: body.ticket,
    orgName: body.org_name,
    ownerName: body.owner_name,
    ownerMobile: body.owner_mobile,
    projectName: body.project_name,
    totalShares: body.total_shares
  });
  return ok(res, payload);
}));

router.post("/otp/request", validateBody(otpRequestSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof otpRequestSchema>;
  const users = await findActiveUsersByMobile(body.mobile);
  if (users.length === 0) throw badRequest("No active user found for this mobile number");
  const user = users[0];

  const { code: devCode, emailed } = await issueOtp(body.mobile, user.email);

  return ok(res, {
    sent: true,
    emailed,
    ...(process.env.NODE_ENV === "production" ? {} : { dev_code: devCode })
  });
}));

router.post("/login", validateBody(loginSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof loginSchema>;

  let users;
  if (body.id_token) {
    let identity;
    try {
      identity = await resolveFirebaseIdentity(body.id_token);
    } catch (error) {
      throw unauthorized(error instanceof Error ? error.message : "Invalid Firebase ID token");
    }

    if (identity.provider === "google") {
      users = await findActiveUsersByEmail(identity.email!, body.tenant_slug);
      if (users.length === 0) {
        const email = identity.email!.trim().toLowerCase();
        const name = identity.name || email.split("@")[0];
        return ok(res, {
          kind: "signup",
          signup_needed: true,
          googleSignupNeeded: true,
          provider: "google",
          email,
          name,
          googleIdentity: {
            email,
            name,
            uid: identity.uid
          },
          tenantSlug: body.tenant_slug,
          signupFlow: {
            next_endpoint: "/v1/onboarding/signup",
            onboarding_entrypoint: "organization",
            prefill: {
              owner_email: email,
              owner_name: name
            },
            id_token: body.id_token
          }
        });
      }
    } else {
      users = await findActiveUsersByMobile(identity.phoneNumber!, body.tenant_slug);
    }
  } else {
    const mobile = body.mobile?.trim() ?? "";
    const validOtp = await verifyOtp(mobile, body.otp);
    if (!validOtp) throw unauthorized("Invalid or expired OTP");
    users = await findActiveUsersByMobile(mobile, body.tenant_slug);
  }

  if (users.length === 0) throw unauthorized("Invalid login");
  if (users.length > 1 && !body.tenant_slug) {
    throw badRequest("tenant_slug is required when this login belongs to multiple tenants");
  }

  const user = users[0];
  if (!user) throw unauthorized("Invalid login");
  const payload = await issueLoginSession(user, body.project_id);

  await writeAudit({
    tenantId: user.tenantId,
    projectId: payload.active_project_id,
    actorUserId: user.id,
    action: "auth.login",
    entityType: "session",
    after: { user_id: user.id }
  });

  return ok(res, payload);
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
    auth.projectId ? hasDelegatedPayerAccess(user.tenant.contact, auth.projectId, auth.userId) : false
  );
  const onboardingProject = user.memberships.find((membership) => membership.projectId === auth.projectId)?.project
    ?? user.memberships[0]?.project
    ?? null;
  const onboarding = summarizeOnboardingForClient(onboardingProgress, onboardingProject);
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
