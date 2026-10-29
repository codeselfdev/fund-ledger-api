import { subscriptionContext } from "../../core/subscription/subscription.repository.js";
import { tenantQuota } from "../../core/subscription/quota.service.js";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { badRequest, conflict } from "../../core/http/api-error.js";
import { PACKAGES, packageId, type BillingCycle } from "../../core/subscription/packages.js";
import { listInvoices, persistInvoice, type SubscriptionInvoice } from "./billing.service.js";

export async function selectPackage(tenantId: string, userId: string, selected: "starter" | "business", cycle: BillingCycle) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;
    const tenant = await tx.tenant.findUniqueOrThrow({ include: { subscription: true },  where: { id: tenantId } });
    if (tenant.deletionStartedAt) throw conflict("Organization cleanup has started");
    const current = packageId(subscriptionContext(tenant));
    if (current === "custom" || (current === "business" && selected === "starter")) throw badRequest("Contact support to change to a smaller package.");
    const contact = tenant.contact && typeof tenant.contact === "object" && !Array.isArray(tenant.contact) ? tenant.contact as Record<string, unknown> : {};
    const invoices = await listInvoices(tenantId, tx);
    const pending = invoices.find(row => row.status !== "approved");
    if (pending) {
      if (pending.package === selected && pending.billing_cycle === cycle) return pending;
      throw conflict("An unpaid invoice already exists. Complete it or contact support before changing your selection.");
    }
    const usage = await tenantQuota(tenantId, tx), plan = PACKAGES[selected];
    if (usage.users.used > plan.users || usage.documents.used > plan.documents || usage.projects.used > plan.projects)
      throw badRequest("Your current organization usage exceeds this package. Choose a larger package or contact support.");
    const billing = contact.billing && typeof contact.billing === "object" && !Array.isArray(contact.billing) ? contact.billing as Record<string, unknown> : {};
    const instructions = typeof billing.payment_instructions === "string" ? billing.payment_instructions : "Contact hello@appnesta.com for payment instructions. Submit the paid amount, transaction reference and receipt after payment; your package activates after approval.";
    const invoice: SubscriptionInvoice = { id: randomUUID(), package: selected, billing_cycle: cycle,
      amount: PACKAGES[selected][cycle], currency: "BDT", instructions, status: "open", issued_at: new Date().toISOString(),
      payment_reference: null, submitted_at: null, approved_at: null, rejection_reason: null, period_ends_at: null };
    await persistInvoice(tx, tenantId, invoice);
    await tx.activity.create({ data: { tenantId, actorUserId: userId, action: "subscription.package_requested", entityType: "subscription_invoice", entityId: invoice.id, after: invoice as unknown as Prisma.InputJsonValue } });
    await tx.platformAlert.upsert({ where: { eventKey: `billing_upgrade:${invoice.id}` }, update: {}, create: { tenantId, userId, kind: 'billing_upgrade', eventKey: `billing_upgrade:${invoice.id}` } });
    return invoice;
  });
}
