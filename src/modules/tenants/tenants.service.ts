import { assertSignupMobileAvailable, signupMobile } from "../auth/signup-contact.js";
import { withAvailableOrganizationSlug } from "../../core/onboarding/available-slug.js";
import { Prisma, TenantPlan, ProjectType } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { createProvisionedOnboardingSeed } from "../../core/onboarding/onboarding.service.js";
import { createTrialSubscription, createOneMonthTrial, DEFAULT_TRIAL_DAYS } from "../../core/subscription/subscription.service.js";
import { ensureUserProjectMember } from "../../core/security/member-link.service.js";
import { createSessionToken } from "../auth/auth.service.js";

// Re-export so callers can keep one import path if needed
export { DEFAULT_TRIAL_DAYS } from "../../core/subscription/subscription.service.js";

export type ProvisionTenantInput = {
  name: string;
  slug: string;
  currency?: string;
  adminName: string;
  adminMobile: string;
  adminEmail?: string;
  projectName?: string;
  projectTotalShares?: number;
  projectType?: ProjectType;
  ownerIsMember?: boolean;
  plan?: TenantPlan;
  trialDays?: number;
  penaltyPolicy?: Prisma.InputJsonValue;
  source?: "provisioning" | "self_signup" | "cli";
};

export type ProvisionTenantResult = {
  tenantId: string;
  defaultProjectId: string;
  ownerUserId: string;
  ownerName: string;
  ownerMobile: string;
  ownerEmail: string | null;
  tenantSlug: string;
  tenantName: string;
  projectName: string;
  token: string;
};

function jsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
  if (input.source !== "self_signup") return provisionTenantOnce(input);
  // Both mobile/OTP signup and the Google ticket flow allocate slugs here.
  // A collision rolls the transaction back before another candidate is tried.
  return withAvailableOrganizationSlug(input.slug, slug => provisionTenantOnce({ ...input, slug }));
}

async function provisionTenantOnce(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
  const currency = (input.currency ?? "BDT").toUpperCase();
  const plan = input.plan ?? TenantPlan.free;
  const projectName = input.projectName?.trim() || "My Project";
  const projectTotalShares = input.projectTotalShares ?? 1;
  const source = input.source ?? "provisioning";

  const existingSlug = await prisma.tenant.findUnique({ where: { slug: input.slug } });
  if (existingSlug) {
    throw Object.assign(new Error("Tenant slug already exists"), { code: "SLUG_TAKEN" });
  }
  const result = await prisma.$transaction(async (tx) => {
    const mobile = signupMobile(input.adminMobile);
    const email = input.adminEmail?.trim().toLowerCase();
    // Lock contact identities before checking, so concurrent signups cannot both pass.
    for (const scope of [`signup:mobile:${mobile}`, ...(email ? [`signup:email:${email}`] : [])].sort()) {
      // The lock returns void, which Prisma cannot decode without a supported cast.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))::text`;
    }
    await assertSignupMobileAvailable(mobile, tx);
    if (email && await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } })) {
      throw Object.assign(new Error("Email already registered"), { code: "EMAIL_TAKEN" });
    }
    const contact = jsonValue({ subscription: input.trialDays === undefined ? createOneMonthTrial() : createTrialSubscription(input.trialDays) });
    const onboarding = createProvisionedOnboardingSeed({ source });

    const tenant = await tx.tenant.create({
      data: {
        name: input.name,
        slug: input.slug,
        currency,
        plan,
        contact,
        penaltyPolicy: input.penaltyPolicy
      }
    });

    const project = await tx.project.create({
      data: {
        tenantId: tenant.id,
        name: projectName,
        totalShares: projectTotalShares,
        projectType: input.projectType ?? "fund_shares",
        penaltyPolicy: input.penaltyPolicy
      }
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        name: input.adminName,
        mobile,
        email
      }
    });

    const ensuredMember = input.ownerIsMember && (!input.projectType || ["fund_shares", "construction"].includes(input.projectType)) ? await ensureUserProjectMember(tx, {
      tenantId: tenant.id,
      projectId: project.id,
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email
      },
      defaultShares: 1
    }) : null;

    await tx.projectMembership.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        userId: user.id,
        role: "owner",
        memberId: ensuredMember?.memberId ?? null
      }
    });

    if (source !== "self_signup") {
      await tx.account.create({
        data: {
          tenantId: tenant.id,
          projectId: project.id,
          name: "Cash",
          type: "cash",
          isDefault: true
        }
      });
    }

    await tx.onboardingProgress.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        status: onboarding.status,
        organizationStepStatus: onboarding.organizationStepStatus,
        accountantStepStatus: onboarding.accountantStepStatus,
        accountsStepStatus: onboarding.accountsStepStatus,
        shareholdersStepStatus: input.projectType && input.projectType !== "fund_shares" ? "skipped" : onboarding.shareholdersStepStatus,
        incomeApprovalFlow: onboarding.incomeApprovalFlow,
        expenseApprovalFlow: onboarding.expenseApprovalFlow,
        completedAt: onboarding.completedAt
      }
    });

    return { tenant, project, user };
  });

  const { token } = await createSessionToken({
    tenantId: result.tenant.id,
    userId: result.user.id,
    activeProjectId: result.project.id,
    recordLogin: source === "self_signup"
  });

  await writeAudit({
    tenantId: result.tenant.id,
    projectId: result.project.id,
    actorUserId: result.user.id,
    action: source === "self_signup" ? "tenant.self_signup" : "tenant.provisioned",
    entityType: "tenant",
    entityId: result.tenant.id,
    after: {
      tenant_id: result.tenant.id,
      default_project_id: result.project.id,
      owner_user_id: result.user.id,
      source
    }
  });

  return {
    tenantId: result.tenant.id,
    defaultProjectId: result.project.id,
    ownerUserId: result.user.id,
    ownerName: result.user.name,
    ownerMobile: result.user.mobile,
    ownerEmail: result.user.email,
    tenantSlug: result.tenant.slug,
    tenantName: result.tenant.name,
    projectName: result.project.name,
    token
  };
}
