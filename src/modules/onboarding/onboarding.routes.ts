import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { Role } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import {
  recomputeOnboardingStatus,
  slugifyOrgName,
  summarizeOnboarding
} from "../../core/onboarding/onboarding.service.js";
import { authenticate, requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireAuthContext, requireProjectContext } from "../../core/security/auth.context.js";
import { ensureUserProjectMember } from "../../core/security/member-link.service.js";
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
  currency: z.string().length(3).default("BDT"),
  project_name: z.string().min(2).max(120),
  total_shares: z.number().int().positive().max(100_000),
  owner_name: z.string().min(2).max(120),
  owner_mobile: z.string().min(6).max(32),
  owner_email: z.string().email().optional()
});

const accountingSchema = z.object({
  accountant: z.object({
    name: z.string().min(2).max(120),
    mobile: z.string().min(6).max(32),
    email: z.string().email().optional()
  }),
  approval_flow: z.object({
    income: z.enum(["accountant_only", "accountant_and_approver"]),
    expense: z.enum(["accountant_only", "accountant_and_approver"])
  })
});

const accountsSetupSchema = z.object({
  accounts: z.array(z.object({
    name: z.string().min(2).max(64),
    type: z.enum(["bank", "cash"]),
    is_default: z.boolean().optional(),
    opening_balance: z.number().int().min(0).optional()
  })).min(1).max(25)
});

const shareholderSchema = z.object({
  name: z.string().min(2),
  mobile: z.string().min(6),
  shares: z.number().int().positive(),
  address: z.string().optional(),
  email: z.string().email().optional()
});

const shareholdersSetupSchema = z.object({
  members: z.array(shareholderSchema).min(1).max(300)
});

const skipSchema = z.object({
  step: z.enum(["shareholders"]).optional()
});

const onboardingProgressSelect = {
  tenantId: true,
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
} as const;

async function getOnboardingProgress(tenantId: string) {
  return prisma.onboardingProgress.findUnique({
    where: { tenantId },
    select: onboardingProgressSelect
  });
}

async function loadOnboardingBundle(tenantId: string) {
  const [tenant, progress] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, name: true, slug: true, contact: true }
    }),
    getOnboardingProgress(tenantId)
  ]);

  return {
    tenant,
    progress,
    onboarding: summarizeOnboarding(progress),
    subscription: evaluateSubscription(tenant.contact)
  };
}

function assertOwnerOnboarding(roles: Role[]) {
  if (!roles.includes("owner")) throw forbidden("Only the owner can manage onboarding");
}

function assertOnboardingProject(activeProjectId: string, onboardingProjectId: string) {
  if (activeProjectId !== onboardingProjectId) {
    throw badRequest("Use the onboarding project in X-Project-Id before completing setup", {
      required_project_id: onboardingProjectId
    });
  }
}

function assertStepCompleted(stepStatus: "pending" | "done" | "skipped", stepName: string) {
  if (stepStatus === "pending") {
    throw badRequest(`${stepName} step is required before this action`);
  }
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
      projectName: body.project_name,
      projectTotalShares: body.total_shares,
      adminName: body.owner_name,
      adminMobile: body.owner_mobile,
      adminEmail: body.owner_email,
      source: "self_signup"
    });
  } catch (error) {
    if ((error as { code?: string }).code === "SLUG_TAKEN") {
      throw conflict("This organization slug is already taken. Choose another slug.");
    }
    throw error;
  }

  const bundle = await loadOnboardingBundle(result.tenantId);
  const ownerMember = await prisma.member.findFirst({
    where: {
      tenantId: result.tenantId,
      projectId: result.defaultProjectId,
      userId: result.ownerUserId
    },
    select: { id: true, shares: true }
  });

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
    default_shareholder: {
      seeded: Boolean(ownerMember),
      member_id: ownerMember?.id ?? null,
      shares: ownerMember?.shares ?? 0
    },
    onboarding: bundle.onboarding,
    subscription: {
      status: bundle.subscription.status,
      has_access: bundle.subscription.has_access,
      trial_ends_at: bundle.subscription.trial_ends_at,
      days_left: bundle.subscription.days_left,
      renewal_term_years: bundle.subscription.renewal_term_years
    }
  });
}));

router.get("/status", authenticate, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const bundle = await loadOnboardingBundle(auth.tenantId);

  let checks: {
    project_id: string | null;
    accountant_set: boolean;
    accountant_member_linked: boolean;
    owner_member_id: string | null;
    accountant_member_id: string | null;
    accounts_count: number;
    shareholders_count: number;
    shares_assigned: number;
    shares_target: number | null;
  } = {
    project_id: bundle.progress?.projectId ?? null,
    accountant_set: false,
    accountant_member_linked: false,
    owner_member_id: null,
    accountant_member_id: null,
    accounts_count: 0,
    shareholders_count: 0,
    shares_assigned: 0,
    shares_target: null
  };

  if (bundle.progress) {
    const [ownerMembership, accountantMembership, accountCount, membersAggregate, membersCount, project] = await Promise.all([
      prisma.projectMembership.findFirst({
        where: {
          tenantId: auth.tenantId,
          projectId: bundle.progress.projectId,
          role: "owner",
          isActive: true
        },
        orderBy: { createdAt: "asc" },
        select: { memberId: true }
      }),
      bundle.progress.accountantUserId
        ? prisma.projectMembership.findFirst({
          where: {
            tenantId: auth.tenantId,
            projectId: bundle.progress.projectId,
            userId: bundle.progress.accountantUserId,
            role: "accountant",
            isActive: true
          },
          select: { id: true, memberId: true }
        })
        : Promise.resolve(null),
      prisma.account.count({
        where: { tenantId: auth.tenantId, projectId: bundle.progress.projectId }
      }),
      prisma.member.aggregate({
        where: { tenantId: auth.tenantId, projectId: bundle.progress.projectId, status: "active" },
        _sum: { shares: true }
      }),
      prisma.member.count({
        where: { tenantId: auth.tenantId, projectId: bundle.progress.projectId, status: "active" }
      }),
      prisma.project.findFirst({
        where: { tenantId: auth.tenantId, id: bundle.progress.projectId },
        select: { totalShares: true }
      })
    ]);

    checks = {
      project_id: bundle.progress.projectId,
      accountant_set: Boolean(accountantMembership),
      accountant_member_linked: Boolean(accountantMembership?.memberId),
      owner_member_id: ownerMembership?.memberId ?? null,
      accountant_member_id: accountantMembership?.memberId ?? null,
      accounts_count: accountCount,
      shareholders_count: membersCount,
      shares_assigned: membersAggregate._sum.shares ?? 0,
      shares_target: project?.totalShares ?? null
    };
  }

  return ok(res, {
    tenant_id: bundle.tenant.id,
    onboarding: bundle.onboarding,
    subscription: {
      status: bundle.subscription.status,
      has_access: bundle.subscription.has_access,
      trial_ends_at: bundle.subscription.trial_ends_at,
      days_left: bundle.subscription.days_left,
      renewal_term_years: bundle.subscription.renewal_term_years
    },
    checks
  });
}));

router.post("/accounting", authenticate, requireProject, requireRoles("owner"), validateBody(accountingSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  assertOwnerOnboarding(auth.roles);
  const body = req.body as z.infer<typeof accountingSchema>;

  const progress = await prisma.onboardingProgress.findUnique({
    where: { tenantId: auth.tenantId },
    select: onboardingProgressSelect
  });
  if (!progress) throw badRequest("Onboarding is not initialized for this tenant");
  assertOnboardingProject(auth.projectId, progress.projectId);

  const { user, nextProgress, memberId } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: {
        tenantId_mobile: {
          tenantId: auth.tenantId,
          mobile: body.accountant.mobile
        }
      },
      update: {
        name: body.accountant.name,
        ...(body.accountant.email ? { email: body.accountant.email } : {})
      },
      create: {
        tenantId: auth.tenantId,
        name: body.accountant.name,
        mobile: body.accountant.mobile,
        email: body.accountant.email
      }
    });

    await tx.projectMembership.upsert({
      where: {
        projectId_userId_role: {
          projectId: progress.projectId,
          userId: user.id,
          role: "accountant"
        }
      },
      update: { isActive: true },
      create: {
        tenantId: auth.tenantId,
        projectId: progress.projectId,
        userId: user.id,
        role: "accountant"
      }
    });

    const ensured = await ensureUserProjectMember(tx, {
      tenantId: auth.tenantId,
      projectId: progress.projectId,
      user: {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        email: user.email
      },
      defaultShares: 0
    });

    await tx.projectMembership.updateMany({
      where: {
        tenantId: auth.tenantId,
        projectId: progress.projectId,
        userId: user.id,
        role: "accountant"
      },
      data: { memberId: ensured.memberId }
    });

    const nextState = recomputeOnboardingStatus({
      organizationStepStatus: progress.organizationStepStatus,
      accountantStepStatus: "done",
      accountsStepStatus: progress.accountsStepStatus,
      shareholdersStepStatus: progress.shareholdersStepStatus
    });

    const nextProgress = await tx.onboardingProgress.update({
      where: { tenantId: auth.tenantId },
      data: {
        accountantUserId: user.id,
        incomeApprovalFlow: body.approval_flow.income,
        expenseApprovalFlow: body.approval_flow.expense,
        accountantStepStatus: "done",
        status: nextState.status,
        completedAt: nextState.completedAt
      },
      select: onboardingProgressSelect
    });

    return { user, nextProgress, memberId: ensured.memberId };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "onboarding.accounting_configured",
    entityType: "onboarding_progress",
    entityId: progress.tenantId,
    after: {
      accountant_user_id: user.id,
      income_approval_flow: body.approval_flow.income,
      expense_approval_flow: body.approval_flow.expense
    }
  });

  return ok(res, {
    accountant: {
      user_id: user.id,
      name: user.name,
      mobile: user.mobile,
      email: user.email,
      member_id: memberId,
      roles: ["accountant", "member"]
    },
    onboarding: summarizeOnboarding(nextProgress)
  });
}));

router.post("/accounts", authenticate, requireProject, requireRoles("owner"), validateBody(accountsSetupSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  assertOwnerOnboarding(auth.roles);
  const body = req.body as z.infer<typeof accountsSetupSchema>;

  const progress = await prisma.onboardingProgress.findUnique({
    where: { tenantId: auth.tenantId },
    select: onboardingProgressSelect
  });
  if (!progress) throw badRequest("Onboarding is not initialized for this tenant");
  assertOnboardingProject(auth.projectId, progress.projectId);
  assertStepCompleted(progress.accountantStepStatus, "Accountant and approval setup");

  const duplicateNames = new Set<string>();
  for (const account of body.accounts) {
    const key = account.name.trim().toLowerCase();
    if (duplicateNames.has(key)) {
      throw badRequest("Duplicate account names in request payload", { name: account.name });
    }
    duplicateNames.add(key);
  }

  const existing = await prisma.account.findMany({
    where: { tenantId: auth.tenantId, projectId: progress.projectId },
    select: { name: true }
  });
  const existingNames = new Set(existing.map((item) => item.name.trim().toLowerCase()));
  const clashing = body.accounts.find((item) => existingNames.has(item.name.trim().toLowerCase()));
  if (clashing) {
    throw conflict("An account with this name already exists", { name: clashing.name });
  }

  const defaultCount = body.accounts.filter((item) => item.is_default === true).length;
  if (defaultCount > 1) {
    throw badRequest("Only one account can be marked as default");
  }

  const { createdAccounts, nextProgress } = await prisma.$transaction(async (tx) => {
    if (defaultCount === 1) {
      await tx.account.updateMany({
        where: { tenantId: auth.tenantId, projectId: progress.projectId, isDefault: true },
        data: { isDefault: false }
      });
    }

    const createdAccounts = [];
    for (const account of body.accounts) {
      const openingBalance = account.opening_balance ?? 0;
      const created = await tx.account.create({
        data: {
          tenantId: auth.tenantId,
          projectId: progress.projectId,
          name: account.name,
          type: account.type,
          balance: openingBalance,
          isDefault: account.is_default ?? false
        }
      });

      if (openingBalance > 0) {
        await tx.accountTransaction.create({
          data: {
            tenantId: auth.tenantId,
            projectId: progress.projectId,
            accountId: created.id,
            direction: "money_in",
            amount: openingBalance,
            referenceType: "income",
            referenceId: created.id,
            description: "Opening balance income",
            balanceAfter: created.balance,
            createdById: auth.userId
          }
        });
      }

      createdAccounts.push(created);
    }

    const nextState = recomputeOnboardingStatus({
      organizationStepStatus: progress.organizationStepStatus,
      accountantStepStatus: progress.accountantStepStatus,
      accountsStepStatus: "done",
      shareholdersStepStatus: progress.shareholdersStepStatus
    });

    const nextProgress = await tx.onboardingProgress.update({
      where: { tenantId: auth.tenantId },
      data: {
        accountsStepStatus: "done",
        status: nextState.status,
        completedAt: nextState.completedAt
      },
      select: onboardingProgressSelect
    });

    return { createdAccounts, nextProgress };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "onboarding.accounts_created",
    entityType: "onboarding_progress",
    entityId: progress.tenantId,
    after: { created_count: createdAccounts.length }
  });

  return created(res, {
    accounts: createdAccounts,
    onboarding: summarizeOnboarding(nextProgress)
  });
}));

router.post("/shareholders", authenticate, requireProject, requireRoles("owner"), validateBody(shareholdersSetupSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  assertOwnerOnboarding(auth.roles);
  const body = req.body as z.infer<typeof shareholdersSetupSchema>;
  const normalizedMembers = body.members.map((member) => ({
    ...member,
    mobile: member.mobile.trim()
  }));

  const progress = await prisma.onboardingProgress.findUnique({
    where: { tenantId: auth.tenantId },
    select: onboardingProgressSelect
  });
  if (!progress) throw badRequest("Onboarding is not initialized for this tenant");
  assertOnboardingProject(auth.projectId, progress.projectId);
  assertStepCompleted(progress.accountsStepStatus, "Accounts setup");

  const seenMobiles = new Set<string>();
  for (const member of normalizedMembers) {
    if (seenMobiles.has(member.mobile)) {
      throw badRequest("Duplicate member mobile numbers in payload", { mobile: member.mobile });
    }
    seenMobiles.add(member.mobile);
  }

  const [project, existingMembers, sharesAggregate] = await Promise.all([
    prisma.project.findFirstOrThrow({
      where: { id: progress.projectId, tenantId: auth.tenantId },
      select: { id: true, totalShares: true }
    }),
    prisma.member.findMany({
      where: {
        tenantId: auth.tenantId,
        projectId: progress.projectId,
        mobile: { in: normalizedMembers.map((member) => member.mobile) }
      },
      select: { id: true, mobile: true, shares: true, status: true }
    }),
    prisma.member.aggregate({
      where: { tenantId: auth.tenantId, projectId: progress.projectId, status: "active" },
      _sum: { shares: true }
    })
  ]);

  const existingByMobile = new Map(existingMembers.map((member) => [member.mobile.trim(), member]));
  const existingShares = sharesAggregate._sum.shares ?? 0;
  const incomingShares = normalizedMembers.reduce((sum, member) => sum + member.shares, 0);
  const matchedActiveShares = existingMembers.reduce((sum, member) =>
    sum + (member.status === "active" ? member.shares : 0), 0);
  const nextShares = existingShares - matchedActiveShares + incomingShares;
  if (nextShares > project.totalShares) {
    throw badRequest("Total shares exceed project share cap", {
      total_shares: project.totalShares,
      requested_total: nextShares
    });
  }

  const { upsertedMembers, createdCount, updatedCount, nextProgress } = await prisma.$transaction(async (tx) => {
    const upsertedMembers: Array<{
      id: string;
      name: string;
      mobile: string;
      email: string | null;
      shares: number;
      status: string;
      otpRequired: boolean;
    }> = [];
    let createdCount = 0;
    let updatedCount = 0;

    for (const member of normalizedMembers) {
      const existingMember = existingByMobile.get(member.mobile) ?? null;

      const user = await tx.user.upsert({
        where: {
          tenantId_mobile: {
            tenantId: auth.tenantId,
            mobile: member.mobile
          }
        },
        update: {
          name: member.name,
          ...(member.email ? { email: member.email } : {})
        },
        create: {
          tenantId: auth.tenantId,
          name: member.name,
          mobile: member.mobile,
          email: member.email
        }
      });

      const savedMember = existingMember
        ? await tx.member.update({
          where: { id: existingMember.id },
          data: {
            userId: user.id,
            name: member.name,
            mobile: member.mobile,
            email: member.email,
            address: member.address,
            shares: member.shares,
            status: "active"
          }
        })
        : await tx.member.create({
          data: {
            tenantId: auth.tenantId,
            projectId: progress.projectId,
            userId: user.id,
            name: member.name,
            mobile: member.mobile,
            email: member.email,
            address: member.address,
            shares: member.shares
          }
        });

      if (existingMember) updatedCount += 1;
      else createdCount += 1;

      await tx.projectMembership.upsert({
        where: {
          projectId_userId_role: {
            projectId: progress.projectId,
            userId: user.id,
            role: "member"
          }
        },
        update: { memberId: savedMember.id, isActive: true },
        create: {
          tenantId: auth.tenantId,
          projectId: progress.projectId,
          userId: user.id,
          memberId: savedMember.id,
          role: "member"
        }
      });

      await tx.projectMembership.updateMany({
        where: {
          tenantId: auth.tenantId,
          projectId: progress.projectId,
          userId: user.id,
          memberId: null
        },
        data: { memberId: savedMember.id }
      });

      upsertedMembers.push({
        id: savedMember.id,
        name: savedMember.name,
        mobile: savedMember.mobile,
        email: savedMember.email,
        shares: savedMember.shares,
        status: savedMember.status,
        otpRequired: !existingMember
      });
    }

    const aggregateAfter = await tx.member.aggregate({
      where: { tenantId: auth.tenantId, projectId: progress.projectId, status: "active" },
      _sum: { shares: true }
    });

    const sharesAssigned = aggregateAfter._sum.shares ?? 0;
    const sharesComplete = sharesAssigned === project.totalShares;
    const nextState = recomputeOnboardingStatus({
      organizationStepStatus: progress.organizationStepStatus,
      accountantStepStatus: progress.accountantStepStatus,
      accountsStepStatus: progress.accountsStepStatus,
      shareholdersStepStatus: sharesComplete ? "done" : "pending"
    });

    const nextProgress = await tx.onboardingProgress.update({
      where: { tenantId: auth.tenantId },
      data: {
        shareholdersStepStatus: sharesComplete ? "done" : "pending",
        status: nextState.status,
        completedAt: nextState.completedAt
      },
      select: onboardingProgressSelect
    });

    return { upsertedMembers, createdCount, updatedCount, nextProgress };
  });

  const membersWithOtp = [];
  for (const member of upsertedMembers) {
    if (!member.otpRequired) {
      membersWithOtp.push({
        id: member.id,
        name: member.name,
        mobile: member.mobile,
        email: member.email,
        shares: member.shares,
        status: member.status,
        otp: {
          sent: false,
          emailed: false
        }
      });
      continue;
    }

    const otp = await issueOtp(member.mobile, member.email);
    membersWithOtp.push({
      id: member.id,
      name: member.name,
      mobile: member.mobile,
      email: member.email,
      shares: member.shares,
      status: member.status,
      otp: {
        sent: true,
        emailed: otp.emailed,
        ...(process.env.NODE_ENV === "production" ? {} : { dev_code: otp.code })
      }
    });
  }

  const activeSharesAfter = await prisma.member.aggregate({
    where: { tenantId: auth.tenantId, projectId: progress.projectId, status: "active" },
    _sum: { shares: true }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "onboarding.shareholders_created",
    entityType: "onboarding_progress",
    entityId: progress.tenantId,
    after: {
      created_count: createdCount,
      updated_count: updatedCount,
      upserted_count: membersWithOtp.length,
      shares_assigned: activeSharesAfter._sum.shares ?? 0,
      shares_target: project.totalShares
    }
  });

  return created(res, {
    members: membersWithOtp,
    shares: {
      assigned: activeSharesAfter._sum.shares ?? 0,
      target: project.totalShares,
      remaining: Math.max(0, project.totalShares - (activeSharesAfter._sum.shares ?? 0))
    },
    onboarding: summarizeOnboarding(nextProgress)
  });
}));

router.post("/skip", authenticate, requireProject, requireRoles("owner"), validateBody(skipSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  assertOwnerOnboarding(auth.roles);

  const progress = await prisma.onboardingProgress.findUnique({
    where: { tenantId: auth.tenantId },
    select: onboardingProgressSelect
  });
  if (!progress) throw badRequest("Onboarding is not initialized for this tenant");
  assertOnboardingProject(auth.projectId, progress.projectId);

  // This onboarding version supports skipping only the final shareholders step.
  const step = "shareholders";
  if (progress.shareholdersStepStatus === "done" || progress.shareholdersStepStatus === "skipped") {
    return ok(res, {
      skipped: step,
      onboarding: summarizeOnboarding(progress)
    });
  }

  assertStepCompleted(progress.accountsStepStatus, "Accounts setup");

  const sharesAggregate = await prisma.member.aggregate({
    where: { tenantId: auth.tenantId, projectId: progress.projectId, status: "active" },
    _sum: { shares: true }
  });
  const sharesAssigned = sharesAggregate._sum.shares ?? 0;
  if (sharesAssigned < 1) {
    throw badRequest("You can skip shareholder completion only after adding at least 1 share", {
      minimum_required_shares: 1,
      shares_assigned: sharesAssigned
    });
  }

  const nextState = recomputeOnboardingStatus({
    organizationStepStatus: progress.organizationStepStatus,
    accountantStepStatus: progress.accountantStepStatus,
    accountsStepStatus: progress.accountsStepStatus,
    shareholdersStepStatus: "skipped"
  });

  const nextProgress = await prisma.onboardingProgress.update({
    where: { tenantId: auth.tenantId },
    data: {
      shareholdersStepStatus: "skipped",
      status: nextState.status,
      completedAt: nextState.completedAt
    },
    select: onboardingProgressSelect
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "onboarding.step_skipped",
    entityType: "onboarding_progress",
    entityId: progress.tenantId,
    after: {
      step,
      shares_assigned: sharesAssigned
    }
  });

  return ok(res, {
    skipped: step,
    shares_assigned: sharesAssigned,
    onboarding: summarizeOnboarding(nextProgress)
  });
}));

router.post("/complete", authenticate, requireProject, requireRoles("owner"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  assertOwnerOnboarding(auth.roles);

  const progress = await prisma.onboardingProgress.findUnique({
    where: { tenantId: auth.tenantId },
    select: onboardingProgressSelect
  });
  if (!progress) throw badRequest("Onboarding is not initialized for this tenant");
  assertOnboardingProject(auth.projectId, progress.projectId);

  const nextState = recomputeOnboardingStatus({
    organizationStepStatus: progress.organizationStepStatus,
    accountantStepStatus: progress.accountantStepStatus,
    accountsStepStatus: progress.accountsStepStatus,
    shareholdersStepStatus: progress.shareholdersStepStatus
  });
  if (nextState.status !== "completed") {
    throw badRequest("All onboarding steps are required before completion", {
      onboarding: summarizeOnboarding(progress)
    });
  }

  const completed = await prisma.onboardingProgress.update({
    where: { tenantId: auth.tenantId },
    data: {
      status: "completed",
      completedAt: nextState.completedAt ?? new Date()
    },
    select: onboardingProgressSelect
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "onboarding.completed",
    entityType: "onboarding_progress",
    entityId: progress.tenantId,
    after: completed
  });

  return ok(res, { onboarding: summarizeOnboarding(completed) });
}));

router.use((_req, _res, next) => next(notFound("Onboarding endpoint not found")));

export { router as onboardingRouter };
