import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { evaluateSubscription } from '../../core/subscription/subscription.service.js';
import { packageId } from '../../core/subscription/packages.js';
import { allowancePeriod, extraFeatureCredits, featureLimit, hasAssistant } from '../assistant/assistant.policy.js';
import { organizationAiUsage } from './ai-usage.service.js';

const action = 'assistant.credits_extended';
export const aiCreditGrantSchema = z.object({
  request_key: z.string().uuid(), channel: z.enum(['ai_chat', 'whatsapp_bot']),
  credits: z.number().int().positive().max(1000000), reason: z.string().trim().min(3).max(1000),
  period_start: z.string().datetime(),
}).strict();

export async function grantAiCredits(tenantId: string, input: z.infer<typeof aiCreditGrantSchema>, actor: string) {
  return prisma.$transaction(async tx => {
    // Use the reservation lock so grants, package resets and chat requests cannot race.
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw notFound('Organization not found');
    if (tenant.deletionStartedAt) throw conflict('Organization cleanup has started');
    const previous = await tx.internalAudit.findFirst({ where: { tenantId, action,
      metadata: { path: ['request_key'], equals: input.request_key } } });
    if (previous) {
      const saved = previous.metadata as Record<string, unknown>;
      if (saved.channel !== input.channel || saved.credits !== input.credits || saved.reason !== input.reason || saved.period_start !== input.period_start)
        throw conflict('This credit request key was already used with different data');
      return { ...saved, replayed: true };
    }
    const now = new Date(), period = allowancePeriod(tenant.contact, now);
    if (input.period_start !== period.start.toISOString()) throw conflict('The allowance period changed. Refresh usage before extending credits.');
    const customActive = input.channel === 'ai_chat' && packageId(tenant.contact) === 'custom' && evaluateSubscription(tenant.contact, now).status === 'active';
    if (!customActive && !hasAssistant(tenant.contact, input.channel, now)) throw badRequest('An active eligible plan is required for this AI channel.');
    const previousLimit = featureLimit(input.channel, tenant.contact, now), limit = previousLimit + input.credits;
    if (!Number.isSafeInteger(limit) || limit > 2147483647) throw badRequest('The resulting credit quota is too large');
    const contact = tenant.contact && typeof tenant.contact === 'object' && !Array.isArray(tenant.contact) ? tenant.contact : {};
    const extension = { period_start: period.start.toISOString(),
      ai_chat: extraFeatureCredits('ai_chat', contact, now), whatsapp_bot: extraFeatureCredits('whatsapp_bot', contact, now) };
    extension[input.channel] += input.credits;
    await tx.tenant.update({ where: { id: tenantId }, data: { contact: { ...contact, ai_credit_extension: extension } as Prisma.InputJsonValue } });
    const metadata = { ...input, previous_limit: previousLimit, limit, expires_at: period.end.toISOString() };
    await tx.internalAudit.create({ data: { tenantId, actor, action, metadata } });
    return { ...metadata, replayed: false };
  });
}

export async function aiCreditTenants(offset: number, search?: string) {
  const where: Prisma.TenantWhereInput = search ? { OR: [
    { name: { contains: search, mode: 'insensitive' } }, { slug: { contains: search, mode: 'insensitive' } },
    { users: { some: { isActive: true, memberships: { some: { role: 'owner', isActive: true } },
      OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } } },
  ] } : {};
  const rows = await prisma.tenant.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: 51,
    select: { id: true, name: true, slug: true, contact: true, deletionStartedAt: true,
      users: { where: { isActive: true, memberships: { some: { role: 'owner', isActive: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1, select: { name: true, email: true } } } });
  const tenants = rows.slice(0, 50), usage = await organizationAiUsage(tenants);
  return { tenants: tenants.map(t => ({ id: t.id, name: t.name, slug: t.slug, package: packageId(t.contact),
    owner: t.users[0] ?? null, frozen: !!t.deletionStartedAt, ai_usage: usage.get(t.id),
    custom_active: packageId(t.contact) === 'custom' && evaluateSubscription(t.contact).status === 'active' })),
    next_offset: rows.length > 50 ? offset + 50 : null };
}

export async function aiCreditHistory(tenantId: string, offset: number) {
  if (!await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })) throw notFound('Organization not found');
  const rows = await prisma.internalAudit.findMany({ where: { tenantId, action }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: 21 });
  return { grants: rows.slice(0, 20).map(row => ({ id: row.id, actor: row.actor, created_at: row.createdAt, ...row.metadata as Record<string, unknown> })),
    next_offset: rows.length > 20 ? offset + 20 : null };
}
