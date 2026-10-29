import { subscriptionContext } from "../../core/subscription/subscription.repository.js";
import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { prisma } from "../../core/prisma/client.js";
import { Prisma } from "@prisma/client";
import { evaluateSubscription, getStoredSubscription } from "../../core/subscription/subscription.service.js";
import { packageId } from "../../core/subscription/packages.js";
import { listInvoices } from "../subscription/billing.service.js";

import { organizationAiUsage } from './ai-usage.service.js';

const counters: Record<string, [string, Record<string, unknown>]> = {
  projects: ["project", {}], members: ["member", {}], users: ["tenantUser", {}], expenses: ["expense", {}],
  income_rows: ["accountTransaction", { referenceType: "income", direction: "money_in" }], fixed_assets: ["fixedAsset", {}], deposits: ["deposit", {}],
  notices: ["projectNotice", {}], polls: ["poll", {}], votes: ["pollVote", {}], events: ["projectEvent", {}],
  notification_campaigns: ["notificationCampaign", {}], inbox_notifications: ["notification", {}],
  bank_accounts: ["account", { type: "bank" }], cash_accounts: ["account", { type: "cash" }],
  documents: ["upload", { deletedAt: null }], retained_deleted_documents: ["upload", { deletedAt: { not: null } }],
  receipt_attachments: ["upload", { deletedAt: null, purpose: "payment_proof" }],
  profile_photos: ["upload", { deletedAt: null, purpose: { startsWith: "member_photo:" } }],
  logos: ["upload", { deletedAt: null, OR: [{ purpose: "project_logo" }, { purpose: { startsWith: "customer_logo:" } }, { purpose: { startsWith: "dealer_logo:" } }] }],
  other_documents: ["upload", { deletedAt: null, OR: [{ purpose: null }, { NOT: { OR: [{ purpose: "payment_proof" }, { purpose: "project_logo" }, { purpose: { startsWith: "customer_logo:" } }, { purpose: { startsWith: "dealer_logo:" } }, { purpose: { startsWith: "member_photo:" } }] } }] }],
  report_exports: ["reportExport", {}], receipts: ["receipt", {}],
  support_tickets: ["supportTicket", {}], support_screenshots: ["supportAttachment", {}],
  app_installations_seen: ["appInstallation", { platform: { in: ["android", "ios"] } }], web_installations_seen: ["appInstallation", { platform: "web" }],
};
type CountModel = { count(args: { where: Record<string, unknown> }): Promise<number>; groupBy(args: { by: string[]; where: Record<string, unknown>; _count: true }): Promise<{ tenantId: string; _count: number }[]> };
const models = prisma as unknown as Record<string, CountModel>;
export async function overallUsage() {
  const counts = Object.fromEntries(await Promise.all(Object.entries(counters).map(async ([key, [model, where]]) => [key, await models[model]!.count({ where })])));
  const [tenants, deliveries, storage] = await Promise.all([prisma.tenant.count(), prisma.notificationDelivery.groupBy({ by: ["channel", "status"], _count: true }), prisma.upload.aggregate({ _sum: { size: true }, where: { deletedAt: null } })]);
  return { generated_at: new Date().toISOString(), tenants, counts, notifications: deliveries.map(row => ({ channel: row.channel, status: row.status, count: row._count })), active_document_bytes: storage._sum.size ?? 0 };
}
export async function tenantSummaries(offset: number, search?: string) {
  const where = search ? { OR: [{ name: { contains: search, mode: "insensitive" as const } }, { slug: { contains: search, mode: "insensitive" as const } }] } : {};
  const tenants = await prisma.tenant.findMany({ include: { subscription: true },  where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: offset, take: 51 });
  return { tenants: await summariesFor(tenants.slice(0, 50)), next_offset: tenants.length > 50 ? offset + 50 : null };
}
export async function summariesFor(tenants: Array<import("@prisma/client").Tenant & {subscription:import("@prisma/client").TenantSubscription|null}>) {
  if (!tenants.length) return [];
  const ids = tenants.map(t => t.id), scope = { tenantId: { in: ids } };
  const usage: Record<string,{tenantId:string;_count:number}[]> = Object.fromEntries(await Promise.all(Object.entries(counters).map(async ([key, [model, where]]) => [key, await models[model]!.groupBy({ by: ["tenantId"], where: { ...where, ...scope }, _count: true })])));
  const [seen, paid, storage, sent, owners, activity, aiUsage] = await Promise.all([
    prisma.appInstallation.groupBy({ by: ["tenantId"], where: { ...scope, platform: { in: ["android", "ios"] } }, _min: { firstSeenAt: true }, _max: { lastSeenAt: true } }),
    prisma.platformPayment.groupBy({ by: ["tenantId"], where: scope, _max: { paidAt: true } }),
    prisma.upload.groupBy({ by: ["tenantId"], where: { ...scope, deletedAt: null }, _sum: { size: true } }),
    prisma.$queryRaw<{ tenant_id: string; channel: string; count: bigint }[]>`SELECT c.tenant_id, d.channel, count(*) FROM notification_deliveries d JOIN notification_campaigns c ON c.id=d.campaign_id WHERE c.tenant_id IN (${Prisma.join(ids)}) AND d.status='sent' GROUP BY c.tenant_id,d.channel`,
    tenantAccounts(prisma).findMany({ where: { ...scope, isActive: true, memberships: { some: { role: "owner", isActive: true } } },
      select: { id: true, tenantId: true, name: true, email: true, mobile: true, lastLoginAt: true, lastLoginPlatform: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    tenantAccounts(prisma).groupBy({ by: ["tenantId"], where: scope, _max: { lastActiveAt: true } }),
    organizationAiUsage(tenants),
  ]);
  return Promise.all(tenants.map(async tenant => {
    const subscription = getStoredSubscription(subscriptionContext(tenant)), app = seen.find(s => s.tenantId === tenant.id);
    const dates = [paid.find(p => p.tenantId === tenant.id)?._max.paidAt?.toISOString(), ...(await listInvoices(tenant.id)).filter(i => i.status === "approved").map(i => i.approved_at)].filter((d): d is string => !!d).sort();
    const owner = owners.find(user => user.tenantId === tenant.id);
    return { owner: owner ? { id: owner.id, name: owner.name, email: owner.email,
        mobile: /^\+?\d{6,15}$/.test(owner.mobile) ? owner.mobile : null,
        last_login_at: owner.lastLoginAt, last_login_platform: owner.lastLoginPlatform } : null,
      ai_usage: aiUsage.get(tenant.id),
      last_active_at: activity.find(row => row.tenantId === tenant.id)?._max.lastActiveAt ?? null,
      id: tenant.id, name: tenant.name, slug: tenant.slug, currency: tenant.currency, created_at: tenant.createdAt,
      package: packageId(subscriptionContext(tenant)), subscription: evaluateSubscription(subscriptionContext(tenant)), trial_expires_at: subscription?.trial_ends_at ?? null,
      paid_period_expires_at: subscription?.current_period_end_at ?? null, last_payment_at: dates.at(-1) ?? null,
      install_date: null, first_app_seen_at: app?._min.firstSeenAt ?? null, last_app_seen_at: app?._max.lastSeenAt ?? null,
      deletion_started_at: tenant.deletionStartedAt,
      counts: Object.fromEntries(Object.entries(usage).map(([key, rows]) => [key, rows.find(r => r.tenantId === tenant.id)?._count ?? 0])),
      active_document_bytes: storage.find(s => s.tenantId === tenant.id)?._sum.size ?? 0,
      sent_notifications: Object.fromEntries(sent.filter(s => s.tenant_id === tenant.id).map(s => [s.channel, Number(s.count)])),
    };
  }));
}
