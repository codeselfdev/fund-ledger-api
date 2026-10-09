import { Router } from "express";
import { z } from "zod";
import type { ProjectNotice } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { sendWhatsAppGroupMessage } from "../../core/whatsapp/whatsapp.service.js";
import { readObject, StorageObjectNotFoundError } from "../../core/storage/object-storage.service.js";
import { noticeCreateSchema, noticeUpdateSchema, assertFutureNoticeExpiry, noticeStatus } from "./notices.policy.js";

const router = Router();
const querySchema = z.object({ scope: z.enum(["active", "all"]).default("active") });
const admin = (roles: string[]) => roles.some(role => role === "owner" || role === "admin");
function payload(notice: ProjectNotice) {
  return { id: notice.id, title: notice.title, body: notice.body, expires_at: notice.expiresAt, image_file_id: notice.imageFileId,
    image_url: notice.imageFileId ? `/v1/notices/${notice.id}/image?v=${notice.imageFileId}` : null,
    status: noticeStatus(notice), deleted_at: notice.deletedAt, created_at: notice.createdAt, updated_at: notice.updatedAt };
}
async function checkImage(tenantId: string, projectId: string, id?: string | null) {
  if (!id) return;
  const image = await prisma.upload.findFirst({ where: { id, tenantId, projectId, purpose: "notice_image" } });
  if (!image || !image.mimeType.startsWith("image/") || image.size >= 2_000_000) throw badRequest("Choose an uploaded notice image smaller than 2 MB");
}
router.get("/", requireProject, requireRoles("any"), validateQuery(querySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { scope } = req.query as z.infer<typeof querySchema>;
  if (scope === "all" && !admin(auth.roles)) throw forbidden("Only admins can view notice history");
  const notices = await prisma.projectNotice.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId,
    ...(scope === "active" ? { deletedAt: null, expiresAt: { gt: new Date() } } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
  return ok(res, notices.map(payload));
}));
router.post("/", requireProject, requireRoles("owner", "admin"), validateBody(noticeCreateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof noticeCreateSchema>;
  assertFutureNoticeExpiry(body.expires_at);
  await checkImage(auth.tenantId, auth.projectId, body.image_file_id);
  const notice = await prisma.projectNotice.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, createdById: auth.userId,
    title: body.title, body: body.body, expiresAt: new Date(body.expires_at), imageFileId: body.image_file_id ?? null } });
  await notifyProjectMembers({ tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId,
    type: "notice.created", title: notice.title, body: notice.body, entityType: "notice", entityId: notice.id });
  const whatsapp = body.send_whatsapp ? await sendWhatsAppGroupMessage({ tenantId: auth.tenantId, projectId: auth.projectId, message: `*${notice.title}*\n${notice.body}` }) : { sent: false, skipped: "disabled" };
  await writeAudit({ tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "notice.created", entityType: "notice", entityId: notice.id, after: notice });
  return created(res, { ...payload(notice), whatsapp });
}));
router.patch("/:id", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), validateBody(noticeUpdateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof noticeUpdateSchema>;
  if (body.expires_at) assertFutureNoticeExpiry(body.expires_at);
  await checkImage(auth.tenantId, auth.projectId, body.image_file_id);
  const { before, notice } = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM project_notices WHERE id = ${id} AND tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} FOR UPDATE`;
    const before = await tx.projectNotice.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
    if (!before) throw notFound("Notice not found");
    if (before.deletedAt) throw badRequest("Deleted notices cannot be edited");
    const auditBefore = { ...before };
    const updated = await tx.projectNotice.update({ where: { id }, data: { title: body.title, body: body.body,
      expiresAt: body.expires_at ? new Date(body.expires_at) : undefined, imageFileId: body.image_file_id } });
    await tx.notification.updateMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId, entityType: "notice", entityId: id }, data: { title: updated.title, body: updated.body } });
    return { before: auditBefore, notice: updated };
  });
  await writeAudit({ tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "notice.updated", entityType: "notice", entityId: id, before, after: notice });
  return ok(res, payload(notice));
}));
router.delete("/:id", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const id = String(req.params.id);
  const { before, notice, changed } = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM project_notices WHERE id = ${id} AND tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} FOR UPDATE`;
    const before = await tx.projectNotice.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
    if (!before) throw notFound("Notice not found");
    if (before.deletedAt) return { before, notice: before, changed: false };

    // Keep the notice for admin history but remove it from dashboards and inboxes.
    const notice = await tx.projectNotice.update({ where: { id }, data: { deletedAt: new Date() } });
    await tx.notification.deleteMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId, entityType: "notice", entityId: id } });
    return { before, notice, changed: true };
  });
  if (changed) {
    await writeAudit({ tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "notice.deleted", entityType: "notice", entityId: id, before, after: notice });
  }
  return ok(res, payload(notice));
}));
router.get("/:id/image", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const notice = await prisma.projectNotice.findFirst({ where: { id: String(req.params.id), tenantId: auth.tenantId, projectId: auth.projectId } });
  if (!notice || (!admin(auth.roles) && noticeStatus(notice) !== "active") || !notice.imageFileId) throw notFound("Notice image not found");
  const image = await prisma.upload.findFirst({ where: { id: notice.imageFileId, tenantId: auth.tenantId, projectId: auth.projectId, purpose: "notice_image" } });
  if (!image) throw notFound("Notice image not found");
  try {
    const object = await readObject(image.storageKey);
    res.setHeader("Content-Type", image.mimeType); res.setHeader("Cache-Control", "private, no-store"); res.setHeader("X-Content-Type-Options", "nosniff"); res.send(object.buffer);
  } catch (error) { if (error instanceof StorageObjectNotFoundError) throw notFound("Notice image not found"); throw error; }
}));
export { router as noticesRouter };
