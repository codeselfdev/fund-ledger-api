import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../core/prisma/client.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { saveSubscription, subscriptionContext } from "../../core/subscription/subscription.repository.js";
import { renewTenantSubscription } from "../../core/subscription/subscription.service.js";
import { tenantQuota } from "../../core/subscription/quota.service.js";

export const manualPaymentSchema = z.object({ request_key: z.string().uuid(), package: z.enum(["starter", "business", "custom"]), billing_cycle: z.enum(["monthly", "yearly"]), amount: z.number().int().positive().max(2147483647), currency: z.string().regex(/^[A-Z]{3}$/).default("BDT"), method: z.enum(["cash", "bank", "bkash", "nagad", "card", "other"]), reference: z.string().trim().min(1).max(200), paid_at: z.string().datetime({ offset: true }), notes: z.string().trim().max(2000).optional() }).strict();
export async function recordManualPayment(tenantId: string, input: z.infer<typeof manualPaymentSchema>, actor: string) {
  if (new Date(input.paid_at).getTime() > Date.now() + 60000) throw badRequest("Payment date cannot be in the future");
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const saved = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;
    const tenant = await tx.tenant.findUnique({ include: { subscription: true },  where: { id: tenantId } });
    if (!tenant) throw notFound("Organization not found");
    if (tenant.deletionStartedAt) throw conflict("Organization cleanup has started");
    const existing = await tx.platformPayment.findUnique({ where: { tenantId_requestKey: { tenantId, requestKey: input.request_key } } });
    if (existing) {
      if (existing.payloadHash !== hash) throw conflict("Payment request key was already used with different data");
      return { payment: existing, replayed: true };
    }
    if (tenant.currency !== input.currency) throw badRequest("Payment currency must match the organization's currency");
    const now = new Date(), renewed = renewTenantSubscription(subscriptionContext(tenant), now, input);
    const subscription = { ...renewed.subscription, quota_reset_at: now.toISOString() };
    const payment = await tx.platformPayment.create({ data: { tenantId, requestKey: input.request_key, payloadHash: hash, package: input.package, billingCycle: input.billing_cycle, amount: input.amount, currency: input.currency, method: input.method, reference: input.reference, notes: input.notes, paidAt: new Date(input.paid_at), periodEndsAt: new Date(subscription.current_period_end_at!), actor } });
    await saveSubscription(tx, tenantId, subscription, { event: "manual_payment", actor, paymentId: payment.id });
    await tx.internalAudit.create({ data: { tenantId, actor, action: "subscription.manual_payment", metadata: { payment_id: payment.id, package: input.package, quota_reset_at: now.toISOString() } } });
    return { payment, replayed: false };
  });
  return { ...saved, quota: await tenantQuota(tenantId) };
}
