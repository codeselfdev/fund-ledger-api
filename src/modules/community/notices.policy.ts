import { z } from "zod";
import { badRequest } from "../../core/http/api-error.js";

export const noticeCreateSchema = z.object({
  title: z.string().trim().min(2).max(120),
  body: z.string().trim().min(2).max(2000),
  expires_at: z.string().datetime({ offset: true }),
  image_file_id: z.string().min(1).nullable().optional(),
  send_whatsapp: z.boolean().default(false),
}).strict();
export const noticeUpdateSchema = noticeCreateSchema.omit({ send_whatsapp: true }).partial().refine(body => Object.keys(body).length > 0, "Provide at least one notice field");
export function assertFutureNoticeExpiry(value: string, now = Date.now()) {
  if (new Date(value).getTime() <= now + 60_000) throw badRequest("Notice expiry must be at least one minute in the future");
}
export function noticeStatus(notice: { deletedAt: Date | null; expiresAt: Date }, now = Date.now()) {
  return notice.deletedAt ? "deleted" : notice.expiresAt.getTime() <= now ? "expired" : "active";
}
