import { assertImageUploadSize } from "../../core/storage/upload-image-policy.js";
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext, isSelfOrRole } from "../../core/security/auth.context.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { storeObject, deleteObject, readObject, StorageObjectNotFoundError } from "../../core/storage/object-storage.service.js";
import { profilePatchSchema, assertProfileEditAllowed } from "./member-profile.policy.js";

import { calculateDueBalance } from "./member-settlement.service.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const readers = ["owner", "admin", "accountant", "approver", "auditor", "cashier"] as const;
async function memberFor(req: Parameters<typeof requireProjectContext>[0], edit = false, directoryPhoto = false) {
  const auth = requireProjectContext(req);
  const id = String(req.params.id);
  if (edit) assertProfileEditAllowed(auth, id);
  else if (!isSelfOrRole(auth, id, [...readers]) && !(directoryPhoto && auth.roles.includes("member"))) throw forbidden();
  const member = await prisma.member.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId, ...(directoryPhoto && !isSelfOrRole(auth, id, [...readers]) ? { status: "active" } : {}) } });
  if (!member) throw notFound("Member not found");
  return { auth, member };
}

router.get("/:id/dues", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const { auth, member } = await memberFor(req);
  const dues = await prisma.due.findMany({ where: { memberId: member.id, tenantId: auth.tenantId, projectId: auth.projectId }, include: { schedule: true }, orderBy: { dueDate: "asc" } });
  return ok(res, dues.map(due => ({ ...due, outstanding: calculateDueBalance(due).total })));
}));

router.get("/:id/payments", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const { auth, member } = await memberFor(req);
  const payments = await prisma.deposit.findMany({ where: { memberId: member.id, tenantId: auth.tenantId, projectId: auth.projectId }, include: { schedule: true, allocations: { include: { schedule: true } } }, orderBy: { createdAt: "desc" } });
  return ok(res, payments);
}));

router.patch("/:id/profile", requireProject, requireRoles("any"), validateParams(idParamSchema), validateBody(profilePatchSchema), asyncHandler(async (req, res) => {
  const { auth, member } = await memberFor(req, true);
  const body = req.body as z.infer<typeof profilePatchSchema>;
  assertProfileEditAllowed(auth, member.id, body);
  const { name, mobile, email, address, ...fields } = body;
  const updated = await prisma.$transaction(async (tx) => {
    // Serialize profile/photo updates so concurrent edits preserve unrelated fields.
    await tx.$queryRaw`SELECT id FROM members WHERE id = ${member.id} FOR UPDATE`;
    const current = await tx.member.findUniqueOrThrow({ where: { id: member.id } });
    const profile = current.profile && typeof current.profile === "object" && !Array.isArray(current.profile) ? current.profile : {};
    const updated = await tx.member.update({ where: { id: member.id }, data: {
      name, mobile, email, address,
      profile: { ...profile, ...fields } as Prisma.InputJsonValue
    } });
    if (current.userId && (name !== undefined || mobile !== undefined || email !== undefined)) {
      await tx.user.update({ where: { id: current.userId, tenantId: auth.tenantId }, data: { name, mobile, email } });
    }
    return updated;
  });
  await writeAudit({ tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "member.profile_updated", entityType: "member", entityId: member.id,
    after: { changed_fields: Object.keys(body) } });
  return ok(res, updated);
}));

router.post("/:id/photo", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, _res, next) => {
  await memberFor(req, true); next();
}), upload.single("file"), asyncHandler(async (req, res) => {
  const { auth, member } = await memberFor(req, true);
  const file = req.file;
  if (!file) throw badRequest("Choose a photo");
  assertImageUploadSize({ ...file, mimetype: "image/jpeg" });
  const jpeg = file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
  const png = file.buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (!jpeg && !png) throw badRequest("Photo must be a JPG or PNG image");
  const mimeType = jpeg ? "image/jpeg" : "image/png";
  const storageKey = `${auth.tenantId}/${auth.projectId}/member_photo/${member.id}-${nanoid()}`;
  await storeObject({ storageKey, buffer: file.buffer, contentType: mimeType });
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM members WHERE id = ${member.id} FOR UPDATE`;
      const current = await tx.member.findUniqueOrThrow({ where: { id: member.id } });
      const profile = current.profile && typeof current.profile === "object" && !Array.isArray(current.profile) ? current.profile : {};
      const record = await tx.upload.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, userId: auth.userId,
        fileName: file.originalname, mimeType, size: file.size, storageKey, purpose: `member_photo:${member.id}` } });
      return tx.member.update({ where: { id: member.id }, data: { profile: { ...profile, photo_file_id: record.id } } });
    });
  } catch (error) { await deleteObject(storageKey).catch(() => {}); throw error; }
  await writeAudit({ tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "member.photo_updated", entityType: "member", entityId: member.id, after: { photo_file_id: (updated.profile as Record<string, unknown>).photo_file_id } });
  return ok(res, updated);
}));

router.get("/:id/photo", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const { auth, member } = await memberFor(req, false, true);
  const photoId = (member.profile as Record<string, unknown> | null)?.photo_file_id;
  if (typeof photoId !== "string") throw notFound("Member photo not found");
  const record = await prisma.upload.findFirst({ where: { id: photoId, tenantId: auth.tenantId, projectId: auth.projectId, purpose: `member_photo:${member.id}` } });
  if (!record) throw notFound("Member photo not found");
  try {
    const object = await readObject(record.storageKey);
    res.setHeader("Content-Type", record.mimeType);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(object.buffer);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) throw notFound("Member photo not found");
    throw error;
  }
}));
export { router as memberProfileRouter };
