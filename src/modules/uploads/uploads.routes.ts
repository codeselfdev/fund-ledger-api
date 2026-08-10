import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ApiError, badRequest, notFound } from "../../core/http/api-error.js";
import { created } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { deleteObject, readObject, StorageObjectNotFoundError, storeObject } from "../../core/storage/object-storage.service.js";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function sanitizeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

router.post("/", requireProject, requireRoles("any"), upload.single("file"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  if (!req.file) throw badRequest("file is required");

  const storageKey = `${auth.tenantId}/${auth.projectId}/${nanoid()}-${sanitizeFilename(req.file.originalname)}`;
  await storeObject({
    storageKey,
    buffer: req.file.buffer,
    contentType: req.file.mimetype
  }).catch(() => {
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
        purpose: typeof req.body.purpose === "string" ? req.body.purpose : undefined
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
    view_url: `/v1/uploads/${record.id}/view`
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
