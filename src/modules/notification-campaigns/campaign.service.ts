import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { sendPushMessage } from '../../core/notifications/fcm.service.js';
import { sendMail } from '../../core/mail/mailer.service.js';
import { audienceLabels, fillMessage, reachFor, reviewToken, selectAudience, type Draft, type Recipient } from './campaign.policy.js';

export function createCampaignService(db: typeof prisma = prisma, transports = { sendPush: sendPushMessage, sendEmail: sendMail }) {
type Scope = { tenantId: string; projectId: string; userId: string };
const staffRoles = ['owner', 'admin', 'accountant', 'approver', 'auditor', 'cashier'];
async function loadPeople(scope: Scope): Promise<Recipient[]> {
  const [members, memberships, dues] = await Promise.all([
    db.member.findMany({ where: { tenantId: scope.tenantId, projectId: scope.projectId, status: 'active' }, orderBy: { name: 'asc' } }),
    db.projectMembership.findMany({ where: { tenantId: scope.tenantId, projectId: scope.projectId, isActive: true, user: { isActive: true } }, include: { user: true } }),
    db.due.findMany({ where: { tenantId: scope.tenantId, projectId: scope.projectId, status: { notIn: ['paid', 'waived'] } }, select: { memberId: true, amount: true, paidAmount: true, waivedAmount: true, penaltyDue: true, penaltyPaid: true } }),
  ]);
  const balances = new Map<string, number>();
  for (const due of dues) balances.set(due.memberId, (balances.get(due.memberId) ?? 0) + Math.max(0, due.amount - due.paidAmount - due.waivedAmount + due.penaltyDue - due.penaltyPaid));
  const people: Recipient[] = [];
  const users = new Set<string>();
  for (const member of members) {
    const links = memberships.filter(m => m.memberId === member.id || m.userId === member.userId);
    const user = links[0]?.user;
    if (user && users.has(user.id)) {
      const existing = people.find(p => p.userId === user.id)!;
      existing.due += balances.get(member.id) ?? 0;
      existing.staff ||= links.some(m => staffRoles.includes(m.role));
      continue;
    }
    if (user) users.add(user.id);
    people.push({ id: member.id, memberId: member.id, userId: user?.id ?? null, name: member.name, email: member.email || user?.email || null,
      push: !!user?.deviceId, due: balances.get(member.id) ?? 0, staff: links.some(m => staffRoles.includes(m.role)) });
  }
  for (const link of memberships) {
    if (users.has(link.userId)) continue;
    users.add(link.userId);
    people.push({ id: `user:${link.userId}`, memberId: null, userId: link.userId, name: link.user.name, email: link.user.email,
      push: !!link.user.deviceId, due: 0, staff: memberships.some(m => m.userId === link.userId && staffRoles.includes(m.role)) });
  }
  return people;
}
async function previewCampaign(scope: Scope, draft: Draft) {
  const people = await loadPeople(scope);
  const recipients = selectAudience(people, draft);
  if (draft.audience === 'pick' && new Set(draft.recipient_ids).size !== recipients.length) throw badRequest('Some selected members are no longer available in this project. Review the audience again.');
  if (!recipients.length) throw badRequest('This audience has no recipients');
  const project = await db.project.findFirstOrThrow({ where: { id: scope.projectId, tenantId: scope.tenantId } });
  const sample = recipients[0]!;
  return { project_id: scope.projectId, project_name: project.name, audience_label: audienceLabels[draft.audience], reach: reachFor(recipients, draft.push, draft.email),
    preview_token: reviewToken(scope.projectId, draft, recipients), sample: { title: fillMessage(draft.title, sample, project.name), body: fillMessage(draft.body, sample, project.name) }, recipients };
}
async function createCampaign(scope: Scope, draft: Draft, requestId: string, token: string) {
  const previous = await db.notificationCampaign.findFirst({ where: { tenantId: scope.tenantId, projectId: scope.projectId, createdById: scope.userId, requestId } });
  if (previous) return campaignSummary(scope, previous.id);
  const preview = await previewCampaign(scope, draft);
  if (preview.preview_token !== token) throw conflict('The audience or delivery reach changed. Review again before sending.');
  const data = preview.recipients.flatMap(person => {
    const title = fillMessage(draft.title, person, preview.project_name), body = fillMessage(draft.body, person, preview.project_name);
    return (['inbox', ...(draft.push ? ['push'] : []), ...(draft.email ? ['email'] : [])]).map(channel => ({
      recipientKey: person.id, memberId: person.memberId, userId: person.userId, email: person.email, channel, title, body,
      status: (channel === 'email' ? !!person.email : channel === 'inbox' ? !!person.userId : !!person.userId && person.push) ? 'pending' : 'skipped',
    }));
  });
  try {
    const campaign = await db.notificationCampaign.create({ data: { tenantId: scope.tenantId, projectId: scope.projectId, createdById: scope.userId, requestId,
      title: draft.title, body: draft.body, audience: draft.audience, destination: draft.destination, push: draft.push, email: draft.email, recipientCount: preview.reach.total,
      deliveries: { create: data } } });
    return campaignSummary(scope, campaign.id);
  } catch (error) {
    // A timed-out client may retry while the original request commits.
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const existing = await db.notificationCampaign.findFirstOrThrow({ where: { tenantId: scope.tenantId, projectId: scope.projectId, createdById: scope.userId, requestId } });
    return campaignSummary(scope, existing.id);
  }
}
async function campaignSummary(scope: Scope, id: string) {
  const campaign = await db.notificationCampaign.findFirst({ where: { id, tenantId: scope.tenantId, projectId: scope.projectId }, include: { createdBy: { select: { name: true } } } });
  if (!campaign) throw notFound('Notification campaign not found');
  const groups = await db.notificationDelivery.groupBy({ by: ['channel', 'status'], where: { campaignId: id }, _count: true });
  const channels = ['inbox', ...(campaign.push ? ['push'] : []), ...(campaign.email ? ['email'] : [])].map(channel => {
    const count = (status: string) => groups.find(g => g.channel === channel && g.status === status)?._count ?? 0;
    const accepted = count('sent'), failed = count('failed'), pending = count('pending') + count('sending'), skipped = count('skipped');
    return { channel, total: accepted + failed + pending, sent: accepted, failed, pending, skipped };
  });
  return { id, project_id: campaign.projectId, title: campaign.title, body: campaign.body, audience: campaign.audience, audience_label: audienceLabels[campaign.audience as Draft['audience']],
    recipient_count: campaign.recipientCount, destination: campaign.destination, created_at: campaign.createdAt, created_by: campaign.createdBy?.name ?? 'Former admin', channels };
}
async function retryCampaign(scope: Scope, id: string) {
  await campaignSummary(scope, id);
  await db.notificationDelivery.updateMany({ where: { campaignId: id, status: 'failed' }, data: { status: 'pending', error: null, lockedAt: null } });
  return campaignSummary(scope, id);
}

let running = false;
async function processCampaignQueue() {
  if (running) return;
  running = true;
  try {
    // Do not resend an ambiguous provider attempt after a crash. Surface it for an explicit retry.
    await db.notificationDelivery.updateMany({ where: { status: 'sending', lockedAt: { lt: new Date(Date.now() - 10 * 60_000) } }, data: { status: 'failed', error: 'Delivery interrupted; provider outcome unknown. Retry may duplicate this message.', lockedAt: null } });
    const rows = await db.notificationDelivery.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 100, include: { campaign: true } });
    for (const row of rows) {
      const claim = await db.notificationDelivery.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'sending', lockedAt: new Date(), attempts: { increment: 1 } } });
      if (!claim.count) continue;
      const c = row.campaign;
      try {
        const project = await db.project.findFirst({ where: { id: c.projectId, tenantId: c.tenantId, isActive: true }, select: { id: true, name: true } });
        const user = row.userId ? await db.projectMembership.findFirst({ where: { tenantId: c.tenantId, projectId: c.projectId, userId: row.userId, isActive: true, user: { isActive: true } }, include: { user: true } }) : null;
        const member = row.memberId ? await db.member.findFirst({ where: { id: row.memberId, tenantId: c.tenantId, projectId: c.projectId, status: 'active' } }) : null;
        if (!project || (row.memberId && !member) || (!row.memberId && !user) || (row.channel !== 'email' && !user)) {
          await db.notificationDelivery.update({ where: { id: row.id }, data: { status: 'skipped', error: 'Recipient no longer has project access', lockedAt: null } });
          continue;
        }
        if (row.channel === 'inbox') {
          await db.$transaction(async tx => {
            await tx.notification.upsert({ where: { id: row.id }, create: { id: row.id, tenantId: c.tenantId, projectId: c.projectId, recipientUserId: row.userId!, actorUserId: c.createdById,
              type: 'announcement.manual', title: row.title, body: row.body, entityType: 'announcement', entityId: c.id, destination: c.destination }, update: {} });
            await tx.notificationDelivery.update({ where: { id: row.id }, data: { status: 'sent', sentAt: new Date(), lockedAt: null, error: null } });
          });
          continue;
        }
        if (row.channel === 'push') {
          if (!user?.user.deviceId) throw new Error('No registered push device');
          const token = user.user.deviceId;
          const push = await transports.sendPush({ tokens: [token], title: row.title, body: row.body, data: { type: 'announcement.manual', tenant_id: c.tenantId, project_id: c.projectId, entity_type: 'announcement', entity_id: c.id, destination: c.destination } });
          if (push.invalid_tokens.length) await db.user.updateMany({ where: { id: row.userId!, tenantId: c.tenantId, deviceId: token }, data: { deviceId: null } });
          if (push.sent_count !== 1) throw new Error(push.reason ?? 'Push provider rejected the notification');
        } else {
          // Re-resolve current address; never send to an address removed after composition.
          const email = member?.email || user?.user.email;
          if (!email) throw new Error('No email address');
          const link = c.destination === 'none' ? '' : `\n\nOpen in FundLedger: fundledger://notification?project_id=${encodeURIComponent(c.projectId)}&tenant_id=${encodeURIComponent(c.tenantId)}&destination=${c.destination}`;
          const accepted = await transports.sendEmail({ to: email, fromName: `${project.name} via FundLedger`, subject: row.title.replace(/[\r\n]/g, ' '), text: row.body + link });
          if (!accepted) throw new Error('Email delivery is not configured');
        }
        await db.notificationDelivery.update({ where: { id: row.id }, data: { status: 'sent', sentAt: new Date(), lockedAt: null, error: null } });
      } catch (error) {
        console.error('[notification-campaign] delivery failed', row.id, row.channel);
        await db.notificationDelivery.update({ where: { id: row.id }, data: { status: 'failed', lockedAt: null, error: row.channel === 'email' ? 'Email was not accepted by the provider' : error instanceof Error ? error.message.slice(0, 200) : 'Delivery failed' } });
      }
    }
  } finally { running = false; }
}
let timer: ReturnType<typeof setInterval> | null = null;
function startCampaignWorker() {
  const run = () => void processCampaignQueue().catch(error => console.error('[notification-campaign] queue failed', error));
  if (!timer) { timer = setInterval(run, 5000); timer.unref(); run(); }
}
function stopCampaignWorker() { if (timer) clearInterval(timer); timer = null; }

return { loadPeople, previewCampaign, createCampaign, campaignSummary, retryCampaign, processCampaignQueue, startCampaignWorker, stopCampaignWorker };
}
export const { loadPeople, previewCampaign, createCampaign, campaignSummary, retryCampaign, processCampaignQueue, startCampaignWorker, stopCampaignWorker } = createCampaignService();
