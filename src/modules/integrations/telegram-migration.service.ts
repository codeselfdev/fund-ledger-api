import { prisma } from '../../core/prisma/client.js';
import { conflict } from '../../core/http/api-error.js';

const basic = (id: unknown): id is number => Number.isSafeInteger(id) && Number(id) < 0 && Number(id) > -1000000000000;
const supergroup = (id: unknown): id is number => Number.isSafeInteger(id) && Number(id) < -1000000000000;
/** Call only after verifying Telegram's webhook secret. Names and user text are never migration evidence. */
export function telegramGroupMigration(update: unknown) {
  const m = (update as { message?: { chat?: { id?: number; type?: string }; migrate_to_chat_id?: number; migrate_from_chat_id?: number; forward_origin?: unknown } })?.message;
  if (!m || m.forward_origin || (m.migrate_to_chat_id !== undefined && m.migrate_from_chat_id !== undefined)) return null;
  if (m.chat?.type === 'group' && basic(m.chat.id) && supergroup(m.migrate_to_chat_id)) return { from: String(m.chat.id), to: String(m.migrate_to_chat_id) };
  if (m.chat?.type === 'supergroup' && supergroup(m.chat.id) && basic(m.migrate_from_chat_id)) return { from: String(m.migrate_from_chat_id), to: String(m.chat.id) };
  return null;
}
export async function migrateTelegramGroup(from: string, to: string) {
  if (!basic(Number(from)) || !supergroup(Number(to))) return null;
  try {
    return await prisma.$transaction(async tx => {
      const old = await tx.telegramConnection.findUnique({ where: { chatId: from } });
      const destination = await tx.telegramConnection.findUnique({ where: { chatId: to } });
      if (old && destination && old.id !== destination.id) throw conflict('The migrated Telegram group is already connected to another project.');
      if (old) {
        const changed = await tx.telegramConnection.updateMany({ where: { id: old.id, tenantId: old.tenantId, projectId: old.projectId, chatId: from }, data: { chatId: to } });
        if (!changed.count) return null;
      }
      // Pending pairing commands also survive an upgrade between sending and confirming.
      await tx.telegramLink.updateMany({ where: { chatId: from, consumedAt: null, expiresAt: { gt: new Date() } }, data: { chatId: to } });
      await tx.telegramLink.updateMany({ where: { targetChatId: from, consumedAt: null, expiresAt: { gt: new Date() } }, data: { targetChatId: to } });
      return old ? { ...old, chatId: to } : destination;
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') throw conflict('The migrated Telegram group is already connected to another project.');
    throw error;
  }
}
/** Recover a missed service update only when Telegram independently proves the old-to-new ID. */
export async function resolveTelegramConnection(chatId: string, sender: string, canonicalChat: (old: string) => Promise<string | null>) {
  const existing = await prisma.telegramConnection.findUnique({ where: { chatId } });
  if (existing || !supergroup(Number(chatId))) return existing;
  const identities = await prisma.telegramBotIdentity.findMany({ where: { telegramUserId: sender }, select: { tenantId: true, projectId: true }, take: 20 });
  if (!identities.length) return null;
  const candidates = (await prisma.telegramConnection.findMany({ where: { OR: identities.map(i => ({ tenantId: i.tenantId, projectId: i.projectId })) }, take: 4 })).filter(c => basic(Number(c.chatId)));
  if (candidates.length > 3) return null;
  const proven = (await Promise.all(candidates.map(async c => {
    try { return await canonicalChat(c.chatId) === chatId ? c : null; } catch { return null; }
  }))).filter(c => c !== null);
  if (proven.length !== 1) return null;
  return migrateTelegramGroup(proven[0]!.chatId, chatId);
}
