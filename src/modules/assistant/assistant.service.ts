import { readObject } from "../../core/storage/object-storage.service.js";
import { createHash } from "node:crypto";
import { prisma } from "../../core/prisma/client.js";
import { ApiError, conflict, forbidden } from "../../core/http/api-error.js";
import { aiConfigured, botConfigured, CHANNELS, featureLimit, hasAssistant, assistantUpgrade, assistantQuotaMessage, allowancePeriod, type AssistantChannel } from "./assistant.policy.js";
import { assistantContext } from "./assistant.context.js";
import { generateAssistantReply } from "./assistant.provider.js";
export async function assistantStatus(tenantId: string, now = new Date()) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { contact: true } });
    const period = allowancePeriod(tenant.contact, now);
    const usage = await prisma.assistantReply.groupBy({ by: ["channel"], where: { tenantId, periodStart: period.start, status: { not: "cancelled" } }, _count: true });
    return { action_service_enabled: !!process.env.AI_SERVICE_URL, resets_at: period.end.toISOString(), upgrade_plan: assistantUpgrade(tenant.contact), features: Object.fromEntries(CHANNELS.map(channel => [channel, { enabled: hasAssistant(tenant.contact, channel, now), configured: !!process.env.AI_SERVICE_URL || (channel === "ai_chat" ? aiConfigured() : botConfigured()), used: usage.find(row => row.channel === channel)?._count ?? 0, limit: featureLimit(channel, tenant.contact, now) }])) };
}
export async function reserveReply(input: {
    tenantId: string;
    projectId: string;
    userId: string;
    channel: AssistantChannel;
    requestKey: string;
    prompt: string;
    recipient?: string;
    connectionId?: string;
    attachments?: {
        fileName: string;
        mimeType: string;
        size: number;
        contentHash: string;
        storageKey: string;
    }[];
}) {
    const now = new Date(), hash = createHash("sha256").update(input.attachments?.length ? JSON.stringify([input.prompt, input.attachments.map(f => [f.fileName, f.contentHash])]) : input.prompt).digest("hex");
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw `SELECT id FROM tenants WHERE id = ${input.tenantId} FOR NO KEY UPDATE`;
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: input.tenantId } });
        const period = allowancePeriod(tenant.contact, now);
        if (!hasAssistant(tenant.contact, input.channel, now))
            throw new ApiError(403, "ASSISTANT_PLAN_REQUIRED", "An active eligible plan is required to use this assistant channel.");
        const key = { tenantId: input.tenantId, channel: input.channel, requestKey: input.requestKey };
        const existing = await tx.assistantReply.findUnique({ where: { tenantId_channel_requestKey: key } });
        if (existing) {
            if (existing.userId !== input.userId || existing.projectId !== input.projectId)
                throw forbidden();
            if (existing.promptHash !== hash)
                throw conflict("This request key was already used for another question.");
            return existing;
        }
        const used = await tx.assistantReply.count({ where: { tenantId: input.tenantId, channel: input.channel, periodStart: period.start, status: { not: "cancelled" } } });
        if (used >= featureLimit(input.channel, tenant.contact, now))
            throw new ApiError(429, "ASSISTANT_QUOTA_EXCEEDED", assistantQuotaMessage(tenant.contact));
        const data = { ...key, userId: input.userId, projectId: input.projectId, promptHash: hash, prompt: input.prompt, periodStart: period.start, status: "queued", leaseUntil: null, errorCode: null, recipient: input.recipient, connectionId: input.connectionId };
        return tx.assistantReply.create({ data: { ...data, attachments: { create: input.attachments?.map(f => ({ ...f, tenantId: input.tenantId })) ?? [] } } });
    });
}
export async function processReply(id: string) {
    const now = new Date();
    const claimed = await prisma.assistantReply.updateMany({ where: { id, attempts: { lt: 3 }, OR: [{ status: "queued" }, { status: "processing", leaseUntil: { lt: now } }] }, data: { status: "processing", attempts: { increment: 1 }, leaseUntil: new Date(now.getTime() + 60000) } });
    if (!claimed.count) {
        await prisma.assistantReply.updateMany({ where: { id, status: "processing", attempts: { gte: 3 }, leaseUntil: { lt: now } }, data: { status: "failed", errorCode: "AI_UNAVAILABLE", leaseUntil: null } });
        return prisma.assistantReply.findUniqueOrThrow({ where: { id } });
    }
    const row = await prisma.assistantReply.findUniqueOrThrow({ where: { id } });
    try {
        const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: row.tenantId } });
        if (!hasAssistant(tenant.contact, row.channel as AssistantChannel))
            throw new ApiError(403, "ASSISTANT_PLAN_REQUIRED", "An active eligible plan is required.");
        const context = await assistantContext(row.tenantId, row.projectId, row.userId);
        const history = await prisma.assistantReply.findMany({ where: { tenantId: row.tenantId, projectId: row.projectId, userId: row.userId, channel: row.channel, authorizationHash: context.authorization_hash, status: "completed", id: { not: id } }, orderBy: { createdAt: "desc" }, take: 4, select: { prompt: true, reply: true } });
        const attachments = await prisma.assistantAttachment.findMany({ where: { replyId: id, tenantId: row.tenantId } });
        const images = await Promise.all(attachments.map(async (file) => ({ mimeType: file.mimeType, buffer: (await readObject(file.storageKey)).buffer })));
        const reply = await generateAssistantReply(context, history.reverse().flatMap(h => [{ role: "user" as const, content: h.prompt }, { role: "assistant" as const, content: h.reply ?? "" }]), row.prompt, images);
        await prisma.assistantReply.updateMany({ where: { id, status: "processing", attempts: row.attempts }, data: { reply, authorizationHash: context.authorization_hash, status: row.channel === "whatsapp_bot" ? "ready" : "completed", leaseUntil: null } });
    }
    catch (error) {
        await prisma.assistantReply.updateMany({ where: { id, status: "processing", attempts: row.attempts }, data: { status: "failed", leaseUntil: null, errorCode: error instanceof ApiError ? error.code : "AI_UNAVAILABLE" } });
        if (row.channel === "ai_chat")
            throw error;
    }
    return prisma.assistantReply.findUniqueOrThrow({ where: { id } });
}
export function publicReply(row: {
    id: string;
    prompt: string;
    reply: string | null;
    status: string;
    requestKey: string;
    createdAt: Date;
}) {
    return { id: row.id, message: row.prompt, reply: row.reply, status: row.status, request_key: row.requestKey, created_at: row.createdAt };
}
