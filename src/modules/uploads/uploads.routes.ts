import { assertImageUploadSize } from "../../core/storage/upload-image-policy.js";
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ApiError, badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { created } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { deleteObject, getStorageMode, publicObjectUrl, readObject, StorageObjectNotFoundError, storeObject } from "../../core/storage/object-storage.service.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function sanitizeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function purposeFolder(value: string | undefined) {
  const folder = (value ?? "general")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return folder || "general";
}

router.post("/", requireProject, requireRoles("any"), upload.single("file"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  if (!req.file) throw badRequest("file is required");
  assertImageUploadSize(req.file);
  const purpose = typeof req.body.purpose === "string" ? req.body.purpose : undefined;

  if (purpose === "notice_image" && !auth.roles.some(role => role === "owner" || role === "admin")) throw forbidden("Only admins can upload notice images");
  if (purpose === "notice_image") {
    const jpeg = req.file.buffer[0] === 0xff && req.file.buffer[1] === 0xd8 && req.file.buffer[2] === 0xff;
    const png = req.file.buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (!jpeg && !png) throw badRequest("Notice image must be a JPG or PNG");
    req.file.mimetype = jpeg ? "image/jpeg" : "image/png";
    assertImageUploadSize(req.file);
  }

  if (purpose === "project_logo") {
    const canManageProject = auth.roles.includes("owner") || auth.roles.includes("admin");
    if (!canManageProject) throw forbidden("Only project admins can upload a project logo");
    if (!req.file.mimetype.startsWith("image/")) throw badRequest("Project logo must be an image");
  }

  const storageKey = `${auth.tenantId}/${auth.projectId}/${purposeFolder(purpose)}/${nanoid()}-${sanitizeFilename(req.file.originalname)}`;
  await storeObject({
    storageKey,
    buffer: req.file.buffer,
    contentType: req.file.mimetype
  }).catch((error) => {
    console.error("[uploads] storage write failed", { provider: getStorageMode(), storageKey, error });
    throw new ApiError(500, "STORAGE_WRITE_FAILED", "Failed to store attachment");
  });

  let record;
  try {
    record = await prisma.upload.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        userId: auth.userId,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        storageKey,
        purpose
      }
    });
  } catch (error) {
    await deleteObject(storageKey);
    throw error;
  }

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "upload.created",
    entityType: "upload",
    entityId: record.id,
    after: record
  });

  return created(res, {
    file_id: record.id,
    storage_key: record.storageKey,
    storage_provider: getStorageMode(),
    view_url: `/v1/uploads/${record.id}/view`,
    public_url: purpose === "project_logo" ? publicObjectUrl(record.storageKey) : null
  });
}));

router.get("/:id/view", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as { id: string };

  const record = await prisma.upload.findFirst({
    where: {
      id,
      tenantId: auth.tenantId,
      projectId: auth.projectId
    }
  });
  if (!record) throw notFound("Attachment not found");

  if (record.purpose === "notice_image" && !auth.roles.some(role => role === "owner" || role === "admin")) {
    const notice = await prisma.projectNotice.findFirst({ where: { tenantId: auth.tenantId, projectId: auth.projectId, imageFileId: record.id, deletedAt: null, expiresAt: { gt: new Date() } } });
    if (!notice) throw forbidden("Notice image is no longer available");
  }
  if (record.purpose?.startsWith("member_photo:") || record.purpose?.startsWith("member_document:")) {
    const memberId = record.purpose.split(":")[1];
    const staff = auth.roles.some(role => ["owner", "admin", "accountant", "approver", "auditor", "cashier"].includes(role));
    if (!staff && auth.memberId !== memberId) throw forbidden();
  }

  let fileBuffer: Buffer;
  let contentType: string | undefined;
  try {
    const object = await readObject(record.storageKey);
    fileBuffer = object.buffer;
    contentType = object.contentType;
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw notFound("Attachment content not found on storage");
    }
    throw new ApiError(500, "STORAGE_READ_FAILED", "Failed to read attachment");
  }

  res.setHeader("Content-Type", contentType || record.mimeType || "application/octet-stream");
  res.setHeader("Content-Length", String(fileBuffer.length));
  res.setHeader("Content-Disposition", `inline; filename="${sanitizeFilename(record.fileName)}"`);
  return res.status(200).send(fileBuffer);
}));

export { router as uploadsRouter };
