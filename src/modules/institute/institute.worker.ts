import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { prisma } from '../../core/prisma/client.js';
import { sendPushMessage } from '../../core/notifications/fcm.service.js';
import { financialTransaction } from '../accounting/transaction.js';
import { enabled, pushNotBefore, settings, today, date } from './institute.policy.js';
import { queueInstituteNotifications } from './institute.notifications.js';
let timer: NodeJS.Timeout | undefined, busy = false;
export async function queueUnmarkedAttendance(now = new Date()) {
  const projects = await prisma.project.findMany({ where: { projectType: 'institute', isActive: true } });
  for (const project of projects) {
    const config = settings(project.instituteSettings), dayText = today(config.timezone, now), dayValue = date(dayText);
    const weekday = dayValue.getUTCDay();
    if (config.week_off_days.includes(weekday)) continue;
    const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':').map(Number);
    const current = hour * 60 + minute, scope = { tenantId: project.tenantId, projectId: project.id };
    const slots = await prisma.instituteRoutineSlot.findMany({ where: { ...scope, weekday, effectiveFrom: { lte: dayValue }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: dayValue } }] }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] });
    const unmarked = new Set<string>();
    for (const slot of slots) {
      const [startHour, startMinute] = slot.startsAt.split(':').map(Number);
      if (current < startHour * 60 + startMinute + config.attendance_reminder_after_min) continue;
      const session = config.attendance_mode === 'daily' ? 1 : slots.filter(s => s.groupId === slot.groupId).findIndex(s => s.id === slot.id) + 1;
      if (await prisma.instituteAttendanceSheet.findFirst({ where: { ...scope, groupId: slot.groupId, date: dayValue, session } })) continue;
      unmarked.add(slot.groupId);
      await financialTransaction(tx => queueInstituteNotifications(tx, { ...scope, timezone: config.timezone, userIds: [slot.teacherUserId], type: 'attendance.unmarked', title: 'A class attendance sheet is waiting to be saved', entityId: slot.groupId, dedupe: `unmarked:${slot.groupId}:${dayText}:${session}` }));
    }
    if (hour >= 11 && unmarked.size) {
      const staff = await prisma.projectMembership.findMany({ where: { ...scope, isActive: true, role: { in: ['owner', 'admin'] } }, select: { userId: true } });
      await financialTransaction(tx => queueInstituteNotifications(tx, { ...scope, timezone: config.timezone, userIds: staff.map(s => s.userId), type: 'attendance.unmarked', title: `${unmarked.size} groups still have unmarked attendance`, entityId: project.id, dedupe: `unmarked-office:${dayText}` }));
    }
  }
}
export async function deliverInstituteNotifications() {
  if (!enabled() || busy) return;
  busy = true;
  try {
    const now = new Date();
    await queueUnmarkedAttendance(now);
    await prisma.instituteNotificationDelivery.updateMany({ where: { channel: { in: ['push', 'sms'] }, status: 'sending', updatedAt: { lt: new Date(Date.now() - 300000) } }, data: { status: 'pending' } });
    const rows = await prisma.instituteNotificationDelivery.findMany({ where: { channel: { in: ['push', 'sms'] }, status: 'pending', notBefore: { lte: now } }, take: 100, orderBy: { createdAt: 'asc' } });
    for (const row of rows) {
      const project = await prisma.project.findFirst({ where: { id: row.projectId, tenantId: row.tenantId, isActive: true } });
      if (!project) continue;
      const later = pushNotBefore(settings(project.instituteSettings).timezone, now);
      if (later > now) { await prisma.instituteNotificationDelivery.update({ where: { id: row.id }, data: { notBefore: later } }); continue; }
      const claimed = await prisma.instituteNotificationDelivery.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'sending', attempts: { increment: 1 } } });
      if (!claimed.count) continue;
      try {
        const membership = await prisma.projectMembership.findFirst({ where: { tenantId: row.tenantId, projectId: row.projectId, userId: row.userId, isActive: true, user: { isActive: true } }, include: { user: { include: { identity: { select: { name: true, email: true, mobile: true, isActive: true } } } } } });
        if (!membership) { await prisma.instituteNotificationDelivery.update({ where: { id: row.id }, data: { status: 'cancelled' } }); continue; }
        if (row.channel === 'sms') {
          const endpoint = process.env.INSTITUTE_SMS_WEBHOOK_URL;
          if (!endpoint) throw new Error('INSTITUTE_SMS_WEBHOOK_URL is not configured');
          const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.INSTITUTE_SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.INSTITUTE_SMS_WEBHOOK_TOKEN}` } : {}) }, body: JSON.stringify({ to: membership.user.identity.mobile, message: row.body, idempotency_key: row.id }), signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error(`SMS adapter returned ${response.status}`);
        } else if (membership.user.deviceId) {
          const result = await sendPushMessage({ tokens: [membership.user.deviceId], title: row.title, body: row.body, data: { type: row.type, tenant_id: row.tenantId, project_id: row.projectId, entity_type: 'institute', entity_id: row.entityId } });
          if (result.invalid_tokens.length) await tenantAccounts(prisma).updateMany({ where: { id: row.userId, tenantId: row.tenantId, deviceId: { in: result.invalid_tokens } }, data: { deviceId: null } });
          if (result.failed_count > 0) throw new Error(result.reason ?? 'Push delivery failed');
        }
        await prisma.instituteNotificationDelivery.update({ where: { id: row.id }, data: { status: 'sent', lastError: null } });
      } catch (error) {
        await prisma.instituteNotificationDelivery.update({ where: { id: row.id }, data: { status: row.attempts >= 9 ? 'failed' : 'pending', lastError: error instanceof Error ? error.message : 'Delivery failed', notBefore: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** row.attempts)) } });
      }
    }
  } finally { busy = false; }
}
export function startInstituteWorker() { if (!enabled() || timer) return; timer = setInterval(() => void deliverInstituteNotifications().catch(e => console.error('[institute] delivery failed', e)), 30000); timer.unref(); }
export function stopInstituteWorker() { if (timer) clearInterval(timer); timer = undefined; }
