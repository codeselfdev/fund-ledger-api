import type {
  ApprovalFlowMode,
  OnboardingProgress,
  OnboardingProgressStatus,
  OnboardingStepStatus
} from "@prisma/client";

export type OnboardingStepId =
  | "organization"
  | "accountant_and_approval"
  | "accounts"
  | "shareholders";

type OnboardingProgressLike = Pick<
OnboardingProgress,
| "status"
| "organizationStepStatus"
| "accountantStepStatus"
| "accountsStepStatus"
| "shareholdersStepStatus"
| "incomeApprovalFlow"
| "expenseApprovalFlow"
| "accountantUserId"
| "completedAt"
>;

const STEP_ORDER: OnboardingStepId[] = [
  "organization",
  "accountant_and_approval",
  "accounts",
  "shareholders"
];

function isSettled(status: OnboardingStepStatus) {
  return status === "done" || status === "skipped";
}

function currentStepFromProgress(progress: Pick<
OnboardingProgressLike,
| "organizationStepStatus"
| "accountantStepStatus"
| "accountsStepStatus"
| "shareholdersStepStatus"
>) {
  if (progress.organizationStepStatus === "pending") return "organization";
  if (progress.accountantStepStatus === "pending") return "accountant_and_approval";
  if (progress.accountsStepStatus === "pending") return "accounts";
  if (progress.shareholdersStepStatus === "pending") return "shareholders";
  return null;
}

export function recomputeOnboardingStatus(progress: {
  organizationStepStatus: OnboardingStepStatus;
  accountantStepStatus: OnboardingStepStatus;
  accountsStepStatus: OnboardingStepStatus;
  shareholdersStepStatus: OnboardingStepStatus;
}, now = new Date()) {
  const allSettled = isSettled(progress.organizationStepStatus)
    && isSettled(progress.accountantStepStatus)
    && isSettled(progress.accountsStepStatus)
    && isSettled(progress.shareholdersStepStatus);

  return {
    status: (allSettled ? "completed" : "in_progress") as OnboardingProgressStatus,
    completedAt: allSettled ? now : null
  };
}

export function createProvisionedOnboardingSeed(input: {
  source: "provisioning" | "self_signup" | "cli";
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (input.source === "self_signup") {
    return {
      status: "in_progress" as OnboardingProgressStatus,
      organizationStepStatus: "done" as OnboardingStepStatus,
      accountantStepStatus: "pending" as OnboardingStepStatus,
      accountsStepStatus: "pending" as OnboardingStepStatus,
      shareholdersStepStatus: "pending" as OnboardingStepStatus,
      incomeApprovalFlow: "accountant_and_approver" as ApprovalFlowMode,
      expenseApprovalFlow: "accountant_and_approver" as ApprovalFlowMode,
      completedAt: null as Date | null
    };
  }

  return {
    status: "completed" as OnboardingProgressStatus,
    organizationStepStatus: "done" as OnboardingStepStatus,
    accountantStepStatus: "done" as OnboardingStepStatus,
    accountsStepStatus: "done" as OnboardingStepStatus,
    shareholdersStepStatus: "done" as OnboardingStepStatus,
    incomeApprovalFlow: "accountant_and_approver" as ApprovalFlowMode,
    expenseApprovalFlow: "accountant_and_approver" as ApprovalFlowMode,
    completedAt: now
  };
}

export function summarizeOnboarding(progress: OnboardingProgressLike | null) {
  if (!progress) {
    return {
      tracked_in_database: false,
      required: false,
      completed_in_database: true,
      status: "completed" as OnboardingProgressStatus,
      current_step: null as OnboardingStepId | null,
      total_steps: 4,
      completed_steps: 4,
      steps: [] as Array<{
        id: OnboardingStepId;
        status: OnboardingStepStatus;
        required: boolean;
      }>,
      approval_flow: {
        income: "accountant_and_approver" as ApprovalFlowMode,
        expense: "accountant_and_approver" as ApprovalFlowMode,
        second_verification_skipped: {
          income: false,
          expense: false
        }
      },
      accountant_user_id: null as string | null,
      completed_at: null as string | null
    };
  }

  const steps = [
    { id: "organization" as const, status: progress.organizationStepStatus },
    { id: "accountant_and_approval" as const, status: progress.accountantStepStatus },
    { id: "accounts" as const, status: progress.accountsStepStatus },
    { id: "shareholders" as const, status: progress.shareholdersStepStatus }
  ].map((step) => ({
    ...step,
    required: true
  }));

  const current = currentStepFromProgress(progress);
  const completedSteps = steps.filter((step) => step.status !== "pending").length;

  return {
    tracked_in_database: true,
    required: progress.status !== "completed",
    completed_in_database: progress.status === "completed",
    status: progress.status,
    current_step: progress.status === "completed" ? null : current,
    total_steps: STEP_ORDER.length,
    completed_steps: completedSteps,
    steps,
    approval_flow: {
      income: progress.incomeApprovalFlow,
      expense: progress.expenseApprovalFlow,
      second_verification_skipped: {
        income: progress.incomeApprovalFlow === "accountant_only",
        expense: progress.expenseApprovalFlow === "accountant_only"
      }
    },
    accountant_user_id: progress.accountantUserId,
    completed_at: progress.completedAt?.toISOString() ?? null
  };
}

export function slugifyOrgName(name: string) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length >= 3 ? base : `org-${Date.now().toString(36)}`;
}
