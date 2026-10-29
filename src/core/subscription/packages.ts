export const MAX_DOCUMENT_BYTES = 5_000_000;
export const PACKAGES = {
  free: { id: "free", name: "Free Trial", monthly: 0, yearly: 0, users: null, documents: 100, projects: 2, ai_replies_monthly: 10, feature_requests: 0, support: "Standard support" },
  starter: { id: "starter", name: "Starter", monthly: 3000, yearly: 30000, users: 20, documents: 1000, projects: 2, ai_replies_monthly: 100, feature_requests: 3, support: "Standard support" },
  business: { id: "business", name: "Business", monthly: 8000, yearly: 80000, users: 500, documents: 15000, projects: 6, ai_replies_monthly: 1000, whatsapp_bot_replies_monthly: 1000, feature_requests: 12, support: "24-hour support" },
  custom: { id: "custom", name: "Custom", monthly: null, yearly: null, users: null, documents: null, projects: null, feature_requests: null, support: "Contact us for details" }
} as const;
export type PackageId = keyof typeof PACKAGES;
export type BillingCycle = "monthly" | "yearly";
export function packageId(contact: unknown): PackageId {
  const s = (contact as { subscription?: { package?: string } } | null)?.subscription;
  if (s?.package && Object.hasOwn(PACKAGES, s.package)) return s.package as PackageId;
  // Existing approved subscriptions had no package marker. Preserve paid data.
  const stored = (contact as { subscription?: { current_period_end_at?: string } } | null)?.subscription;
  return stored?.current_period_end_at ? "starter" : "free";
}
export function addCalendarMonths(base: Date, months: number) {
  const end = new Date(base), day = end.getUTCDate();
  end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() + months);
  end.setUTCDate(Math.min(day, new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate()));
  return end;
}
