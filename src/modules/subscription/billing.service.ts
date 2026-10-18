import { billingPaymentSchema, billingReceipt, type BillingPaymentInput, type BillingReceiptFile } from './billing-proof.service.js';
import { storeObject, deleteObject } from '../../core/storage/object-storage.service.js';
import { tenantQuota } from "../../core/subscription/quota.service.js";
import { PACKAGES, type PackageId, type BillingCycle } from "../../core/subscription/packages.js";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { renewTenantSubscription } from "../../core/subscription/subscription.service.js";

export interface SubscriptionInvoice {
  payment_amount?: number; payment_request_key?: string; receipt?: { id: string; file_name: string; mime_type: string; size: number };
  package?: PackageId; billing_cycle?: BillingCycle;
  id: string; amount: number; currency: string; status: "open" | "submitted" | "approved" | "rejected";
  instructions: string; issued_at: string; payment_reference: string | null; submitted_at: string | null;
  approved_at: string | null; rejection_reason: string | null; period_ends_at: string | null;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function invoicesFromContact(contact: unknown): SubscriptionInvoice[] {
  const invoices = record(record(contact).billing).invoices;
  return Array.isArray(invoices) ? invoices as SubscriptionInvoice[] : [];
}

/** Compare-and-swap protects concurrent approvals without granting customer-controlled renewals. */
async function mutateBilling(tenantId: string, action: string, actorUserId: string | null,
  mutate: (contact: Record<string, unknown>, invoices: SubscriptionInvoice[], tx: Prisma.TransactionClient) => { contact?: unknown; invoice: SubscriptionInvoice; unchanged?: boolean } | Promise<{ contact?: unknown; invoice: SubscriptionInvoice; unchanged?: boolean }>) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw notFound("Organization not found");
    if (tenant.deletionStartedAt) throw conflict("Organization cleanup has started");
    const contact = record(tenant.contact);
    const invoices = structuredClone(invoicesFromContact(contact));
    const result = await mutate(contact, invoices, tx);
    if (result.unchanged) return result.invoice;
    const next = { ...record(result.contact ?? contact), billing: { ...record(contact.billing), invoices } };
    const updated = await tx.tenant.updateMany({ where: { id: tenant.id, updatedAt: tenant.updatedAt },
      data: { contact: JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue } });
    if (updated.count !== 1) throw conflict("Billing was updated concurrently. Reload and retry.");
    await tx.activity.create({ data: { tenantId, actorUserId, action, entityType: "subscription_invoice", entityId: result.invoice.id,
      after: JSON.parse(JSON.stringify(result.invoice)) as Prisma.InputJsonValue } });
    return result.invoice;
  });
}
export function issueInvoice(tenantId: string, amount: number, currency: string, instructions: string, selection?: { package: PackageId; billing_cycle: BillingCycle }) {
  return mutateBilling(tenantId, "subscription.invoice_issued", null, (_contact, invoices) => {
    if (invoices.some(row => row.status !== "approved")) throw conflict("An unpaid invoice already exists");
    const invoice: SubscriptionInvoice = { ...selection, id: randomUUID(), amount, currency, instructions, status: "open", issued_at: new Date().toISOString(),
      payment_reference: null, submitted_at: null, approved_at: null, rejection_reason: null, period_ends_at: null };
    invoices.push(invoice); return { invoice };
  });
}
export async function submitInvoicePayment(tenantId: string, invoiceId: string, userId: string, raw: BillingPaymentInput, file?: BillingReceiptFile) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(invoiceId)) throw badRequest('Invalid invoice ID.');
  const input = billingPaymentSchema.parse(raw), proof = billingReceipt(file);
  const storageKey = `${tenantId}/billing/${invoiceId}/${proof.id}`;
  let keep = false;
  await storeObject({ storageKey, buffer: file!.buffer, contentType: proof.mimeType });
  try {
    const result = await mutateBilling(tenantId, 'subscription.payment_submitted', userId, async (_contact, invoices, tx) => {
      const invoice = invoices.find(row => row.id === invoiceId);
      if (!invoice) throw notFound('Invoice not found');
      if (invoice.payment_request_key === input.request_key) {
        const old = invoice.receipt ? await tx.subscriptionPaymentReceipt.findFirst({ where: { id: invoice.receipt.id, tenantId, invoiceId, userId } }) : null;
        if (invoice.payment_reference !== input.payment_reference || invoice.payment_amount !== input.payment_amount || old?.contentHash !== proof.contentHash) throw conflict('This payment request key was already used with different details.');
        return { invoice, unchanged: true };
      }
      if (invoice.status === 'approved') throw conflict('Invoice has already been approved');
      if (invoice.status === 'submitted') throw conflict('Payment is already awaiting review');
      if (input.payment_amount !== invoice.amount) throw badRequest(`The paid amount must match the invoice: ${invoice.currency} ${invoice.amount}. Contact support for partial or different payments.`);
      await tx.subscriptionPaymentReceipt.create({ data: { ...proof, tenantId, invoiceId, userId, storageKey } });
      Object.assign(invoice, { status: 'submitted', payment_reference: input.payment_reference, payment_amount: input.payment_amount, payment_request_key: input.request_key,
        receipt: { id: proof.id, file_name: proof.fileName, mime_type: proof.mimeType, size: proof.size }, submitted_at: new Date().toISOString(), rejection_reason: null });
      await tx.platformAlert.upsert({ where: { eventKey: `billing_payment:${invoice.id}:${input.request_key}` }, update: {}, create: { tenantId, userId, kind: 'billing_payment', eventKey: `billing_payment:${invoice.id}:${input.request_key}` } });
      return { invoice };
    });
    keep = result.receipt?.id === proof.id;
    return result;
  } finally { if (!keep) await deleteObject(storageKey); }
}
export function reviewInvoicePayment(tenantId: string, invoiceId: string, decision: "approve" | "reject", reason?: string, expectedRequestKey?: string) {
  return mutateBilling(tenantId, `subscription.payment_${decision}d`, null, async (contact, invoices, tx) => {
    const invoice = invoices.find(row => row.id === invoiceId);
    if (!invoice) throw notFound("Invoice not found");
    if (expectedRequestKey && invoice.payment_request_key !== expectedRequestKey) throw conflict("This payment proof changed after you opened it. Refresh and review the current receipt before deciding.");
    if (invoice.status === "approved" && decision === "approve") return { invoice, unchanged: true }; // Idempotent; period never extends twice.
    if (invoice.status !== "submitted" || !invoice.payment_reference) throw badRequest("A submitted payment is required");
    if (decision === "reject") {
      if (!reason?.trim()) throw badRequest("A rejection reason is required");
      Object.assign(invoice, { status: "rejected", rejection_reason: reason.trim() }); return { invoice };
    }
    if (!invoice.receipt || invoice.payment_amount !== invoice.amount) throw badRequest('A receipt and the full invoice payment amount are required before approval. Reject this submission and ask the customer to resubmit complete proof.');
    const proof = await tx.subscriptionPaymentReceipt.findFirst({ where: { id: invoice.receipt.id, tenantId, invoiceId } });
    if (!proof) throw badRequest('The payment receipt is unavailable. Ask the customer to submit complete proof.');
    if (invoice.package) {
      const usage = await tenantQuota(tenantId, tx), plan = PACKAGES[invoice.package];
      if ((plan.users !== null && usage.users.used > plan.users) || (plan.documents !== null && usage.documents.used > plan.documents) || (plan.projects !== null && usage.projects.used > plan.projects))
        throw conflict("Organization usage no longer fits this package. Resolve its usage or issue a larger package before approval.");
    }
    const renewed = renewTenantSubscription(contact, new Date(), invoice.package ? { package: invoice.package, billing_cycle: invoice.billing_cycle ?? "yearly" } : undefined);
    Object.assign(invoice, { status: "approved", approved_at: new Date().toISOString(), period_ends_at: renewed.subscription.current_period_end_at });
    return { contact: renewed.contact, invoice };
  });
}
