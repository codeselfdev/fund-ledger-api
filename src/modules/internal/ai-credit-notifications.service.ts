import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { sendMail } from '../../core/mail/mailer.service.js';
import { sendPushMessage } from '../../core/notifications/fcm.service.js';

const type = 'ai.credits_extended';
/** Queue after idempotency checks, in the same transaction as the quota and audit. */
export async function queueAiCreditNotification(tx: Prisma.TransactionClient,
  tenant: { id: string; name: string }, grant: { id: string; channel: string; credits: number; limit: number; expires_at: string }) {
  // Match the primary active owner shown in the platform admin tenant row.
  const owner = await tx.user.findFirst({ where: { tenantId: tenant.id, isActive: true,
    memberships: { some: { role: 'owner', isActive: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
  if (!owner) return { notification_id: null };
  const id = `ai-credit:${grant.id}`, channel = grant.channel === 'ai_chat' ? 'AI chat' : 'WhatsApp AI';
  const expires = new Date(grant.expires_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const body = `${tenant.name}: ${grant.credits.toLocaleString('en-GB')} extra ${channel} credits added. Your quota is now ${grant.limit.toLocaleString('en-GB')} credits. Extra credits expire ${expires} UTC, or earlier if your package quota resets.`;
  await tx.notification.create({ data: { id, tenantId: tenant.id, recipientUserId: owner.id, type,
    title: 'Your AI credits have been extended', body, entityType: 'ai_credit_grant', entityId: grant.id } });
  await tx.aiCreditDelivery.createMany({ data: ['push', 'email'].map(channel => ({ tenantId: tenant.id, notificationId: id, channel })) });
  return { notification_id: id };
}

export function createAiCreditNotifier(db = prisma, transports = { push: sendPushMessage, email: sendMail }) {
  async function deliver() {
    const now = new Date();
    await db.aiCreditDelivery.updateMany({ where: { status: 'pending', attempts: { gte: 5 },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { status: 'failed', lastError: 'retry_limit_reached', leaseUntil: null, leaseToken: null } });
    const available = { status: 'pending', attempts: { lt: 5 }, nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
    const rows = await db.aiCreditDelivery.findMany({ where: available, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20 });
    for (const row of rows) {
      const leaseToken = randomUUID();
      const claim = await db.aiCreditDelivery.updateMany({ where: { id: row.id, ...available },
        data: { leaseToken, leaseUntil: new Date(Date.now() + 300000), attempts: { increment: 1 } } });
      if (!claim.count) continue;
      const finish = (data: Prisma.AiCreditDeliveryUpdateManyMutationInput) => db.aiCreditDelivery.updateMany({
        where: { id: row.id, leaseToken }, data: { ...data, leaseToken: null, leaseUntil: null } });
      try {
        const notification = await db.notification.findFirst({ where: { id: row.notificationId, tenantId: row.tenantId, type,
          recipient: { tenantId: row.tenantId, isActive: true, memberships: { some: { role: 'owner', isActive: true } } } },
          include: { recipient: true, tenant: { select: { deletionStartedAt: true } } } });
        const user = notification?.recipient;
        if (!notification || !user || user.tenantId !== row.tenantId || !user.isActive || notification.tenant.deletionStartedAt) {
          await finish({ status: 'skipped', lastError: 'recipient_unavailable' }); continue;
        }
        if (row.channel === 'push') {
          const token = user.deviceId?.trim();
          if (!token) { await finish({ status: 'skipped', lastError: 'no_registered_device' }); continue; }
          const result = await transports.push({ tokens: [token], title: notification.title, body: notification.body,
            data: { type, tenant_id: row.tenantId, entity_type: 'ai_credit_grant', entity_id: notification.entityId ?? '' } });
          if (result.invalid_tokens.includes(token)) {
            await db.user.updateMany({ where: { id: user.id, tenantId: row.tenantId, deviceId: token }, data: { deviceId: null } });
            await finish({ status: 'skipped', lastError: 'invalid_device_token' }); continue;
          }
          if (result.sent_count !== 1) throw new Error('push_unavailable');
        } else if (row.channel === 'email') {
          const email = user.email?.trim();
          if (!email) { await finish({ status: 'skipped', lastError: 'no_email_address' }); continue; }
          const accepted = await transports.email({ to: email, fromName: 'Fund Nesta', subject: notification.title,
            text: `Hello ${user.name},\n\n${notification.body}\n\nOpen Fund Nesta to use your credits. Usage is shared across your organization’s projects.` });
          if (!accepted) throw new Error('email_unavailable');
        } else { await finish({ status: 'skipped', lastError: 'unsupported_channel' }); continue; }
        await finish({ status: 'sent', sentAt: new Date(), lastError: null });
      } catch {
        await finish({ status: row.attempts + 1 >= 5 ? 'failed' : 'pending', lastError: 'provider_unavailable',
          nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts)) });
      }
    }
  }
  return { deliver };
}
const notifier = createAiCreditNotifier();
let timer: ReturnType<typeof setInterval> | undefined, running = false;
export function startAiCreditNotifications() {
  if (timer) return;
  const run = async () => {
    if (running) return;
    running = true;
    try { await notifier.deliver(); }
    catch { console.error('[ai-credit-notifications] delivery failed'); }
    finally { running = false; }
  };
  timer = setInterval(() => void run(), 15000); timer.unref(); void run();
}
export function stopAiCreditNotifications() { if (timer) clearInterval(timer); timer = undefined; }
