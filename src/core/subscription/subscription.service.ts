import type { Prisma } from "@prisma/client";

export type SubscriptionStatus = "trial" | "active" | "expired";

type StoredSubscription = {
  status: SubscriptionStatus;
  trial_starts_at: string | null;
  trial_ends_at: string | null;
  current_period_start_at: string | null;
  current_period_end_at: string | null;
  renewal_term_years: number;
  updated_at: string;
};

const DEFAULT_RENEWAL_TERM_YEARS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(date: Date | null) {
  return date ? date.toISOString() : null;
}

function addYears(base: Date, years: number) {
  const next = new Date(base);
  next.setFullYear(next.getFullYear() + years);
  return next;
}

function addDays(base: Date, days: number) {
  return new Date(base.getTime() + days * DAY_MS);
}

export function getStoredSubscription(contact: unknown): StoredSubscription | null {
  if (!isRecord(contact)) return null;
  if (!isRecord(contact.subscription)) return null;
  const raw = contact.subscription;
  const status = raw.status === "trial" || raw.status === "active" || raw.status === "expired"
    ? raw.status
    : "active";
  const renewalTermYears = typeof raw.renewal_term_years === "number" && raw.renewal_term_years > 0
    ? Math.floor(raw.renewal_term_years)
    : DEFAULT_RENEWAL_TERM_YEARS;

  return {
    status,
    trial_starts_at: typeof raw.trial_starts_at === "string" ? raw.trial_starts_at : null,
    trial_ends_at: typeof raw.trial_ends_at === "string" ? raw.trial_ends_at : null,
    current_period_start_at: typeof raw.current_period_start_at === "string" ? raw.current_period_start_at : null,
    current_period_end_at: typeof raw.current_period_end_at === "string" ? raw.current_period_end_at : null,
    renewal_term_years: renewalTermYears,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString()
  };
}

function withStoredSubscription(contact: unknown, subscription: StoredSubscription): Prisma.InputJsonValue {
  const base = isRecord(contact) ? { ...contact } : {};
  return toJson({
    ...base,
    subscription
  });
}

export function evaluateSubscription(contact: unknown, now = new Date()) {
  const stored = getStoredSubscription(contact);
  if (!stored) {
    return {
      managed: false,
      status: "expired" as SubscriptionStatus,
      has_access: false,
      reason: "unmanaged_missing_subscription",
      renewal_term_years: DEFAULT_RENEWAL_TERM_YEARS,
      trial_ends_at: null as string | null,
      current_period_end_at: null as string | null,
      days_left: 0
    };
  }

  const trialEndsAt = parseDate(stored.trial_ends_at);
  const periodEndsAt = parseDate(stored.current_period_end_at);
  const nowMs = now.getTime();

  if (trialEndsAt && trialEndsAt.getTime() >= nowMs) {
    return {
      managed: true,
      status: "trial" as SubscriptionStatus,
      has_access: true,
      reason: "trial_active",
      renewal_term_years: stored.renewal_term_years,
      trial_ends_at: stored.trial_ends_at,
      current_period_end_at: stored.current_period_end_at,
      days_left: Math.ceil((trialEndsAt.getTime() - nowMs) / DAY_MS)
    };
  }

  if (periodEndsAt && periodEndsAt.getTime() >= nowMs) {
    return {
      managed: true,
      status: "active" as SubscriptionStatus,
      has_access: true,
      reason: "subscription_active",
      renewal_term_years: stored.renewal_term_years,
      trial_ends_at: stored.trial_ends_at,
      current_period_end_at: stored.current_period_end_at,
      days_left: Math.ceil((periodEndsAt.getTime() - nowMs) / DAY_MS)
    };
  }

  return {
    managed: true,
    status: "expired" as SubscriptionStatus,
    has_access: false,
    reason: stored.status === "expired" ? "subscription_explicitly_expired" : "subscription_expired",
    renewal_term_years: stored.renewal_term_years,
    trial_ends_at: stored.trial_ends_at,
    current_period_end_at: stored.current_period_end_at,
    days_left: 0
  };
}

export function createTrialSubscription(trialDays: number, now = new Date()) {
  const safeDays = Math.max(0, Math.floor(trialDays));
  const trialEnd = safeDays > 0 ? addDays(now, safeDays) : now;
  const stored: StoredSubscription = {
    status: safeDays > 0 ? "trial" : "expired",
    trial_starts_at: toIso(now),
    trial_ends_at: toIso(trialEnd),
    current_period_start_at: null,
    current_period_end_at: null,
    renewal_term_years: DEFAULT_RENEWAL_TERM_YEARS,
    updated_at: now.toISOString()
  };
  return stored;
}

export function renewTenantSubscription(contact: unknown, now = new Date()) {
  const existing = getStoredSubscription(contact);
  const renewalYears = existing?.renewal_term_years ?? DEFAULT_RENEWAL_TERM_YEARS;
  const currentPeriodEnd = parseDate(existing?.current_period_end_at);
  const baseStart = currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime() ? currentPeriodEnd : now;
  const nextEnd = addYears(baseStart, renewalYears);

  const stored: StoredSubscription = {
    status: "active",
    trial_starts_at: existing?.trial_starts_at ?? null,
    trial_ends_at: existing?.trial_ends_at ?? null,
    current_period_start_at: toIso(baseStart),
    current_period_end_at: toIso(nextEnd),
    renewal_term_years: renewalYears,
    updated_at: now.toISOString()
  };

  return {
    contact: withStoredSubscription(contact, stored),
    subscription: stored
  };
}

export function startTenantTrial(contact: unknown, trialDays: number, now = new Date()) {
  const existing = getStoredSubscription(contact);
  const trial = createTrialSubscription(trialDays, now);
  const stored: StoredSubscription = {
    ...trial,
    renewal_term_years: existing?.renewal_term_years ?? DEFAULT_RENEWAL_TERM_YEARS
  };
  return {
    contact: withStoredSubscription(contact, stored),
    subscription: stored
  };
}
