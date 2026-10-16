import { customerDetails } from "../internal/customers.service.js";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma/client.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { storeObject, deleteObject } from "../../core/storage/object-storage.service.js";

export type SupportOwner = { tenantId: string; userId: string };
const attachmentSelect = { id: true, fileName: true, mimeType: true, size: true } as const;
const messageInclude = { attachments: { select: attachmentSelect } } as const;
export function screenshotType(buffer: Buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  throw badRequest("Screenshots must be JPG, PNG or WebP images");
}
export async function supportTicket(id: string, owner?: SupportOwner) {
  const ticket = await prisma.supportTicket.findFirst({ where: { id, ...(owner ? { tenantId: owner.tenantId, requesterId: owner.userId } : {}) } });
  if (!ticket) throw notFound("Support conversation not found");
  return ticket;
}
export async function listTickets(owner: SupportOwner | undefined, offset: number, status?: string, tenantId?: string) {
  const rows = await prisma.supportTicket.findMany({ where: { ...(owner ? { tenantId: owner.tenantId, requesterId: owner.userId } : tenantId ? { tenantId } : {}), ...(status ? { status } : {}) },
    include: owner ? undefined : { tenant: { select: { name: true } }, requester: { select: { id:true, name: true, email: true, mobile:true } } }, orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }], skip: offset, take: 31 });
  return { tickets: rows.slice(0, 30), next_offset: rows.length > 30 ? offset + 30 : null };
}
export async function ticketMessages(id: string, owner: SupportOwner | undefined, offset: number) {
  const ticket = await supportTicket(id, owner);
  const rows = await prisma.supportMessage.findMany({ where: { ticketId: id, tenantId: ticket.tenantId }, include: messageInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 31, skip: offset });
  return { ticket, ...(!owner?{customer:await customerDetails(ticket.tenantId,ticket.requesterId)}:{}), messages: rows.slice(0, 30).reverse(), next_offset: rows.length > 30 ? offset + 30 : null };
}
/** Storage writes are rolled back on failure/replay; conversation creation and messages are idempotent. */
export async function sendSupport(input: { owner?: SupportOwner; actor?: string; ticketId?: string; subject?: string; body: string; requestKey: string; files: Express.Multer.File[] }) {
  const existingTicket = input.ticketId ? await supportTicket(input.ticketId, input.owner) : null;
  if (!existingTicket && !input.owner) throw badRequest("Select a conversation");
  const tenantId = existingTicket?.tenantId ?? input.owner!.tenantId;
  const fileInfo = input.files.map(file => {
    if (file.size < 1 || file.size > 5_000_000) throw badRequest("Each screenshot must be 5 MB or smaller");
    return { file, mime: screenshotType(file.buffer), hash: createHash("sha256").update(file.buffer).digest("hex") };
  });
  const payloadHash = createHash("sha256").update(JSON.stringify([input.subject, input.body, input.owner ? "user" : "team", fileInfo.map(f => [f.file.originalname, f.hash])])).digest("hex");
  const keys: string[] = [];
  let keepFiles = false;
  try {
    for (const info of fileInfo) {
      const key = `${tenantId}/support/${randomUUID()}`;
      keys.push(key); await storeObject({ storageKey: key, buffer: info.file.buffer, contentType: info.mime });
    }
    const result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      if (tenant.deletionStartedAt) throw conflict("Organization cleanup has started");
      let ticket = existingTicket ? await tx.supportTicket.findUniqueOrThrow({ where: { id: existingTicket.id } }) : await tx.supportTicket.findUnique({ where: { tenantId_requesterId_requestKey: { tenantId, requesterId: input.owner!.userId, requestKey: input.requestKey } } });
      if (!ticket) ticket = await tx.supportTicket.create({ data: { tenantId, requesterId: input.owner!.userId, requestKey: input.requestKey, subject: input.subject! } });
      const old = await tx.supportMessage.findUnique({ where: { ticketId_requestKey: { ticketId: ticket.id, requestKey: input.requestKey } }, include: messageInclude });
      if (old) {
        if (old.payloadHash !== payloadHash) throw conflict("This message request was already used with different content");
        return { ticket, message: old, replayed: true };
      }
      const sender = input.owner ? "user" : "team";
      const author = input.owner ? (await tx.user.findUniqueOrThrow({ where: { id: input.owner.userId } })).name : "Fund Nesta team";
      const message = await tx.supportMessage.create({ data: { tenantId, ticketId: ticket.id, requestKey: input.requestKey, payloadHash, sender, author, body: input.body,
        attachments: { create: fileInfo.map((info, i) => ({ tenantId, fileName: info.file.originalname.slice(0, 180), mimeType: info.mime, size: info.file.size, storageKey: keys[i]! })) } }, include: messageInclude });
      const updated = await tx.supportTicket.update({ where: { id: ticket.id }, data: { status: "open", lastSender: sender, lastMessageAt: message.createdAt, ...(input.owner ? { userReadAt: message.createdAt } : {}) } });
      if (input.actor) await tx.internalAudit.create({ data: { tenantId, actor: input.actor, action: "support.replied", metadata: { ticket_id: ticket.id, message_id: message.id } } });
      return { ticket: updated, message, replayed: false };
    }, { timeout: 20000 });
    keepFiles = !result.replayed;
    return result;
  } finally { if (!keepFiles) await Promise.all(keys.map(key => deleteObject(key))); }
}
