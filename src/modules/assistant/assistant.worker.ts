import { subscriptionContext } from "../../core/subscription/subscription.repository.js";
import { purgeObject } from "../../core/storage/object-storage.service.js";
import { prisma } from "../../core/prisma/client.js";
import { sendWhatsAppBotReply } from "../../core/whatsapp/whatsapp.service.js";
import { assistantContext } from "./assistant.context.js";
import { botConfigured, hasBusinessAssistant } from "./assistant.policy.js";
import { processReply } from "./assistant.service.js";
let timer: ReturnType<typeof setInterval> | null = null, running = false;
export async function runAssistantJobs() {
  const now = new Date();
  const expired=await prisma.assistantReply.findMany({where:{createdAt:{lt:new Date(now.getTime()-90*86400000)}},include:{attachments:true},take:25});
  for(const row of expired){for(const file of row.attachments)await purgeObject(file.storageKey);await prisma.assistantReply.delete({where:{id:row.id}});}
  if (!botConfigured()) return;
  const rows = await prisma.assistantReply.findMany({ where: { channel: "whatsapp_bot", OR: [{ status: "queued" }, { status: "ready" }, { status: "processing", leaseUntil: { lt: now } }] }, orderBy: { createdAt: "asc" }, take: 10 });
  for (const row of rows) {
    try {
      if (now.getTime() - row.createdAt.getTime() > 23 * 3600000 || row.attempts >= 3 && row.status !== "ready") {
        await prisma.assistantReply.updateMany({ where: { id: row.id, status: row.status }, data: { status: "failed", errorCode: "REPLY_EXPIRED" } }); continue;
      }
      const completed = row.status === "ready" ? row : await processReply(row.id);
      if (completed.status !== "ready" || !completed.reply || !completed.recipient || !completed.connectionId) continue;
      const tenant = await prisma.tenant.findUniqueOrThrow({ include: { subscription: true },  where: { id: row.tenantId } });
      if (!hasBusinessAssistant(subscriptionContext(tenant))) {
        await prisma.assistantReply.updateMany({ where: { id: row.id, status: "ready" }, data: { status: "failed", reply: null, errorCode: "BUSINESS_REQUIRED" } }); continue;
      }
      const context = await assistantContext(row.tenantId, row.projectId, row.userId);
      if (completed.authorizationHash !== context.authorization_hash) {
        await prisma.assistantReply.updateMany({ where: { id: row.id, status: "ready" }, data: { status: "failed", reply: null, errorCode: "ACCESS_CHANGED" } }); continue;
      }
      const claimed = await prisma.assistantReply.updateMany({ where: { id: row.id, status: "ready" }, data: { status: "sending" } });
      if (!claimed.count) continue;
      try {
        await sendWhatsAppBotReply({ tenantId: row.tenantId, projectId: row.projectId, connectionId: completed.connectionId, recipient: completed.recipient, message: completed.reply });
        await prisma.assistantReply.update({ where: { id: row.id }, data: { status: "completed", deliveredAt: new Date() } });
      } catch { await prisma.assistantReply.update({ where: { id: row.id }, data: { status: "delivery_unknown", errorCode: "WHATSAPP_DELIVERY_UNCONFIRMED" } }); }
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 403)
        await prisma.assistantReply.updateMany({ where: { id: row.id, status: "ready" }, data: { status: "failed", reply: null, errorCode: "ACCESS_CHANGED" } });
      console.error("[assistant] bot job failed", { id: row.id });
    }
  }

}
export function startAssistantWorker() {
  if (timer) return;
  const run = async () => { if (running) return; running = true; try { await runAssistantJobs(); } catch { console.error("[assistant] worker failed"); } finally { running = false; } };
  timer = setInterval(() => void run(), 10000); timer.unref();
}
export function stopAssistantWorker() { if (timer) clearInterval(timer); timer = null; }
