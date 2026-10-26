import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { env } from '../../config/env.js';
import { getFirebaseAdminApp } from '../../core/firebase/admin.js';
import { sendMail } from '../../core/mail/mailer.service.js';
import { sendPushMessage } from '../../core/notifications/fcm.service.js';

export const MASTER_ALERT_KINDS = ['support_message', 'billing_upgrade', 'billing_payment'];
export function masterAlertIdentity() {
  const email = (process.env.MASTER_USER_EMAIL?.trim() || process.env.Master_user_email?.trim() || '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  try {
    const origin = new URL(process.env.MASTER_WEB_ORIGIN ?? 'https://fundnesta.appnesta.com');
    const local = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(origin.hostname);
    if ((origin.protocol !== 'https:' && !(local && origin.protocol === 'http:')) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
    return { email, userId: process.env.MASTER_USER_ID?.trim() || undefined, origin: origin.origin };
  } catch { return null; }
}
export function masterAlertLink(alert: { kind: string; ticketId: string | null; tenantId: string; eventKey: string }, origin: string) {
  const link = new URL('/support/admin', origin);
  link.searchParams.set('tab', alert.kind === 'support_message' ? 'support' : 'billing');
  if (alert.kind === 'support_message' && alert.ticketId) link.searchParams.set('ticket', alert.ticketId);
  if (['billing_upgrade', 'billing_payment'].includes(alert.kind)) {
    link.searchParams.set('organization', alert.tenantId);
    const invoice = alert.eventKey.split(':')[1];
    if (invoice) link.searchParams.set('invoice', invoice);
  }
  return link.toString();
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sameIdentity = (a: NonNullable<ReturnType<typeof masterAlertIdentity>>, b: ReturnType<typeof masterAlertIdentity>) =>
  b && a.email === b.email && a.userId === b.userId && a.origin === b.origin;

export function createMasterAlertNotifier(db = prisma, transports = { email: sendMail, push: sendPushMessage },
  ready = { email: () => Boolean(env.smtp.user && env.smtp.pass), push: () => Boolean(getFirebaseAdminApp()) },
  identity = masterAlertIdentity) {
  async function deliver() {
    const now = new Date();
    const available = { status: 'pending', nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
    const rows = await db.masterAlertDelivery.findMany({ where: available, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: 30,
      include: { alert: { include: { tenant: { select: { name: true, deletionStartedAt: true } } } } } });
    for (const row of rows) {
      const leaseToken = randomUUID();
      const claim = await db.masterAlertDelivery.updateMany({ where: { id: row.id, ...available },
        data: { leaseToken, leaseUntil: new Date(Date.now() + 300000) } });
      if (!claim.count) continue;
      const finish = (data: Prisma.MasterAlertDeliveryUpdateManyMutationInput) => db.masterAlertDelivery.updateMany({
        where: { id: row.id, leaseToken }, data: { ...data, leaseUntil: null, leaseToken: null },
      });
      const wait = (reason: string) => finish({ status: 'pending', lastError: reason, nextAttemptAt: new Date(Date.now() + 60_000) });
      try {
        const alert = row.alert;
        if (!alert || alert.tenantId !== row.tenantId || alert.tenant.deletionStartedAt || !MASTER_ALERT_KINDS.includes(alert.kind)) {
          await finish({ status: 'skipped', lastError: 'request_unavailable' }); continue;
        }
        const master = identity();
        if (!master) { await wait('master_not_configured'); continue; }
        const link = masterAlertLink(alert, master.origin);
        const title = alert.kind === 'support_message' ? 'Fund Nesta · New support message'
          : alert.kind === 'billing_payment' ? 'Fund Nesta · Payment awaiting review' : 'Fund Nesta · New billing request';
        const body = alert.kind === 'support_message' ? 'A customer support message needs your attention.'
          : alert.kind === 'billing_payment' ? 'A customer submitted payment proof. Review it in private administration.' : 'A customer requested a subscription plan. Review it in private administration.';
        if (row.channel === 'email') {
          if (!ready.email()) { await wait('smtp_not_configured'); continue; }
          const accepted = await transports.email({ to: master.email, fromName: 'Fund Nesta administration', subject: title,
            text: [body, `Organization: ${alert.tenant.name}`, `Request reference: ${alert.ticketId ?? alert.eventKey.split(':')[1] ?? alert.id}`,
              `Review request: ${link}`, 'Sign in with the configured master email and enter the master security code to review.'].join('\n\n') });
          if (!accepted) throw new Error('email_not_accepted');
        } else if (row.channel === 'push') {
          if (!ready.push()) { await wait('push_not_configured'); continue; }
          const users = await db.user.findMany({ where: {
            isActive: true, email: { equals: master.email, mode: 'insensitive' }, tenant: { deletionStartedAt: null },
            ...(master.userId ? { id: master.userId } : { sessions: { some: {
              verifiedEmail: { equals: master.email, mode: 'insensitive' }, impersonatorSessionId: null,
            } } }),
          }, select: { id: true, deviceId: true } });
          const devices = new Map<string, { token: string; ids: string[] }>();
          for (const user of users) {
            const token = user.deviceId?.trim(); if (!token) continue;
            const key = hash(token), existing = devices.get(key);
            devices.set(key, { token, ids: [...(existing?.ids ?? []), user.id] });
          }
          if (!devices.size) { await wait('no_registered_master_device'); continue; }
          const accepted = new Set(row.acceptedPushHashes);
          let failed = false;
          for (const [key, device] of devices) {
            if (accepted.has(key)) continue;
            if (!sameIdentity(master, identity())) throw new Error('master_changed');
            try {
              const result = await transports.push({ tokens: [device.token], title, body, data: {
                type: 'master_admin.request', entity_type: 'platform_alert', entity_id: alert.id, url: link,
              } });
              if (result.invalid_tokens.includes(device.token)) {
                await db.user.updateMany({ where: { id: { in: device.ids }, deviceId: device.token }, data: { deviceId: null } });
                continue;
              }
              if (result.sent_count !== 1) { failed = true; continue; }
              const recorded = await db.masterAlertDelivery.updateMany({ where: { id: row.id, leaseToken }, data: { acceptedPushHashes: { push: key } } });
              if (!recorded.count) return;
              accepted.add(key);
            } catch { failed = true; }
          }
          if (failed) throw new Error('push_not_accepted');
          if (!accepted.size) { await wait('no_registered_master_device'); continue; }
        } else { await finish({ status: 'skipped', lastError: 'unsupported_channel' }); continue; }
        await finish({ status: 'sent', sentAt: new Date(), lastError: null, attempts: { increment: 1 } });
      } catch {
        // Keep retrying capped at hourly intervals; a prolonged outage cannot silently discard an admin request.
        await finish({ status: 'pending', attempts: { increment: 1 }, lastError: 'delivery_unavailable',
          nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6))) });
      }
    }
  }
  return { deliver };
}
const notifier = createMasterAlertNotifier();
let timer: ReturnType<typeof setInterval> | undefined, running = false;
export function startMasterAdminAlerts() {
  if (timer) return;
  const run = async () => {
    if (running) return; running = true;
    try { await notifier.deliver(); } catch { console.error('[master-admin-alerts] delivery failed'); } finally { running = false; }
  };
  timer = setInterval(() => void run(), 15000); timer.unref(); void run();
}
export function stopMasterAdminAlerts() { if (timer) clearInterval(timer); timer = undefined; }
