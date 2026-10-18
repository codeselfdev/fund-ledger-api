import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import type { SubscriptionInvoice } from '../subscription/billing.service.js';

export type BillingRequestCounts = { pending: number; awaiting_approval: number; awaiting_payment: number };
type BillingRequest = { tenant: { id: string; name: string; slug: string }; invoice: SubscriptionInvoice };

// An invoice remains actionable after its notification has been read. Count it once,
// even when both an upgrade alert and a payment alert exist for the same invoice.
const pendingInvoices = Prisma.sql`
  FROM tenants t
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(t.contact->'billing'->'invoices') = 'array'
      THEN t.contact->'billing'->'invoices' ELSE '[]'::jsonb END
  ) invoice
  WHERE t.deletion_started_at IS NULL
    AND invoice->>'status' IN ('open', 'submitted')
    AND invoice->>'id' IS NOT NULL`;

export async function billingRequestCounts(): Promise<BillingRequestCounts> {
  const [counts] = await prisma.$queryRaw<BillingRequestCounts[]>(Prisma.sql`
    SELECT count(*)::int AS pending,
      count(*) FILTER (WHERE invoice->>'status' = 'submitted')::int AS awaiting_approval,
      count(*) FILTER (WHERE invoice->>'status' = 'open')::int AS awaiting_payment
    ${pendingInvoices}`);
  return counts!;
}

export async function billingRequests(offset = 0, status?: 'open' | 'submitted', search?: string) {
  const pattern = `%${(search ?? '').replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await prisma.$queryRaw<BillingRequest[]>(Prisma.sql`
    SELECT jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug) AS tenant, invoice
    ${pendingInvoices}
    ${status ? Prisma.sql`AND invoice->>'status' = ${status}` : Prisma.empty}
    ${search ? Prisma.sql`AND (t.name ILIKE ${pattern} OR t.slug ILIKE ${pattern}
      OR invoice->>'id' ILIKE ${pattern} OR invoice->>'payment_reference' ILIKE ${pattern})` : Prisma.empty}
    ORDER BY CASE WHEN invoice->>'status' = 'submitted' THEN 0 ELSE 1 END,
      COALESCE(invoice->>'submitted_at', invoice->>'issued_at', '') DESC, t.id, invoice->>'id'
    LIMIT 31 OFFSET ${offset}`);
  return { requests: rows.slice(0, 30), next_offset: rows.length > 30 ? offset + 30 : null };
}
