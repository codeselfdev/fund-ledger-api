import { Prisma, TenantPlan } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { createInitialOnboardingState, withOnboardingState } from "../../core/onboarding/onboarding.service.js";
import { createTrialSubscription, DEFAULT_TRIAL_DAYS } from "../../core/subscription/subscription.service.js";
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
  const currency = (input.currency ?? "BDT").toUpperCase();
  const plan = input.plan ?? TenantPlan.free;
  const trialDays = input.trialDays ?? DEFAULT_TRIAL_DAYS;
  const projectName = input.projectName?.trim() || "My Project";
  const source = input.source ?? "provisioning";

  const existingSlug = await prisma.tenant.findUnique({ where: { slug: input.slug } });
  if (existingSlug) {
    throw Object.assign(new Error("Tenant slug already exists"), { code: "SLUG_TAKEN" });
  }

  const result = await prisma.$transaction(async (tx) => {
    const onboarding = createInitialOnboardingState();
    const contact = withOnboardingState(
      { subscription: createTrialSubscription(trialDays) },
      onboarding
    );

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
        totalShares: 1,
        penaltyPolicy: input.penaltyPolicy
      }
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        name: input.adminName,
        mobile: input.adminMobile,
        email: input.adminEmail
      }
    });

    await tx.projectMembership.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        userId: user.id,
        role: "owner"
      }
    });

    await tx.account.create({
      data: {
        tenantId: tenant.id,
        projectId: project.id,
        name: "Cash",
        type: "cash",
        isDefault: true
      }
    });

    return { tenant, project, user };
  });

  const { token } = await createSessionToken({
    tenantId: result.tenant.id,
    userId: result.user.id,
    activeProjectId: result.project.id
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
