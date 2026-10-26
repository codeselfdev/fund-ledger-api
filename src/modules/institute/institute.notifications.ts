import type { Prisma } from '@prisma/client';
import { pushNotBefore } from './institute.policy.js';
export async function queueInstituteNotifications(tx: Prisma.TransactionClient, input: {
  tenantId: string; projectId: string; actorUserId?: string; userIds: string[]; timezone: string;
  type: string; title: string; entityId: string; dedupe: string; sms?: boolean;
}) {
  if (!input.userIds.length) return 0;
  const memberships = await tx.projectMembership.findMany({ where: { tenantId: input.tenantId, projectId: input.projectId, isActive: true, userId: { in: input.userIds }, user: { isActive: true } }, select: { userId: true } });
  let count = 0;
  for (const userId of new Set(memberships.map(m => m.userId))) {
    const scope = { tenantId: input.tenantId, projectId: input.projectId };
    if (await tx.instituteNotificationDelivery.findFirst({ where: { ...scope, userId, dedupeKey: input.dedupe, channel: 'inbox' } })) continue;
    await tx.notification.create({ data: { ...scope, recipientUserId: userId, actorUserId: input.actorUserId, type: input.type, title: input.title, body: input.title, entityType: 'institute', entityId: input.entityId } });
    for (const channel of ['inbox', 'push', ...(input.sms ? ['sms'] : [])]) {
      await tx.instituteNotificationDelivery.create({ data: { ...scope, userId, dedupeKey: input.dedupe, type: input.type, title: input.title, body: input.title, entityId: input.entityId, channel, status: channel === 'inbox' ? 'sent' : 'pending', notBefore: channel === 'inbox' ? new Date() : pushNotBefore(input.timezone) } });
    }
    count++;
  }
  return count;
}
