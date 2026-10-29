import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { listInvoices, type SubscriptionInvoice } from '../subscription/billing.service.js';
export type BillingRequestCounts = { pending: number; awaiting_approval: number; awaiting_payment: number };
export async function billingRequestCounts(): Promise<BillingRequestCounts> {
  const where = { tenant: { deletionStartedAt: null } };
  const [awaiting_approval, awaiting_payment] = await Promise.all([
    prisma.subscriptionInvoice.count({ where: { ...where, status: 'submitted' } }),
    prisma.subscriptionInvoice.count({ where: { ...where, status: 'open' } }),
  ]);
  return { pending: awaiting_approval + awaiting_payment, awaiting_approval, awaiting_payment };
}
export async function billingRequests(offset = 0, status?: 'open' | 'submitted', search?: string) {
  const pattern = `%${(search ?? '').replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await prisma.$queryRaw<Array<{ tenant_id: string; id: string }>>(Prisma.sql`
    SELECT i.tenant_id,i.id FROM subscription_invoices i JOIN tenants t ON t.id=i.tenant_id
    WHERE t.deletion_started_at IS NULL AND i.status IN ('open','submitted')
    ${status ? Prisma.sql`AND i.status::text=${status}` : Prisma.empty}
    ${search ? Prisma.sql`AND (t.name ILIKE ${pattern} OR t.slug ILIKE ${pattern} OR i.id ILIKE ${pattern} OR i.payment_reference ILIKE ${pattern})` : Prisma.empty}
    ORDER BY CASE WHEN i.status='submitted' THEN 0 ELSE 1 END,COALESCE(i.submitted_at,i.issued_at) DESC,t.id,i.id LIMIT 31 OFFSET ${offset}`);
  const ids = [...new Set(rows.slice(0,30).map(row => row.tenant_id))];
  const tenants = await prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } });
  const invoices = new Map(await Promise.all(ids.map(async id => [id, await listInvoices(id)] as const)));
  const requests = rows.slice(0,30).flatMap(row => {
    const tenant = tenants.find(t => t.id === row.tenant_id), invoice = invoices.get(row.tenant_id)?.find(i => i.id === row.id);
    return tenant && invoice ? [{tenant,invoice}] : [];
  });
  return { requests, next_offset: rows.length > 30 ? offset + 30 : null };
}
