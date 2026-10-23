import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { notFound } from '../../core/http/api-error.js';
const querySchema = z.object({ page: z.literal('true').optional(), before: z.string().min(1).max(200).optional() });
/** Stable keyset pagination. Cursor lookup uses the same authorization scope as the page. */
export async function assistantHistoryQuery(db: Pick<PrismaClient, 'assistantReply'>, scope: Prisma.AssistantReplyWhereInput, raw: unknown) {
  const query = querySchema.parse(raw), paged = query.page === 'true';
  let where = scope;
  if (query.before) {
    const cursor = await db.assistantReply.findFirst({ where: { AND: [scope, { id: query.before }] }, select: { id: true, createdAt: true } });
    if (!cursor) throw notFound('Chat history cursor is unavailable. Reload history.');
    where = { AND: [scope, { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] };
  }
  return { where, orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }], take: paged ? 31 : 30, paged };
}
export function assistantHistoryWindow<T extends { id: string }>(rows: T[], paged: boolean) {
  const included = rows.slice(0, 30), next_cursor = paged && rows.length > 30 ? included.at(-1)!.id : null;
  return { rows: included.reverse(), next_cursor };
}
