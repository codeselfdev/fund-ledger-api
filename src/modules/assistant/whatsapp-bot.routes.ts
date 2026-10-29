import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { prisma } from "../../core/prisma/client.js";
import { ApiError } from "../../core/http/api-error.js";
import { botConfigured, validWhatsAppSignature } from "./assistant.policy.js";
import { reserveReply } from "./assistant.service.js";
import { forwardWhatsAppGroupMessages, receiveManagedGroupLifecycle } from "../../core/whatsapp/managed-whatsapp.service.js";
const router = Router();
const payloadSchema = z.object({ object: z.literal("whatsapp_business_account"), entry: z.array(z.object({ id: z.string(), changes: z.array(z.object({ value: z.object({ metadata: z.object({ phone_number_id: z.string() }).optional(), group_id: z.string().optional(), messages: z.array(z.object({ id: z.string().max(200), from: z.string().regex(/^\d{7,15}$/), timestamp: z.string(), type: z.string(), group_id: z.string().optional(), context: z.object({ group_id: z.string().optional() }).optional(), text: z.object({ body: z.string().max(2000) }).optional() })).max(50).optional() }) })).max(50) })).max(50) });
router.get("/", (req, res) => {
  const token = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!token || req.query["hub.mode"] !== "subscribe" || req.query["hub.verify_token"] !== token || typeof req.query["hub.challenge"] !== "string") return res.sendStatus(403);
  return res.status(200).type("text/plain").send(req.query["hub.challenge"]);
});
router.post("/", asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !validWhatsAppSignature(req.body, req.header("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET)) throw new ApiError(403, "INVALID_SIGNATURE", "Invalid webhook signature.");
  let json: unknown; try { json = JSON.parse(req.body.toString("utf8")); } catch { return res.sendStatus(400); }
  await receiveManagedGroupLifecycle(json);
  await forwardWhatsAppGroupMessages(req.body, req.header("x-hub-signature-256")!, json);
  if (!botConfigured()) return res.sendStatus(200);
  const parsed = payloadSchema.safeParse(json); if (!parsed.success) return res.sendStatus(200);
  for (const entry of parsed.data.entry) for (const change of entry.changes) {
    const phoneId = change.value.metadata?.phone_number_id;
    if (!phoneId || !change.value.messages?.length) continue;
    const connections = await prisma.whatsAppConnection.findMany({ where: { phoneNumberId: phoneId, wabaId: entry.id, isActive: true }, take: 2 });
    if (connections.length !== 1) continue; // Ambiguous routing never guesses an organization.
    const connection = connections[0]!;
    for (const message of change.value.messages) {
      if (message.group_id || message.context?.group_id || change.value.group_id) continue;
      const age = Date.now() - Number(message.timestamp) * 1000;
      if (message.type !== "text" || !message.text?.body.trim() || !Number.isFinite(age) || age < -300000 || age > 23 * 3600000) continue;
      const users = await tenantAccounts(prisma).findMany({ where: { tenantId: connection.tenantId, isActive: true, mobile: { in: [message.from, `+${message.from}`] }, memberships: { some: { tenantId: connection.tenantId, projectId: connection.projectId, isActive: true } } }, take: 2 });
      if (users.length !== 1) continue;
      try { await reserveReply({ tenantId: connection.tenantId, projectId: connection.projectId, userId: users[0]!.id, channel: "whatsapp_bot", requestKey: message.id, prompt: message.text.body.trim(), recipient: message.from, connectionId: connection.id }); }
      catch (error) { if (!(error instanceof ApiError && [403, 409, 429].includes(error.statusCode))) throw error; }
    }
  }
  return res.sendStatus(200); // Acknowledge durable jobs before provider work.
}));
export { router as whatsappBotWebhookRouter };
