import { createHmac } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { ApiError, badRequest, conflict, serviceUnavailable } from '../../core/http/api-error.js';
import type { Scope } from '../reports/report.policy.js';
import { writeAudit } from '../../core/audit/audit.service.js';
import { startTelegramLink, telegramApi } from './telegram.service.js';

/** Outgoing posts can work even when Telegram never delivers mentions to the bot. */
export async function assertTelegramReplyDelivery(scope: Scope) {
  const group = await prisma.telegramConnection.findFirst({ where: { tenantId: scope.tenantId, projectId: scope.projectId } });
  if (!group) throw badRequest('Connect your project Telegram group from Integrations first.');
  const [bot, webhook] = await Promise.all([
    telegramApi<{ id: number; username?: string; can_read_all_group_messages?: boolean }>('getMe', {}),
    telegramApi<{ url?: string; allowed_updates?: string[] }>('getWebhookInfo', {}),
  ]);
  const configured = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '');
  if (!Number.isSafeInteger(bot.id) || !configured || bot.username?.toLowerCase() !== configured.toLowerCase()) {
    throw new ApiError(503, 'TELEGRAM_BOT_CONFIGURATION_REQUIRED', 'The configured Telegram username does not match the bot. Ask your platform administrator to check Telegram setup.');
  }
  if (!webhook.url || webhook.allowed_updates?.length && !webhook.allowed_updates.includes('message')) {
    throw new ApiError(503, 'TELEGRAM_WEBHOOK_REQUIRED', 'Incoming Telegram messages are not enabled on the server. Ask your platform administrator to check the Telegram webhook. Sending a test message checks outgoing delivery only.');
  }
  const membership = await telegramApi<{ status: string }>('getChatMember', { chat_id: group.chatId, user_id: bot.id });
  const readsMentions = ['administrator', 'creator'].includes(membership.status)
    || membership.status === 'member' && bot.can_read_all_group_messages === true;
  if (!readsMentions) throw new ApiError(409, 'TELEGRAM_BOT_PERMISSIONS_REQUIRED', 'The bot can send posts but cannot receive ordinary mentions or photo captions in this group. Make the bot a Telegram group administrator, then retry Link my Telegram account.');
}

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
  const username = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '');
  if (!username || !/^\w+$/.test(username)) return;
  if (!isTelegramAssistantUpdate(update, username)) return;
  const body = JSON.stringify(update), signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  try {
    const response = await fetch(new URL('/webhooks/telegram', base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/json', 'x-fundnesta-signature': signature }, body });
    if (!response.ok) throw Error('AI inbox rejected update');
  } catch { throw serviceUnavailable('Telegram bot request could not be queued.'); }
}

/** Public webhook authentication is performed by the route before this predicate. */
export function isTelegramAssistantUpdate(update: unknown, username: string): boolean {
  if (!update || typeof update !== 'object' || !/^[a-zA-Z0-9_]{1,64}$/.test(username)) return false;
  type Sender = { id: number; is_bot?: boolean; username?: string };
  type Message = { message_id: number; text?: string; caption?: string; chat?: { id: number; type: string }; from?: Sender; sender_chat?: unknown };
  const value = update as { update_id?: number; message?: Message; callback_query?: { id?: string; data?: string; from?: Sender; message?: Message; inline_message_id?: string } };
  if (!Number.isSafeInteger(value.update_id)) return false;
  const callback = value.callback_query;
  const message = callback?.message ?? value.message;
  const sender = callback?.from ?? message?.from;
  if (!message || !['group', 'supergroup'].includes(message.chat?.type ?? '') || !Number.isSafeInteger(message.chat?.id) || Number(message.chat?.id) >= 0 || !Number.isSafeInteger(message.message_id) || message.message_id <= 0 || !sender || !Number.isSafeInteger(sender.id) || sender.id <= 0 || sender.is_bot || message.sender_chat) return false;
  if (callback) {
    if (typeof callback.id !== 'string' || !callback.id || callback.id.length > 200 || callback.inline_message_id || typeof callback.data !== 'string' || !/^fn:[A-Za-z0-9_-]{43}$/.test(callback.data)) return false;
    // The message was sent by our bot; the clicker is callback.from.
    return !message.from || (message.from.is_bot === true && message.from.username?.toLowerCase() === username.toLowerCase());
  }
  const text = message.text ?? message.caption ?? '';
  return typeof text === 'string' && new RegExp(`(?:^|\\s)@${username}(?=$|[^a-zA-Z0-9_])|^/ask@${username}(?:\\s|$)`, 'i').test(text);
}
