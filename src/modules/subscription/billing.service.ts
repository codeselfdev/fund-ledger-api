import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { renewTenantSubscription } from "../../core/subscription/subscription.service.js";

export interface SubscriptionInvoice {
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
  mutate: (contact: Record<string, unknown>, invoices: SubscriptionInvoice[]) => { contact?: unknown; invoice: SubscriptionInvoice }) {
  return prisma.$transaction(async tx => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw notFound("Organization not found");
    const contact = record(tenant.contact);
    const invoices = structuredClone(invoicesFromContact(contact));
    const result = mutate(contact, invoices);
    const next = { ...record(result.contact ?? contact), billing: { ...record(contact.billing), invoices } };
    const updated = await tx.tenant.updateMany({ where: { id: tenant.id, updatedAt: tenant.updatedAt },
      data: { contact: JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue } });
    if (updated.count !== 1) throw conflict("Billing was updated concurrently. Reload and retry.");
    await tx.activity.create({ data: { tenantId, actorUserId, action, entityType: "subscription_invoice", entityId: result.invoice.id,
      after: JSON.parse(JSON.stringify(result.invoice)) as Prisma.InputJsonValue } });
    return result.invoice;
  });
}
export function issueInvoice(tenantId: string, amount: number, currency: string, instructions: string) {
  return mutateBilling(tenantId, "subscription.invoice_issued", null, (_contact, invoices) => {
    if (invoices.some(row => row.status !== "approved")) throw conflict("An unpaid invoice already exists");
    const invoice: SubscriptionInvoice = { id: randomUUID(), amount, currency, instructions, status: "open", issued_at: new Date().toISOString(),
      payment_reference: null, submitted_at: null, approved_at: null, rejection_reason: null, period_ends_at: null };
    invoices.push(invoice); return { invoice };
  });
}
export function submitInvoicePayment(tenantId: string, invoiceId: string, userId: string, reference: string) {
  return mutateBilling(tenantId, "subscription.payment_submitted", userId, (_contact, invoices) => {
    const invoice = invoices.find(row => row.id === invoiceId);
    if (!invoice) throw notFound("Invoice not found");
    if (invoice.status === "approved") throw conflict("Invoice has already been approved");
    if (invoice.status === "submitted") throw conflict("Payment is already awaiting review");
    Object.assign(invoice, { status: "submitted", payment_reference: reference, submitted_at: new Date().toISOString(), rejection_reason: null });
    return { invoice };
  });
}
export function reviewInvoicePayment(tenantId: string, invoiceId: string, decision: "approve" | "reject", reason?: string) {
  return mutateBilling(tenantId, `subscription.payment_${decision}d`, null, (contact, invoices) => {
    const invoice = invoices.find(row => row.id === invoiceId);
    if (!invoice) throw notFound("Invoice not found");
    if (invoice.status === "approved" && decision === "approve") return { invoice }; // Idempotent; period never extends twice.
    if (invoice.status !== "submitted" || !invoice.payment_reference) throw badRequest("A submitted payment is required");
    if (decision === "reject") {
      if (!reason?.trim()) throw badRequest("A rejection reason is required");
      Object.assign(invoice, { status: "rejected", rejection_reason: reason.trim() }); return { invoice };
    }
    const renewed = renewTenantSubscription(contact);
    Object.assign(invoice, { status: "approved", approved_at: new Date().toISOString(), period_ends_at: renewed.subscription.current_period_end_at });
    return { contact: renewed.contact, invoice };
  });
}
