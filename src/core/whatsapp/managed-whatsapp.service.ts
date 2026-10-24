import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma/client.js';
import { ApiError, conflict, forbidden, serviceUnavailable } from '../http/api-error.js';
import { hasBusinessAssistant } from '../../modules/assistant/assistant.policy.js';
import { managedWhatsAppConfiguration as settings } from './whatsapp.configuration.js';
import { encryptWhatsAppCredential } from './whatsapp.service.js';
import { whatsappProviderFailure } from './whatsapp-provider-error.js';

export const createGroupSchema = z.object({ name: z.string().trim().min(2).max(128) }).strict();
type Scope = { tenantId: string; projectId: string; userId: string };
async function entitlement(scope: Pick<Scope, 'tenantId' | 'projectId'>) {
  const [tenant, project] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: scope.tenantId } }),
    prisma.project.findFirst({ where: { id: scope.projectId, tenantId: scope.tenantId, isActive: true } }),
  ]);
  if (!tenant || tenant.deletionStartedAt || !project) throw forbidden();
  return hasBusinessAssistant(tenant.contact);
}

export async function managedWhatsAppSetup(scope: Pick<Scope, 'tenantId' | 'projectId'>, readOnly = false) {
  const [entitled, initial] = await Promise.all([
    entitlement(scope), prisma.whatsAppConnection.findFirst({ where: { tenantId: scope.tenantId, projectId: scope.projectId } }),
  ]);
  let connection = initial;
  if (!readOnly && connection?.managedByFundNesta && connection.groupCreateRequestId && ['pending','unknown'].includes(connection.groupSetupStatus ?? '')) {
    await reconcileGroupCreation(connection.wabaId, connection.phoneNumberId, connection.groupCreateRequestId);
    connection = await prisma.whatsAppConnection.findFirst({ where: { tenantId: scope.tenantId, projectId: scope.projectId } });
  }
  let status = connection?.groupSetupStatus ?? null;
  if (status === 'creating' && Date.now() - connection!.updatedAt.getTime() > 30000) status = 'unknown';
  return {
    available: !!settings(), entitled, bot_name: 'Fund Nesta',
    bot_mention: process.env.WHATSAPP_BOT_ALIAS ?? '@fundnesta', max_participants: 8,
    legacy_connection: !!connection && !connection.managedByFundNesta,
    group: connection?.managedByFundNesta ? {
      name: connection.groupName, status,
      invite_link: status === 'ready' && entitled ? safeInviteLink(connection.groupInviteLink) : null,
      error: connection.groupSetupError,
    } : null,
  };
}

export function safeInviteLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chat.whatsapp.com' && !url.username && !url.password && !url.port && /^\/[A-Za-z0-9_-]+$/.test(url.pathname) && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export async function createManagedWhatsAppGroup(scope: Scope, name: string) {
  name = createGroupSchema.parse({ name }).name;
  if (!await entitlement(scope)) throw new ApiError(403, 'BUSINESS_REQUIRED', 'WhatsApp Bot requires an active Business package.');
  const config = settings();
  if (!config) throw serviceUnavailable('Fund Nesta is preparing WhatsApp group setup. Please try again later.');
  const where = { tenantId: scope.tenantId, projectId: scope.projectId };
  let row = await prisma.whatsAppConnection.findFirst({ where });
  if (row && !row.managedByFundNesta) throw conflict('Contact Fund Nesta support to move this project to the managed bot.');
  if (row && row.groupSetupStatus !== 'failed') return managedWhatsAppSetup(where);
  const data = {
    wabaId: config.waba, phoneNumberId: config.phone, graphApiVersion: config.version,
    encryptedAccessToken: encryptWhatsAppCredential(config.token), verifiedName: 'Fund Nesta',
    managedByFundNesta: true, isActive: false, groupName: name, groupId: null,
    groupSetupStatus: 'creating', groupSetupError: null, groupCreateRequestId: null, groupInviteLink: null,
  };
  if (row) {
    const claimed = await prisma.whatsAppConnection.updateMany({ where: { ...where, id: row.id, groupSetupStatus: 'failed', updatedAt: row.updatedAt }, data });
    if (!claimed.count) return managedWhatsAppSetup(where);
  } else {
    try { row = await prisma.whatsAppConnection.create({ data: { ...where, ...data, createdById: scope.userId } }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return managedWhatsAppSetup(where);
      throw error;
    }
  }
  // The durable claim precedes the remote request. A timeout is never retried automatically.
  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${config.version}/${encodeURIComponent(config.phone)}/groups`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', subject: name, join_approval_mode: 'auto_approve' }),
    });
  } catch {
    await prisma.whatsAppConnection.update({ where: { id: row.id }, data: { groupSetupStatus: 'unknown', groupSetupError: 'WhatsApp has not confirmed creation yet. Contact Fund Nesta support before trying again.' } });
    return managedWhatsAppSetup(where);
  }
  if (!response.ok) {
    const failure = whatsappProviderFailure(response.status, await response.json().catch(() => null));
    console.warn('[whatsapp] group_create_rejected', { http_status: failure.http_status, code: failure.code, subcode: failure.subcode, category: failure.category, reference: failure.reference });
    // Only a definite 4xx rejection permits a new creation attempt. 5xx delivery is uncertain.
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
    await prisma.whatsAppConnection.update({ where: { id: row.id }, data: {
      groupSetupStatus: rejected ? 'failed' : 'unknown',
      groupSetupError: rejected ? failure.customer_message : `Creation has not been confirmed. Contact Fund Nesta support before trying again. (${failure.reference})`,
    } });
    return managedWhatsAppSetup(where);
  }
  const payload = await response.json().catch(() => null) as { request_id?: unknown } | null;
  if (typeof payload?.request_id !== 'string' || !payload.request_id || payload.request_id.length > 300) {
    await prisma.whatsAppConnection.update({ where: { id: row.id }, data: { groupSetupStatus: 'unknown', groupSetupError: 'Creation has not been confirmed. Contact Fund Nesta support before trying again.' } });
    return managedWhatsAppSetup(where);
  }
  await prisma.whatsAppConnection.update({ where: { id: row.id }, data: { groupCreateRequestId: payload.request_id, groupSetupStatus: 'pending' } });
  // Handles a webhook which arrived before the POST response was saved.
  await reconcileGroupCreation(config.waba, config.phone, payload.request_id);
  return managedWhatsAppSetup(where);
}

const lifecycleSchema = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({
  id: z.string().min(1).max(100), changes: z.array(z.object({ field: z.string().optional(), value: z.object({
    metadata: z.object({ phone_number_id: z.string().min(1).max(100) }).optional(), groups: z.array(z.unknown()).max(100).optional(),
    group_id: z.string().optional(), messages: z.array(z.unknown()).max(100).optional(),
  }) })).max(100),
})).max(100) });
const createdSchema = z.object({ type: z.literal('group_create'), request_id: z.string().min(1).max(300), group_id: z.string().min(1).max(300).optional(), invite_link: z.string().max(2048).optional(), errors: z.array(z.unknown()).optional() });

/** Call only after verifying the signature over Meta's exact raw body. */
export async function receiveManagedGroupLifecycle(payload: unknown) {
  const parsed = lifecycleSchema.safeParse(payload);
  if (!parsed.success) return;
  for (const entry of parsed.data.entry) for (const change of entry.changes) {
    const phone = change.value.metadata?.phone_number_id;
    if (!phone || change.field !== 'group_lifecycle_update') continue;
    // Restrict the durable inbox to the platform account, including callbacks racing the POST.
    if (entry.id !== process.env.WHATSAPP_WABA_ID || phone !== process.env.WHATSAPP_PHONE_NUMBER_ID) continue;
    for (const raw of change.value.groups ?? []) {
      const parsedEvent = createdSchema.safeParse(raw); if (!parsedEvent.success) continue;
      const event = parsedEvent.data, failed = !!event.errors?.length;
      if (failed) {
        const failure = whatsappProviderFailure(400, { error: event.errors![0] });
        console.warn('[whatsapp] group_create_callback_failed', { code: failure.code, subcode: failure.subcode, category: failure.category, reference: failure.reference });
      }
      const invite = safeInviteLink(event.invite_link);
      if (!failed && (!event.group_id || (event.invite_link && !invite))) continue;
      await prisma.whatsAppGroupCreationEvent.upsert({
        where: { wabaId_phoneNumberId_requestId: { wabaId: entry.id, phoneNumberId: phone, requestId: event.request_id } },
        update: {}, create: { wabaId: entry.id, phoneNumberId: phone, requestId: event.request_id, groupId: event.group_id, inviteLink: invite, failed },
      });
      await reconcileGroupCreation(entry.id, phone, event.request_id);
    }
  }
}

async function reconcileGroupCreation(waba: string, phone: string, request: string) {
  const event = await prisma.whatsAppGroupCreationEvent.findUnique({ where: { wabaId_phoneNumberId_requestId: { wabaId: waba, phoneNumberId: phone, requestId: request } } });
  if (!event) return;
  let invite = safeInviteLink(event.inviteLink);
  if (!event.failed && !invite) {
    const connection = await prisma.whatsAppConnection.findFirst({ where: { wabaId: waba, phoneNumberId: phone, groupCreateRequestId: request, managedByFundNesta: true, groupSetupStatus: { in: ['pending','unknown'] } } });
    if (!connection || !event.groupId) return;
    // Some lifecycle payloads contain only the authoritative group ID. Reading the invitation is safe to retry.
    try {
      const response = await fetch(`https://graph.facebook.com/${connection.graphApiVersion}/${encodeURIComponent(event.groupId)}/invite_link`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } });
      const payload = await response.json() as { invite_link?: unknown };
      invite = response.ok ? safeInviteLink(payload.invite_link) : null;
      if (!invite) throw Error('Invitation unavailable');
      await prisma.whatsAppGroupCreationEvent.update({ where: { id: event.id }, data: { inviteLink: invite } });
    } catch { throw serviceUnavailable('WhatsApp is still preparing the invitation. Please refresh the group status.'); }
  }
  await prisma.whatsAppConnection.updateMany({
    where: { wabaId: waba, phoneNumberId: phone, groupCreateRequestId: request, managedByFundNesta: true, groupSetupStatus: { in: ['pending', 'unknown'] } },
    data: event.failed ? { groupSetupStatus: 'failed', isActive: false, groupSetupError: 'WhatsApp could not create this group. Please try again or contact Fund Nesta support.' } : {
      groupId: event.groupId, groupInviteLink: invite, groupSetupStatus: 'ready', groupSetupError: null, isActive: true, lastVerifiedAt: new Date(),
    },
  });
}

/** Preserve the signed body when passing group messages to the existing durable AI inbox. */
export async function forwardWhatsAppGroupMessages(raw: Buffer, signature: string, payload: unknown) {
  const parsed = lifecycleSchema.safeParse(payload);
  if (!parsed.success || process.env.WHATSAPP_ENABLED !== 'true' || !process.env.AI_SERVICE_URL) return;
  const hasGroups = parsed.data.entry.some(entry => entry.changes.some(change => {
    return change.value.messages?.some(message => {
      const parsedMessage = z.object({ group_id: z.string().optional(), context: z.object({ group_id: z.string().optional() }).optional() }).safeParse(message);
      return parsedMessage.success && !!(parsedMessage.data.group_id || parsedMessage.data.context?.group_id || change.value.group_id);
    });
  }));
  if (!hasGroups) return;
  const url = new URL('/webhooks/whatsapp', process.env.AI_SERVICE_URL);
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature }, body: new Uint8Array(raw).buffer });
    if (!response.ok) throw Error('AI inbox rejected delivery');
  } catch { throw serviceUnavailable('WhatsApp group messages could not be queued.'); }
}
