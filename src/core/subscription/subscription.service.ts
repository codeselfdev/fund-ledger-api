import type { Prisma } from "@prisma/client";
import { packageId, addCalendarMonths, type PackageId, type BillingCycle } from "./packages.js";

export type SubscriptionStatus = "trial" | "active" | "expired";

type StoredSubscription = {
  status: SubscriptionStatus;
  package: PackageId;
  billing_cycle: BillingCycle;
  trial_starts_at: string | null;
  trial_ends_at: string | null;
  current_period_start_at: string | null;
  current_period_end_at: string | null;
  renewal_term_years: number;
  updated_at: string;
};

const DEFAULT_RENEWAL_TERM_YEARS = 1;
/** Day-based provisioning override; new organizations default to one calendar month. */
export const DEFAULT_TRIAL_DAYS = 30;
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
  const month = next.getUTCMonth();
  next.setUTCFullYear(next.getUTCFullYear() + years);
  if (next.getUTCMonth() !== month) next.setUTCDate(0);
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
    package: packageId(contact),
    billing_cycle: raw.billing_cycle === "monthly" ? "monthly" : "yearly",
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

export const SUBSCRIPTION_GRACE_DAYS = 5;

/** Access belongs to the selected organization, including every member and project. */
export function evaluateSubscription(contact: unknown, now = new Date()) {
  const stored = getStoredSubscription(contact);
  const periodEnd = parseDate(stored?.current_period_end_at ?? null);
  const trialEnd = parseDate(stored?.trial_ends_at ?? null);
  const end = periodEnd ?? (stored?.status !== "active" ? trialEnd : null);
  const graceEnd = end ? new Date(end.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS) : null;
  const source = periodEnd ? "subscription" : "trial";
  const eligible = Boolean(stored && stored.status !== "expired" && end);
  const current = eligible && now < end!;
  const grace = eligible && !current && now < graceEnd!;
  const allowed = current || grace;
  return {
    managed: Boolean(stored),
    status: (allowed ? source === "trial" ? "trial" : "active" : "expired") as SubscriptionStatus,
    has_access: allowed,
    access_phase: grace ? "grace" : current ? source === "trial" ? "trial" : "active" : "expired",
    in_grace_period: grace,
    grace_days_left: grace ? Math.ceil((graceEnd!.getTime() - now.getTime()) / DAY_MS) : 0,
    grace_ends_at: graceEnd?.toISOString() ?? null,
    access_ends_at: eligible ? graceEnd?.toISOString() ?? null : null,
    billing_period_end_at: end?.toISOString() ?? null,
    reason: !stored ? "unmanaged_missing_subscription" : stored.status === "expired" ? "subscription_explicitly_expired"
      : grace ? `${source}_grace_period` : current ? `${source}_active` : "subscription_expired",
    renewal_term_years: stored?.renewal_term_years ?? DEFAULT_RENEWAL_TERM_YEARS,
    trial_ends_at: stored?.trial_ends_at ?? null,
    current_period_end_at: stored?.current_period_end_at ?? null,
    days_left: current ? Math.ceil((end!.getTime() - now.getTime()) / DAY_MS) : 0,
  };
}

export function createTrialSubscription(trialDays: number, now = new Date()) {
  const safeDays = Math.max(0, Math.floor(trialDays));
  const trialEnd = safeDays > 0 ? addDays(now, safeDays) : now;
  const stored: StoredSubscription = {
    status: safeDays > 0 ? "trial" : "expired",
    package: "free",
    billing_cycle: "yearly",
    trial_starts_at: toIso(now),
    trial_ends_at: toIso(trialEnd),
    current_period_start_at: null,
    current_period_end_at: null,
    renewal_term_years: DEFAULT_RENEWAL_TERM_YEARS,
    updated_at: now.toISOString()
  };
  return stored;
}

export function createOneMonthTrial(now = new Date()) {
  return { ...createTrialSubscription(0, now), status: "trial" as const, trial_ends_at: addCalendarMonths(now, 1).toISOString() };
}

export function renewTenantSubscription(contact: unknown, now = new Date(), selection?: { package: PackageId; billing_cycle: BillingCycle }) {
  const existing = getStoredSubscription(contact);
  const renewalYears = DEFAULT_RENEWAL_TERM_YEARS;
  const selectedPackage = selection?.package ?? (existing?.package === "free" ? "starter" : existing?.package ?? "starter");
  const cycle = selection?.billing_cycle ?? existing?.billing_cycle ?? "yearly";
  const currentPeriodEnd = parseDate(existing?.current_period_end_at ?? null);
  // Paid upgrades and renewals preserve remaining prepaid time; the new package activates immediately.
  const baseStart = currentPeriodEnd && currentPeriodEnd > now ? currentPeriodEnd : now;
  const nextEnd = addCalendarMonths(baseStart, cycle === "monthly" ? 1 : 12);

  const stored: StoredSubscription = {
    status: "active",
    package: selectedPackage,
    billing_cycle: cycle,
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
