import type { Prisma, TenantSubscription } from '@prisma/client';
import { prisma } from '../prisma/client.js';
import type { PackageId, BillingCycle } from './packages.js';
import { conflict, notFound } from '../http/api-error.js';
export type SubscriptionData = {
  status: 'trial' | 'active' | 'expired'; package: PackageId; billing_cycle: BillingCycle;
  trial_starts_at: string | null; trial_ends_at: string | null;
  current_period_start_at: string | null; current_period_end_at: string | null;
  quota_reset_at?: string | null; renewal_term_years: number; updated_at: string;
};
export function subscriptionData(row: TenantSubscription | null | undefined): SubscriptionData | null {
  return row ? { status: row.status, package: row.package, billing_cycle: row.billingCycle,
    trial_starts_at: row.trialStartsAt?.toISOString() ?? null, trial_ends_at: row.trialEndsAt?.toISOString() ?? null,
    current_period_start_at: row.currentPeriodStartAt?.toISOString() ?? null, current_period_end_at: row.currentPeriodEndAt?.toISOString() ?? null,
    quota_reset_at: row.quotaResetAt?.toISOString() ?? null, renewal_term_years: 1, updated_at: row.updatedAt.toISOString() } : null;
}
/** Policy input assembled from relational state and unrelated organization settings. */
export function subscriptionContext(tenant: { contact?: unknown; subscription: TenantSubscription | null }) {
  const settings = tenant.contact && typeof tenant.contact === 'object' && !Array.isArray(tenant.contact) ? tenant.contact : {};
  return { ...settings, subscription: subscriptionData(tenant.subscription) };
}
export async function currentSubscription(tenantId: string, db: Prisma.TransactionClient = prisma) {
  return subscriptionData(await db.tenantSubscription.findUnique({ where: { tenantId } }));
}
export async function saveSubscription(db: Prisma.TransactionClient, tenantId: string, next: SubscriptionData,
  cause: { event: string; actorUserId?: string; actor?: string; invoiceId?: string; paymentId?: string }) {
  await db.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { deletionStartedAt: true } });
  if (!tenant) throw notFound('Organization not found');
  if (tenant.deletionStartedAt) throw conflict('Organization cleanup has started');
  const previous = await db.tenantSubscription.findUnique({ where: { tenantId } });
  const date = (value: string | null | undefined) => value ? new Date(value) : null;
  const data = { package: next.package, status: next.status, billingCycle: next.billing_cycle,
    trialStartsAt: date(next.trial_starts_at), trialEndsAt: date(next.trial_ends_at),
    currentPeriodStartAt: date(next.current_period_start_at), currentPeriodEndAt: date(next.current_period_end_at),
    quotaResetAt: date(next.quota_reset_at), revision: (previous?.revision ?? 0) + 1 };
  const row = await db.tenantSubscription.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  const { event, ...references } = cause;
  await db.subscriptionHistory.create({ data: { tenantId, revision: row.revision, event, ...references,
    ...(previous ? { previous: subscriptionData(previous) as unknown as Prisma.InputJsonValue } : {}),
    current: subscriptionData(row) as unknown as Prisma.InputJsonValue } });
  return row;
}
