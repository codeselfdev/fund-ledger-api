import multer from "multer";
import { createHash, randomUUID } from "node:crypto";
import { screenshotType } from "../support/support.service.js";
import { storeObject, deleteObject, readObject, StorageObjectNotFoundError } from "../../core/storage/object-storage.service.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { Router, type ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ApiError, forbidden } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";
import { aiConfigured, chatSchema } from "./assistant.policy.js";
import { assistantStatus, publicReply, reserveReply, processReply } from "./assistant.service.js";
import { assistantContext } from "./assistant.context.js";
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 3, fileSize: 5000001, fields: 2, fieldSize: 10000 } }).array("files", 3);
const present = async (row: Parameters<typeof publicReply>[0]) => ({ ...publicReply(row), attachments: await prisma.assistantAttachment.findMany({ where: { replyId: row.id }, select: { id: true, fileName: true, mimeType: true, size: true } }) });
router.use(requireProject, requireRoles("owner", "admin", "accountant"));
router.get("/status", asyncHandler(async (req, res) => ok(res, await assistantStatus(requireProjectContext(req).tenantId))));
router.get("/messages", asyncHandler(async (req, res) => {
    const a = requireProjectContext(req);
    const context = await assistantContext(a.tenantId, a.projectId, a.userId);
    const rows = await prisma.assistantReply.findMany({ where: { tenantId: a.tenantId, projectId: a.projectId, userId: a.userId, channel: "ai_chat", OR: [{ authorizationHash: context.authorization_hash }, { status: { in: ["queued", "processing"] } }] }, orderBy: { createdAt: "desc" }, take: 30 });
    return ok(res, await Promise.all(rows.reverse().map(present)));
}));
router.post("/messages", rateLimit({ windowMs: 60000, limit: 12, standardHeaders: true, legacyHeaders: false }), upload, validateBody(chatSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = chatSchema.parse(req.body);
    if (!aiConfigured())
        throw new ApiError(503, "AI_NOT_CONFIGURED", "AI Chat needs server setup. Contact your administrator.");
    const context = await assistantContext(a.tenantId, a.projectId, a.userId);
    const files = (req.files ?? []) as Express.Multer.File[];
    const attachments = files.map(file => { if (file.size < 1 || file.size > 5000000)
        throw badRequest("Each image must be 5 MB or smaller"); return { fileName: file.originalname.slice(0, 180), mimeType: screenshotType(file.buffer), size: file.size, contentHash: createHash("sha256").update(file.buffer).digest("hex"), storageKey: `${a.tenantId}/assistant/${randomUUID()}` }; });
    let retained = false;
    try {
        for (let i = 0; i < attachments.length; i++)
            await storeObject({ storageKey: attachments[i]!.storageKey, buffer: files[i]!.buffer, contentType: attachments[i]!.mimeType });
        const row = await reserveReply({ tenantId: a.tenantId, projectId: a.projectId, userId: a.userId, channel: "ai_chat", requestKey: b.request_key, prompt: b.message, attachments });
        const saved = await prisma.assistantAttachment.findMany({ where: { replyId: row.id }, select: { storageKey: true } });
        retained = attachments.length > 0 && saved.some(f => f.storageKey === attachments[0]!.storageKey);
        if (row.status === "completed" && row.authorizationHash !== context.authorization_hash)
            throw forbidden("Your project access has changed. Ask a new question.");
        return ok(res, await present(row.status === "completed" ? row : await processReply(row.id)));
    }
    finally {
        if (!retained)
            await Promise.all(attachments.map(f => deleteObject(f.storageKey)));
    }
}));
router.get("/attachments/:id", asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), context = await assistantContext(a.tenantId, a.projectId, a.userId);
    const file = await prisma.assistantAttachment.findFirst({ where: { id: String(req.params.id), tenantId: a.tenantId, reply: { projectId: a.projectId, userId: a.userId, channel: "ai_chat", OR: [{ authorizationHash: context.authorization_hash }, { status: { in: ["queued", "processing"] } }] } } });
    if (!file)
        throw notFound("Image not found");
    try {
        const object = await readObject(file.storageKey);
        res.setHeader("Content-Type", file.mimeType);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.send(object.buffer);
    }
    catch (error) {
        if (error instanceof StorageObjectNotFoundError)
            throw notFound("Image not found");
        throw error;
    }
}));
const uploadError: ErrorRequestHandler = (error, _req, _res, next) => {
    if (error instanceof multer.MulterError && error.code !== "LIMIT_FILE_SIZE") return next(badRequest("Attach up to 3 JPG, PNG or WebP images with a question of at most 2,000 characters"));
    next(error);
};
router.use(uploadError);
export { router as assistantRouter };
