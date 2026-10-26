import { userProfileRouter } from '../profile/user-profile.routes.js';
import { assertSignupMobileAvailable } from "./signup-contact.js";
import { verifiedSignup } from "./signup-identity.js";
import { linkedIdentityUsers } from "../../core/security/linked-identity.js";
import { getActiveUserForLogin } from "./auth.service.js";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requestEmailOtp, requestLoginOtp } from "./otp-delivery.service.js";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, unauthorized } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { authenticate, authenticateAccount, requireRoles } from "../../core/security/auth.middleware.js";
import { requireAuthContext } from "../../core/security/auth.context.js";
import { hashToken } from "../../core/security/jwt.js";
import { validateBody } from "../../core/validation/validate.js";
import { switchImpersonationProject, stopImpersonation } from "./impersonation.service.js";
import { findActiveUsersByEmail, findActiveUsersByMobile, issueLoginSession, resolveFirebaseIdentity, verifyOtp } from "./auth.service.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { buildGoogleAuthorizationUrl, handleGoogleOAuthCallback, resolveGoogleAuthTicket, sendOAuthResult, signupWithGoogleTicket } from "./google-oauth.service.js";
import { evaluateSubscription } from "../../core/subscription/subscription.service.js";
import { summarizeOnboardingForClient } from "../../core/onboarding/onboarding.service.js";
import { hasDelegatedPayerAccess } from "../../core/security/deposit-delegate.service.js";
import { summarizeProjectMemberships } from "../../core/security/project-access.js";

import { completeAccountSelection, createAccountSelection } from "./account-selection.service.js";

const router = Router();
router.use('/profile', authenticateAccount, userProfileRouter);

function isEmailOtpAmbiguous(users: Array<{ id: string; email: string | null }>) {
  return users.length > 1 && new Set(users.map(user => user.email?.trim().toLowerCase() ?? user.id)).size > 1;
}

const otpRequestSchema = z.object({
  mobile: z.string().regex(/^\+[1-9]\d{6,14}$/, "Enter a mobile number with country code").optional(),
  email: z.string().trim().email().max(254).optional(),
  recaptcha_token: z.string().min(1).max(10000).optional(),
  signup: z.boolean().optional()
}).refine(value => Boolean(value.email) !== Boolean(value.mobile), { message: "Enter either email or mobile" });

const loginSchema = z
  .object({
    mobile: z.string().min(6).optional(),
    email: z.string().trim().email().max(254).optional(),
    otp: z.string().min(4).optional(),
    id_token: z.string().min(20).optional(),
    tenant_slug: z.string().min(3).optional(),
    project_id: z.string().optional()
  })
  .refine((value) => Boolean(value.id_token || value.mobile || value.email) && !(value.mobile && value.email), {
    message: "Enter an email, mobile, or verified identity"
  });

const switchProjectSchema = z.object({
  project_id: z.string().min(1)
});

const accountSelectionSchema = z.object({
  ticket: z.string().min(8),
  account_id: z.string().min(1)
});

const googleCompleteSchema = z.object({
  ticket: z.string().min(8)
});

const googleSignupSchema = z.object({
  project_type: z.enum(["fund_shares", "accounting", "billing", "construction", "payroll_pf"]).default("fund_shares"),
  owner_is_member: z.boolean().default(false),
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

router.post("/select-account", validateBody(accountSelectionSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof accountSelectionSchema>;
  const payload = await completeAccountSelection(body.ticket, body.account_id);
  await writeAudit({
    tenantId: payload.tenant.id, projectId: payload.active_project_id, actorUserId: payload.user.id,
    action: "auth.login", entityType: "session", after: { user_id: payload.user.id }
  });
  return ok(res, payload);
}));

router.post("/google/signup", validateBody(googleSignupSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof googleSignupSchema>;
  const payload = await signupWithGoogleTicket({
    ticket: body.ticket,
    orgName: body.org_name,
    ownerName: body.owner_name,
    ownerMobile: body.owner_mobile,
    projectName: body.project_name,
    totalShares: body.total_shares,
    projectType: body.project_type,
    ownerIsMember: body.owner_is_member
  });
  return ok(res, payload);
}));

router.post("/signup/check-mobile", rateLimit({ windowMs: 60_000, limit: 15 }), validateBody(z.object({ mobile: z.string().regex(/^\+[1-9]\d{6,14}$/) })), asyncHandler(async (req, res) => {
  await assertSignupMobileAvailable(req.body.mobile);
  return ok(res, { available: true });
}));

router.post("/otp/request", rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false }), validateBody(otpRequestSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof otpRequestSchema>;
  if (body.email) return ok(res, await requestEmailOtp(body.email));
  const mobile = body.mobile!;
  if (body.signup) await assertSignupMobileAvailable(mobile);
  const users = await findActiveUsersByMobile(mobile, undefined, false);
  return ok(res, await requestLoginOtp({ mobile, users, recaptchaToken: body.recaptcha_token, signup: body.signup }));
}));

router.post("/login", rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }), validateBody(loginSchema), asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof loginSchema>;

  let users;
  let verifiedEmail: string | null = null;
  if (body.id_token) {
    let identity;
    try {
      identity = await resolveFirebaseIdentity(body.id_token);
    } catch (error) {
      throw unauthorized(error instanceof Error ? error.message : "Invalid Firebase ID token");
    }

    if (identity.provider === "google") {
      if (identity.emailVerified === true) verifiedEmail = identity.email?.trim().toLowerCase() ?? null;
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
      const mobile = identity.phoneNumber!;
      const allUsers = await findActiveUsersByMobile(mobile);
      if (!allUsers.length) return ok(res, verifiedSignup({ provider: "mobile", mobile }));
      users = body.tenant_slug ? await findActiveUsersByMobile(mobile, body.tenant_slug) : allUsers;
    }
  } else if (body.email) {
    const email = body.email.trim().toLowerCase();
    if (!await verifyOtp(`email:${email}`, body.otp)) throw unauthorized("Invalid or expired OTP");
    verifiedEmail = email;
    const allUsers = await findActiveUsersByEmail(email);
    if (!allUsers.length) return ok(res, verifiedSignup({ provider: "email", email }));
    users = body.tenant_slug ? await findActiveUsersByEmail(email, body.tenant_slug) : allUsers;
  } else {
    const mobile = body.mobile?.trim() ?? "";
    const validOtp = await verifyOtp(mobile, body.otp);
    if (!validOtp) throw unauthorized("Invalid or expired OTP");
    // Also refuse OTPs issued before the contact became shared, even when the
    // caller specifies a tenant slug. Verified Firebase phone login uses SMS.
    const mobileUsers = await findActiveUsersByMobile(mobile);
    if (isEmailOtpAmbiguous(mobileUsers)) {
      throw badRequest("This mobile is shared by multiple accounts. Continue with Google or use SMS verification.");
    }
    users = body.tenant_slug ? await findActiveUsersByMobile(mobile, body.tenant_slug) : mobileUsers;
  }

  if (users.length === 0) throw unauthorized("Invalid login");
  if (users.length > 1) {
    return ok(res, createAccountSelection(users, body.project_id, verifiedEmail));
  }

  const user = users[0];
  if (!user) throw unauthorized("Invalid login");
  const payload = await issueLoginSession(user, body.project_id, true, verifiedEmail);

  await writeAudit({
    tenantId: payload.tenant.id,
    projectId: payload.active_project_id,
    actorUserId: payload.user.id,
    action: "auth.login",
    entityType: "session",
    after: { user_id: payload.user.id }
  });

  return ok(res, payload);
}));

router.post("/switch-project", authenticateAccount, requireRoles("any"), validateBody(switchProjectSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = req.body as z.infer<typeof switchProjectSchema>;

  if (auth.impersonation) return ok(res, await switchImpersonationProject(req, body.project_id));
  const identity = await linkedIdentityUsers(auth.userId);
  const membership = await prisma.projectMembership.findFirst({
    where: {
      userId: { in: identity.userIds },
      projectId: body.project_id,
      isActive: true,
      project: { isActive: true }
    }
  });
  if (!membership) throw forbidden("No active role for requested project");

  if (membership.tenantId !== auth.tenantId || membership.userId !== auth.userId) {
    const target = await getActiveUserForLogin(membership.userId);
    const login = await issueLoginSession(target, body.project_id, false);
    await writeAudit({ tenantId: login.tenant.id, projectId: body.project_id, actorUserId: login.user.id,
      action: "auth.switch_project", entityType: "project", entityId: body.project_id });
    return ok(res, { ...login, identity_root_id: identity.rootId });
  }

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
          where: { isActive: true, project: { isActive: true } },
          include: { project: true, member: true, customRole: true }
        }
      }
    }),
    prisma.onboardingProgress.findUnique({
      where: { tenantId: auth.tenantId },
      select: {
        projectId: true,
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
  const identity = auth.impersonation ? { rootId: auth.userId, userIds: [auth.userId] } : await linkedIdentityUsers(auth.userId);
  const allMemberships = await prisma.projectMembership.findMany({ where: { ...(auth.impersonation ? { tenantId: auth.tenantId } : {}), userId: { in: identity.userIds }, isActive: true, project: { isActive: true } }, include: { project: true, customRole: true } });
  const canPayForMembersByRole = auth.roles.includes("admin") || auth.roles.includes("accountant") || auth.roles.includes("cashier");
  const canPayForMembers = canPayForMembersByRole || (
    auth.projectId ? hasDelegatedPayerAccess(user.tenant.contact, auth.projectId, auth.userId) : false
  );
  const onboardingProject = user.memberships.find((membership) => membership.projectId === auth.projectId)?.project
    ?? user.memberships[0]?.project
    ?? null;
  const onboarding = summarizeOnboardingForClient(
    onboardingProgress?.projectId === auth.projectId ? onboardingProgress : null, onboardingProject
  );
  const subscription = evaluateSubscription(user.tenant.contact);

  return ok(res, {
    ...(auth.impersonation ? { impersonation: { read_only: true, expires_at: auth.impersonation.expiresAt, target_email: user.email } } : {}),
    user: { id: user.id, name: user.name, mobile: user.mobile, email: user.email },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
    active_project_id: auth.projectId,
    roles: auth.roles,
    can_pay_for_members: canPayForMembers,
    member_id: auth.memberId,
    identity_root_id: identity.rootId,
    memberships: summarizeProjectMemberships(allMemberships),
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

router.post("/logout", authenticateAccount, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  if (auth.impersonation) return ok(res, await stopImpersonation(req));
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

  await prisma.session.updateMany({ where: { impersonatorSessionId: auth.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  return ok(res, { revoked: true });
}));

export { router as authRouter };
