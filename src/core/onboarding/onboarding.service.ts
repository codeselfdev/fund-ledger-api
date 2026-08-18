import type { Prisma } from "@prisma/client";

export type OnboardingStepId = "signup" | "project" | "invites";
export type OnboardingStepStatus = "pending" | "done" | "skipped";
export type OnboardingStatus = "in_progress" | "completed";

export type OnboardingStepState = {
  status: OnboardingStepStatus;
  completed_at: string | null;
};

export type OnboardingState = {
  status: OnboardingStatus;
  steps: Record<OnboardingStepId, OnboardingStepState>;
  updated_at: string;
};

const STEP_ORDER: OnboardingStepId[] = ["signup", "project", "invites"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function stepState(status: OnboardingStepStatus, at = new Date()): OnboardingStepState {
  return {
    status,
    completed_at: status === "pending" ? null : at.toISOString()
  };
}

export function createInitialOnboardingState(now = new Date()): OnboardingState {
  return {
    status: "in_progress",
    steps: {
      signup: stepState("done", now),
      project: stepState("pending"),
      invites: stepState("pending")
    },
    updated_at: now.toISOString()
  };
}

export function getOnboardingState(contact: unknown): OnboardingState | null {
  if (!isRecord(contact) || !isRecord(contact.onboarding)) return null;
  const raw = contact.onboarding;
  const stepsRaw = isRecord(raw.steps) ? raw.steps : {};

  const readStep = (id: OnboardingStepId): OnboardingStepState => {
    const step = isRecord(stepsRaw[id]) ? stepsRaw[id] : null;
    const status = step?.status === "done" || step?.status === "skipped" || step?.status === "pending"
      ? step.status
      : "pending";
    return {
      status,
      completed_at: typeof step?.completed_at === "string" ? step.completed_at : null
    };
  };

  return {
    status: raw.status === "completed" ? "completed" : "in_progress",
    steps: {
      signup: readStep("signup"),
      project: readStep("project"),
      invites: readStep("invites")
    },
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString()
  };
}

export function withOnboardingState(contact: unknown, onboarding: OnboardingState): Prisma.InputJsonValue {
  const base = isRecord(contact) ? { ...contact } : {};
  return toJson({
    ...base,
    onboarding
  });
}

export function summarizeOnboarding(state: OnboardingState | null) {
  if (!state) {
    return {
      required: false,
      status: "completed" as OnboardingStatus,
      current_step: null as OnboardingStepId | null,
      can_skip_current: false,
      steps: [] as Array<{
        id: OnboardingStepId;
        status: OnboardingStepStatus;
        required: boolean;
        completed_at: string | null;
      }>
    };
  }

  const steps = STEP_ORDER.map((id) => ({
    id,
    status: state.steps[id].status,
    required: id === "signup",
    completed_at: state.steps[id].completed_at
  }));

  const current = STEP_ORDER.find((id) => state.steps[id].status === "pending") ?? null;

  return {
    required: state.status !== "completed",
    status: state.status,
    current_step: state.status === "completed" ? null : current,
    can_skip_current: current === "project" || current === "invites",
    steps
  };
}

export function markOnboardingStep(
  contact: unknown,
  stepId: OnboardingStepId,
  status: "done" | "skipped",
  now = new Date()
) {
  const current = getOnboardingState(contact) ?? createInitialOnboardingState(now);
  if (current.status === "completed") {
    return { contact: withOnboardingState(contact, current), onboarding: current, summary: summarizeOnboarding(current) };
  }

  if (stepId === "signup" && status === "skipped") {
    throw new Error("Signup step cannot be skipped");
  }

  const next: OnboardingState = {
    ...current,
    steps: {
      ...current.steps,
      [stepId]: stepState(status, now)
    },
    updated_at: now.toISOString()
  };

  const allSettled = STEP_ORDER.every((id) => next.steps[id].status === "done" || next.steps[id].status === "skipped");
  if (allSettled) {
    next.status = "completed";
  }

  return {
    contact: withOnboardingState(contact, next),
    onboarding: next,
    summary: summarizeOnboarding(next)
  };
}

export function completeOnboarding(contact: unknown, now = new Date()) {
  const current = getOnboardingState(contact) ?? createInitialOnboardingState(now);
  const next: OnboardingState = {
    status: "completed",
    steps: {
      signup: current.steps.signup.status === "pending" ? stepState("done", now) : current.steps.signup,
      project: current.steps.project.status === "pending" ? stepState("skipped", now) : current.steps.project,
      invites: current.steps.invites.status === "pending" ? stepState("skipped", now) : current.steps.invites
    },
    updated_at: now.toISOString()
  };

  return {
    contact: withOnboardingState(contact, next),
    onboarding: next,
    summary: summarizeOnboarding(next)
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
