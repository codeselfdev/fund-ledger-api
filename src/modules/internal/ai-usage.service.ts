import { prisma } from '../../core/prisma/client.js';
import { allowancePeriod, CHANNELS, featureLimit } from '../assistant/assistant.policy.js';

/** Counts the same admitted replies as quota enforcement, including queued/failed attempts. */
export async function organizationAiUsage(tenants: Array<{ id: string; contact: unknown }>, db = prisma, now = new Date()) {
  if (!tenants.length) return new Map();
  const periods = new Map(tenants.map(t => [t.id, allowancePeriod(t.contact, now)]));
  const [current, lifetime] = await Promise.all([
    db.assistantReply.groupBy({ by: ['tenantId', 'channel'], where: { status: { not: 'cancelled' },
      OR: tenants.map(t => ({ tenantId: t.id, periodStart: periods.get(t.id)!.start })) }, _count: true }),
    db.assistantReply.groupBy({ by: ['tenantId'], where: { tenantId: { in: tenants.map(t => t.id) }, status: { not: 'cancelled' } }, _count: true }),
  ]);
  return new Map(tenants.map(t => {
    const period = periods.get(t.id)!;
    const channels = Object.fromEntries(CHANNELS.map(channel => [channel, {
      used: current.find(row => row.tenantId === t.id && row.channel === channel)?._count ?? 0,
      limit: featureLimit(channel, t.contact),
    }]));
    return [t.id, { period_start: period.start.toISOString(), resets_at: period.end.toISOString(),
      used: Object.values(channels).reduce((sum, channel) => sum + channel.used, 0),
      lifetime_used: lifetime.find(row => row.tenantId === t.id)?._count ?? 0, channels }];
  }));
}
