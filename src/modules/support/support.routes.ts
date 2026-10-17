import { Router, type Request, type ErrorRequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../../core/prisma/client.js";
import { authenticateAccount } from "../../core/security/auth.middleware.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { readObject, StorageObjectNotFoundError } from "../../core/storage/object-storage.service.js";
import { internalActor } from "../../core/security/internal-api-key.middleware.js";
import { listTickets, sendSupport, supportTicket, ticketMessages, type SupportOwner } from "./support.service.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5_000_001, files: 3, fields: 4, fieldSize: 40000 } }).array("files", 3);
const listSchema = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), status: z.enum(["open", "resolved"]).optional(), tenant_id: z.string().max(100).optional() });
const messageSchema = z.object({ request_key: z.string().uuid(), body: z.string().trim().max(10000).default(""), subject: z.string().trim().min(3).max(160).optional() }).strict();
const ownerOf = (req: Request): SupportOwner => ({ tenantId: req.auth!.tenantId, userId: req.auth!.userId });

export function buildSupportRouter(internal = false) {
  const router = Router();
  if (!internal) router.use(authenticateAccount);
  const owner = (req: Request) => internal ? undefined : ownerOf(req);
  router.get("/tickets", asyncHandler(async (req, res) => { const q = listSchema.parse(req.query); return ok(res, await listTickets(owner(req), q.offset, q.status, q.tenant_id)); }));
  router.get("/tickets/:id", asyncHandler(async (req, res) => { const q = listSchema.parse(req.query); return ok(res, await ticketMessages(String(req.params.id), owner(req), q.offset)); }));
  router.post("/tickets/:id/read", asyncHandler(async (req, res) => {
    const ticket = await supportTicket(String(req.params.id), owner(req));
    if (!internal) await prisma.$transaction([
      prisma.supportTicket.update({ where: { id: ticket.id }, data: { userReadAt: new Date() } }),
      prisma.notification.updateMany({ where: { tenantId: ticket.tenantId, recipientUserId: ticket.requesterId, type: "support.replied", entityType: "support_ticket", entityId: ticket.id, readAt: null }, data: { readAt: new Date() } })
    ]);
    else { internalActor(req); await prisma.platformAlert.updateMany({where:{ticketId:ticket.id,tenantId:ticket.tenantId,readAt:null},data:{readAt:new Date()}}); }
    return ok(res, { read: true });
  }));
  router.patch("/tickets/:id/status", asyncHandler(async (req, res) => {
    const b = z.object({ status: z.enum(["open", "resolved"]) }).strict().parse(req.body);
    const ticket = await supportTicket(String(req.params.id), owner(req));
    const actor = internal ? internalActor(req) : null;
    const updated = await prisma.$transaction(async tx => {
      const result = await tx.supportTicket.update({ where: { id: ticket.id }, data: b });
      if (actor) await tx.internalAudit.create({ data: { tenantId: ticket.tenantId, actor, action: "support.status_changed", metadata: { ticket_id: ticket.id, status: b.status } } });
      return result;
    });
    return ok(res, updated);
  }));
  const send = (creating: boolean) => asyncHandler(async (req, res) => {
    const body = messageSchema.parse(req.body), files = (req.files ?? []) as Express.Multer.File[];
    if (creating && !body.subject) throw badRequest("Enter a support subject");
    if (!body.body && !files.length) throw badRequest("Write a message or attach a screenshot");
    return created(res, await sendSupport({ owner: owner(req), actor: internal ? internalActor(req) : undefined, ticketId: creating ? undefined : String(req.params.id), subject: body.subject, body: body.body, requestKey: body.request_key, files }));
  });
  if (!internal) router.post("/tickets", rateLimit({ windowMs: 60000, limit: 10 }), upload, send(true));
  router.post("/tickets/:id/messages", rateLimit({ windowMs: 60000, limit: 30 }), asyncHandler(async (req, _res, next) => { await supportTicket(String(req.params.id), owner(req)); next(); }), upload, send(false));
  router.get("/attachments/:id", asyncHandler(async (req, res) => {
    const own = owner(req);
    const row = await prisma.supportAttachment.findFirst({ where: { id: String(req.params.id), ...(own ? { tenantId: own.tenantId, message: { ticket: { requesterId: own.userId } } } : {}) } });
    if (!row) throw notFound("Screenshot not found");
    try {
      const object = await readObject(row.storageKey);
      res.setHeader("Content-Type", row.mimeType); res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(object.buffer);
    } catch (error) { if (error instanceof StorageObjectNotFoundError) throw notFound("Screenshot not found"); throw error; }
  }));
  if (!internal) router.post("/installations", asyncHandler(async (req, res) => {
    const b = z.object({ installation_id: z.string().uuid(), platform: z.enum(["android", "ios", "web"]), app_version: z.string().max(60).optional() }).strict().parse(req.body), a = ownerOf(req);
    const data = await prisma.appInstallation.upsert({ where: { tenantId_userId_installationId: { tenantId: a.tenantId, userId: a.userId, installationId: b.installation_id } },
      create: { tenantId: a.tenantId, userId: a.userId, installationId: b.installation_id, platform: b.platform, appVersion: b.app_version }, update: { lastSeenAt: new Date(), appVersion: b.app_version } });
    return ok(res, { first_app_seen_at: data.firstSeenAt });
  }));
  const uploadError: ErrorRequestHandler = (error,_req,_res,next) => {
    if (error instanceof multer.MulterError && error.code !== "LIMIT_FILE_SIZE") return next(badRequest("Attach up to 3 screenshots with a message of at most 10,000 characters"));
    next(error);
  };
  router.use(uploadError);
  return router;
}
export const supportRouter = buildSupportRouter();
