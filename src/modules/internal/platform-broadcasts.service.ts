import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { env } from '../../config/env.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../../core/http/api-error.js';
import { sendPushMessage } from '../../core/notifications/fcm.service.js';
import { getFirebaseAdminApp } from '../../core/firebase/admin.js';

const notificationUrl = z.string().trim().max(2048).refine(value => {
  if (!/^https:\/\//i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return Boolean(url.hostname && !url.username && !url.password); }
  catch { return false; }
}, 'Use an HTTPS link without credentials.');
export const broadcastDraftSchema = z.object({
  title: z.string().trim().min(3).max(65), body: z.string().trim().min(3).max(500), url: notificationUrl.optional(),
}).strict();
export const broadcastSendSchema = z.object({
  draft: broadcastDraftSchema, request_key: z.string().uuid(),
  preview_token: z.string().length(64), expires_at: z.string().datetime(),
}).strict();
type Draft = z.infer<typeof broadcastDraftSchema>;
type Send = z.infer<typeof broadcastSendSchema>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const eligible = { isActive: true, tenant: { deletionStartedAt: null }, deviceId: { not: null } } satisfies Prisma.UserWhereInput;
const userSelect = { id: true, tenantId: true, deviceId: true } satisfies Prisma.UserSelect;
type Recipient = { id: string; tenantId: string; deviceId: string | null };
export function broadcastAudience(users: Recipient[]) {
  const recipients = users.filter(user => user.deviceId?.trim());
  const devices = new Map<string, string[]>();
  for (const user of recipients) {
    const key = hash(user.deviceId!.trim());
    devices.set(key, [...(devices.get(key) ?? []), user.id]);
  }
  return { recipients, devices, reach: { devices: devices.size, accounts: recipients.length,
    organizations: new Set(recipients.map(user => user.tenantId)).size } };
}

export function createPlatformBroadcasts(db = prisma, push = sendPushMessage,
  configured = () => Boolean(getFirebaseAdminApp()), secret = env.internalApiKey ?? '') {
  async function audience(client: Prisma.TransactionClient = db) {
    return broadcastAudience(await client.user.findMany({ where: eligible, select: userSelect, orderBy: { id: 'asc' } }));
  }
  function reviewToken(actor: string, draft: Draft, users: Recipient[], expires: string) {
    return createHmac('sha256', secret).update(JSON.stringify({ actor, draft, expires,
      users: users.map(user => [user.id, user.tenantId, hash(user.deviceId!.trim())]).sort((a, b) => a[0].localeCompare(b[0])) })).digest('hex');
  }
  async function reach() { return { ...(await audience()).reach, push_configured: configured() }; }
  async function preview(actor: string, draft: Draft) {
    const current = await audience(), expires_at = new Date(Date.now() + 15 * 60000).toISOString();
    return { ...current.reach, push_configured: configured(), draft, expires_at,
      preview_token: reviewToken(actor, draft, current.recipients, expires_at) };
  }
  async function summary(id: string, client: Prisma.TransactionClient = db) {
    const row = await client.platformBroadcast.findUnique({ where: { id } });
    if (!row) throw notFound('Notification not found');
    const groups = await client.platformBroadcastDelivery.groupBy({ by: ['status'], where: { broadcastId: id }, _count: true });
    return { id: row.id, title: row.title, body: row.body, ...(row.actionUrl ? { url: row.actionUrl } : {}), created_at: row.createdAt, created_by: row.actor,
      devices: row.deviceCount, accounts: row.accountCount, organizations: row.organizationCount,
      delivery: Object.fromEntries(['pending', 'sent', 'failed', 'skipped'].map(status => [status, groups.find(group => group.status === status)?._count ?? 0])) };
  }
  async function send(actor: string, input: Send) {
    const payloadHash = hash(JSON.stringify(input.draft));
    const previous = await db.platformBroadcast.findUnique({ where: { actor_requestKey: { actor, requestKey: input.request_key } } });
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw conflict('This request was already used for another message.');
      return summary(previous.id);
    }
    if (!configured()) throw serviceUnavailable('Push delivery is not configured on the API.');
    const expires = Date.parse(input.expires_at);
    if (!Number.isFinite(expires) || expires < Date.now() || expires > Date.now() + 15 * 60000) throw conflict('The preview expired. Review the message again.');
    let id: string;
    try {
      id = await db.$transaction(async tx => {
        const current = await audience(tx);
        if (reviewToken(actor, input.draft, current.recipients, input.expires_at) !== input.preview_token)
          throw conflict('The message or recipients changed. Review the message again.');
        if (!current.devices.size) throw badRequest('No registered devices are available.');
        const row = await tx.platformBroadcast.create({ data: { actor, requestKey: input.request_key, payloadHash,
          title: input.draft.title, body: input.draft.body, actionUrl: input.draft.url, deviceCount: current.reach.devices, accountCount: current.reach.accounts, organizationCount: current.reach.organizations } });
        const deliveries = [...current.devices].map(([tokenHash, recipientIds]) => ({ broadcastId: row.id, tokenHash, recipientIds }));
        for (let i = 0; i < deliveries.length; i += 1000) await tx.platformBroadcastDelivery.createMany({ data: deliveries.slice(i, i + 1000) });
        for (let i = 0; i < current.recipients.length; i += 1000) await tx.notification.createMany({ data: current.recipients.slice(i, i + 1000).map(user => ({
          id: `broadcast:${row.id}:${user.id}`, tenantId: user.tenantId, recipientUserId: user.id,
          type: 'announcement.platform', title: input.draft.title, body: input.draft.body, actionUrl: input.draft.url, entityType: 'platform_broadcast', entityId: row.id,
        })), skipDuplicates: true });
        await tx.internalAudit.create({ data: { actor, action: 'notification.broadcast_queued', metadata: { broadcast_id: row.id, ...current.reach } } });
        return row.id;
      }, { isolationLevel: 'RepeatableRead', timeout: 60000 });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const existing = await db.platformBroadcast.findUnique({ where: { actor_requestKey: { actor, requestKey: input.request_key } } });
      if (!existing || existing.payloadHash !== payloadHash) throw conflict('This request was already used for another message.');
      id = existing.id;
    }
    return summary(id);
  }
  async function history(offset = 0) {
    const rows = await db.platformBroadcast.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: 31, select: { id: true } });
    return { notifications: await Promise.all(rows.slice(0, 30).map(row => summary(row.id))), next_offset: rows.length > 30 ? offset + 30 : null };
  }
  async function retry(actor: string, id: string) {
    await db.$transaction(async tx => {
      if (!await tx.platformBroadcast.findUnique({ where: { id } })) throw notFound('Notification not found');
      const result = await tx.platformBroadcastDelivery.updateMany({ where: { broadcastId: id, status: 'failed' },
        data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), leaseToken: null, leaseUntil: null, lastError: null } });
      await tx.internalAudit.create({ data: { actor, action: 'notification.broadcast_retried', metadata: { broadcast_id: id, devices: result.count } } });
    });
    return summary(id);
  }
  async function deliver() {
    const now = new Date();
    await db.platformBroadcastDelivery.updateMany({ where: { status: 'pending', attempts: { gte: 5 }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { status: 'failed', lastError: 'retry_limit_reached', leaseToken: null, leaseUntil: null } });
    const available = { status: 'pending', attempts: { lt: 5 }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
    const rows = await db.platformBroadcastDelivery.findMany({ where: available, orderBy: { createdAt: 'asc' }, take: 50, include: { broadcast: true } });
    for (const row of rows) {
      const leaseToken = randomUUID();
      const claimed = await db.platformBroadcastDelivery.updateMany({ where: { id: row.id, ...available },
        data: { leaseToken, leaseUntil: new Date(Date.now() + 300000), attempts: { increment: 1 } } });
      if (!claimed.count) continue;
      const finish = (data: Prisma.PlatformBroadcastDeliveryUpdateManyMutationInput) => db.platformBroadcastDelivery.updateMany({
        where: { id: row.id, leaseToken }, data: { ...data, leaseToken: null, leaseUntil: null },
      });
      try {
        const users = await db.user.findMany({ where: { ...eligible, id: { in: row.recipientIds } }, select: userSelect });
        const token = users.map(user => user.deviceId?.trim()).find(value => value && hash(value) === row.tokenHash);
        if (!token) { await finish({ status: 'skipped', lastError: 'recipient_unavailable' }); continue; }
        const result = await push({ tokens: [token], title: row.broadcast.title, body: row.broadcast.body,
          data: { type: 'announcement.platform', entity_type: 'platform_broadcast', entity_id: row.broadcastId, ...(row.broadcast.actionUrl ? { url: row.broadcast.actionUrl } : {}) } });
        if (result.invalid_tokens.includes(token)) {
          await db.user.updateMany({ where: { deviceId: token }, data: { deviceId: null } });
          await finish({ status: 'skipped', lastError: 'invalid_device_token' }); continue;
        }
        if (result.sent_count !== 1) throw new Error('push_unavailable');
        await finish({ status: 'sent', sentAt: new Date(), lastError: null });
      } catch {
        await finish({ status: row.attempts + 1 >= 5 ? 'failed' : 'pending', lastError: 'provider_unavailable',
          nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts)) });
      }
    }
  }
  return { reach, preview, send, summary, history, retry, deliver };
}
export const platformBroadcasts = createPlatformBroadcasts();
let timer: ReturnType<typeof setInterval> | undefined, running = false;
export function startPlatformBroadcasts() {
  if (timer) return;
  const run = async () => {
    if (running) return;
    running = true;
    try { await platformBroadcasts.deliver(); }
    catch { console.error('[platform-broadcasts] delivery failed'); }
    finally { running = false; }
  };
  timer = setInterval(() => void run(), 15000); timer.unref(); void run();
}
export function stopPlatformBroadcasts() { if (timer) clearInterval(timer); timer = undefined; }
