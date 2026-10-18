import { createHmac } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, serviceUnavailable } from '../../core/http/api-error.js';
import type { Scope } from '../reports/report.policy.js';
import { writeAudit } from '../../core/audit/audit.service.js';
import { startTelegramLink } from './telegram.service.js';

export async function startTelegramIdentityLink(scope: Scope) {
  const group = await prisma.telegramConnection.findFirst({ where: { tenantId: scope.tenantId, projectId: scope.projectId } });
  if (!group) throw badRequest('Connect your project Telegram group from Integrations first.');
  return startTelegramLink(scope, group.chatId);
}
export async function confirmTelegramIdentityLink(scope: Scope, id: string) {
  const where = { tenantId: scope.tenantId, projectId: scope.projectId };
  const [group, link] = await Promise.all([
    prisma.telegramConnection.findFirst({ where }),
    prisma.telegramLink.findFirst({ where: { ...where, id, userId: scope.userId } }),
  ]);
  if (group && link?.consumedAt && link.chatId === group.chatId && link.senderId) {
    const identity = await prisma.telegramBotIdentity.findUnique({ where: { projectId_userId: { projectId: scope.projectId, userId: scope.userId } } });
    if (identity?.tenantId === scope.tenantId && identity.telegramUserId === link.senderId) return;
  }
  if (!group || !link || link.targetChatId !== group.chatId || link.chatId !== group.chatId || !link.senderId || link.expiresAt <= new Date() || link.consumedAt) throw badRequest('Send your connection command in this project’s group before confirming.');
  try {
    await prisma.$transaction(async tx => {
      const claim = await tx.telegramLink.updateMany({ where: { id: link.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
      if (!claim.count) throw conflict('This connection code has expired or was already used.');
      await tx.telegramBotIdentity.upsert({
        where: { projectId_userId: { projectId: scope.projectId, userId: scope.userId } },
        create: { ...where, userId: scope.userId, telegramUserId: link.senderId!, displayName: link.senderName },
        update: { telegramUserId: link.senderId!, displayName: link.senderName },
      });
    });
  } catch (error) { if ((error as { code?: string }).code === 'P2002') throw conflict('This Telegram account is already connected to another member.'); throw error; }
  await writeAudit({ ...scope, actorUserId: scope.userId, action: 'telegram.identity_linked', entityType: 'telegram_bot_identity', entityId: scope.userId });
}

/** Telegram's webhook secret is checked by the caller. The AI inbox verifies this body HMAC. */
export async function forwardTelegramAssistantUpdate(update: unknown) {
  const base = process.env.AI_SERVICE_URL, secret = process.env.AI_SERVICE_SHARED_SECRET;
  if (!base || !secret || secret.length < 32) return;
  const message = (update as { message?: { text?: string; caption?: string; chat?: { type?: string }; from?: { is_bot?: boolean }; sender_chat?: unknown } })?.message;
  if (!message || !['group', 'supergroup'].includes(message.chat?.type ?? '') || message.from?.is_bot || message.sender_chat) return;
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '');
  if (!username || !/^\w+$/.test(username)) return;
  const text = message.text ?? message.caption ?? '';
  if (!new RegExp(`(?:^|\\s)@${username}(?=$|[^a-zA-Z0-9_])|^/ask@${username}(?:\\s|$)`, 'i').test(text)) return;
  const body = JSON.stringify(update), signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  try {
    const response = await fetch(new URL('/webhooks/telegram', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', 'x-fundnesta-signature': signature }, body });
    if (!response.ok) throw Error('AI inbox rejected update');
  } catch { throw serviceUnavailable('Telegram bot request could not be queued.'); }
}
