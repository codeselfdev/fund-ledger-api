import { Router } from "express";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { nanoid } from "nanoid";
import type { Prisma } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { env } from "../../config/env.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { z } from "zod";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});
const localUploadRoot = path.resolve(process.cwd(), env.uploadLocalDir);

const titleCreateSchema = z.object({
  title: z.string().min(2).max(120)
});

const titleUpdateSchema = z.object({
  title: z.string().min(2).max(120).optional(),
  is_active: z.boolean().optional()
}).refine((body) => body.title !== undefined || body.is_active !== undefined, {
  message: "At least one field is required"
});

const memberDocumentUploadSchema = z.object({
  title_id: z.string().min(1)
});

type MemberDocumentTitle = {
  id: string;
  title: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

function sanitizeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveLocalUploadPath(storageKey: string) {
  const absolutePath = path.resolve(localUploadRoot, storageKey);
  const rootPrefix = localUploadRoot.endsWith(path.sep) ? localUploadRoot : `${localUploadRoot}${path.sep}`;
  if (absolutePath !== localUploadRoot && !absolutePath.startsWith(rootPrefix)) {
    throw badRequest("Invalid upload path");
  }
  return absolutePath;
}

function hasMemberDocumentAccess(auth: { memberId: string | null; roles: string[] }, targetMemberId: string) {
  if (auth.memberId === targetMemberId) return true;
  return auth.roles.some((role) => ["owner", "admin", "accountant", "approver", "auditor", "cashier"].includes(role));
}

function readTitles(contact: unknown): MemberDocumentTitle[] {
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) return [];
  const record = contact as Record<string, unknown>;
  if (!Array.isArray(record.member_document_titles)) return [];
  return record.member_document_titles
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : nanoid(),
      title: typeof item.title === "string" ? item.title : "",
      is_active: item.is_active !== false,
      created_at: typeof item.created_at === "string" ? item.created_at : new Date().toISOString(),
      updated_at: typeof item.updated_at === "string" ? item.updated_at : new Date().toISOString()
    }))
    .filter((item) => item.title.length > 0);
}

function writeTitles(contact: unknown, titles: MemberDocumentTitle[]): Prisma.InputJsonValue {
  const base = contact && typeof contact === "object" && !Array.isArray(contact) ? { ...(contact as Record<string, unknown>) } : {};
  return JSON.parse(JSON.stringify({
    ...base,
    member_document_titles: titles
  })) as Prisma.InputJsonValue;
}

router.get("/member-document-titles", requireProject, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });
  const titles = readTitles(tenant.contact);
  return ok(res, {
    titles: titles.filter((title) => title.is_active)
  });
}));

router.post("/member-document-titles", requireProject, requireRoles("owner", "admin"), validateBody(titleCreateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof titleCreateSchema>;
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });

  const titles = readTitles(tenant.contact);
  if (titles.some((item) => item.title.toLowerCase() === body.title.trim().toLowerCase())) {
    throw badRequest("This title already exists");
  }

  const now = new Date().toISOString();
  const createdTitle: MemberDocumentTitle = {
    id: nanoid(),
    title: body.title.trim(),
    is_active: true,
    created_at: now,
    updated_at: now
  };
  const nextTitles = [...titles, createdTitle];

  await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: writeTitles(tenant.contact, nextTitles) }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member_document_title.created",
    entityType: "member_document_title",
    entityId: createdTitle.id,
    after: createdTitle
  });

  return created(res, createdTitle);
}));

router.patch("/member-document-titles/:id", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), validateBody(titleUpdateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof titleUpdateSchema>;
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });

  const titles = readTitles(tenant.contact);
  const current = titles.find((item) => item.id === id);
  if (!current) throw notFound("Document title not found");

  const nextTitle = body.title?.trim();
  if (nextTitle && titles.some((item) => item.id !== id && item.title.toLowerCase() === nextTitle.toLowerCase())) {
    throw badRequest("This title already exists");
  }

  const updated = {
    ...current,
    ...(nextTitle !== undefined ? { title: nextTitle } : {}),
    ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
    updated_at: new Date().toISOString()
  };
  const nextTitles = titles.map((item) => (item.id === id ? updated : item));

  await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: writeTitles(tenant.contact, nextTitles) }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member_document_title.updated",
    entityType: "member_document_title",
    entityId: id,
    before: current,
    after: updated
  });

  return ok(res, updated);
}));

router.post("/members/:id/documents", requireProject, requireRoles("any"), validateParams(idParamSchema), upload.single("file"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id: memberId } = req.params as z.infer<typeof idParamSchema>;
  const body = memberDocumentUploadSchema.parse(req.body);
  if (!hasMemberDocumentAccess(auth, memberId)) throw forbidden();
  if (!req.file) throw badRequest("file is required");
  if (env.uploadStorage !== "local") throw badRequest("Only local upload storage is currently supported");

  const [member, tenant] = await Promise.all([
    prisma.member.findFirst({
      where: { id: memberId, tenantId: auth.tenantId, projectId: auth.projectId },
      select: { id: true }
    }),
    prisma.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      select: { contact: true }
    })
  ]);
  if (!member) throw notFound("Member not found");

  const titles = readTitles(tenant.contact);
  const title = titles.find((item) => item.id === body.title_id && item.is_active);
  if (!title) throw badRequest("Invalid title_id");

  const storageKey = `${auth.tenantId}/${auth.projectId}/member/${memberId}/${nanoid()}-${sanitizeFilename(req.file.originalname)}`;
  const filePath = resolveLocalUploadPath(storageKey);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, req.file.buffer);

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
        purpose: `member_document:${memberId}:${title.id}`
      }
    });
  } catch (error) {
    await unlink(filePath).catch(() => undefined);
    throw error;
  }

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member_document.uploaded",
    entityType: "upload",
    entityId: record.id,
    after: { upload_id: record.id, member_id: memberId, title_id: title.id, title: title.title }
  });

  return created(res, {
    id: record.id,
    member_id: memberId,
    title_id: title.id,
    title: title.title,
    file_name: record.fileName,
    created_at: record.createdAt,
    view_url: `/v1/members/${memberId}/documents/${record.id}/view`
  });
}));

router.get("/members/:id/documents", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id: memberId } = req.params as z.infer<typeof idParamSchema>;
  if (!hasMemberDocumentAccess(auth, memberId)) throw forbidden();

  const [member, tenant] = await Promise.all([
    prisma.member.findFirst({
      where: { id: memberId, tenantId: auth.tenantId, projectId: auth.projectId },
      select: { id: true }
    }),
    prisma.tenant.findUniqueOrThrow({
      where: { id: auth.tenantId },
      select: { contact: true }
    })
  ]);
  if (!member) throw notFound("Member not found");

  const titleMap = new Map(readTitles(tenant.contact).map((item) => [item.id, item]));
  const uploads = await prisma.upload.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      purpose: { startsWith: `member_document:${memberId}:` }
    },
    orderBy: { createdAt: "desc" }
  });

  const documents = uploads.map((item) => {
    const parts = (item.purpose ?? "").split(":");
    const titleId = parts[2] ?? "";
    const title = titleMap.get(titleId);
    return {
      id: item.id,
      member_id: memberId,
      title_id: titleId,
      title: title?.title ?? "Unknown",
      file_name: item.fileName,
      mime_type: item.mimeType,
      size: item.size,
      created_at: item.createdAt,
      view_url: `/v1/members/${memberId}/documents/${item.id}/view`
    };
  });

  return ok(res, { documents });
}));

router.get("/members/:id/documents/:documentId/view", requireProject, requireRoles("any"), validateParams(z.object({ id: z.string().min(1), documentId: z.string().min(1) })), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id: memberId, documentId } = req.params as { id: string; documentId: string };
  if (!hasMemberDocumentAccess(auth, memberId)) throw forbidden();
  if (env.uploadStorage !== "local") throw badRequest("Only local upload storage is currently supported");

  const record = await prisma.upload.findFirst({
    where: {
      id: documentId,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      purpose: { startsWith: `member_document:${memberId}:` }
    }
  });
  if (!record) throw notFound("Member document not found");

  const filePath = resolveLocalUploadPath(record.storageKey);
  let fileBuffer: Buffer;
  try {
    fileBuffer = await readFile(filePath);
  } catch {
    throw notFound("Member document content not found on storage");
  }

  res.setHeader("Content-Type", record.mimeType || "application/octet-stream");
  res.setHeader("Content-Length", String(fileBuffer.length));
  res.setHeader("Content-Disposition", `inline; filename="${sanitizeFilename(record.fileName)}"`);
  return res.status(200).send(fileBuffer);
}));

export { router as memberDocumentsRouter };
