import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { evaluateSubscription } from "../../core/subscription/subscription.service.js";
import { packageId } from "../../core/subscription/packages.js";
export const chatSchema = z.object({ message: z.string().trim().min(1).max(2000), request_key: z.string().uuid() }).strict();
export type AssistantChannel = "ai_chat" | "whatsapp_bot";
export const CHANNELS: AssistantChannel[] = ["ai_chat", "whatsapp_bot"];
export function monthlyPeriod(now = new Date()) {
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}
export function allowancePeriod(contact: unknown, now = new Date()) {
  const period = monthlyPeriod(now);
  const reset = (contact as { subscription?: { quota_reset_at?: string } } | null)?.subscription?.quota_reset_at;
  const date = reset ? new Date(reset) : null;
  if (date && date > period.start && date <= now) period.start = date;
  return period;
}
export function featureLimit(channel: AssistantChannel, contact?: unknown) {
  const plan = contact === undefined ? "business" : packageId(contact);
  if (channel === "ai_chat" && plan === "free") return 10;
  if (channel === "ai_chat" && plan === "starter") return 100;
  if (contact !== undefined && plan !== "business") return 0;
  const configured = Number(process.env[channel === "ai_chat" ? "BUSINESS_AI_REPLIES_PER_MONTH" : "BUSINESS_WHATSAPP_REPLIES_PER_MONTH"] ?? 1000);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 1000;
}
export function hasBusinessAssistant(contact: unknown, now = new Date()) {
  return packageId(contact) === "business" && evaluateSubscription(contact, now).status === "active";
}
export function hasAssistant(contact: unknown, channel: AssistantChannel = "ai_chat", now = new Date()) {
  if (channel === "whatsapp_bot") return hasBusinessAssistant(contact, now);
  const plan = packageId(contact), subscription = evaluateSubscription(contact, now);
  return subscription.has_access && (plan === "free" || plan === "starter" && subscription.status === "active" || hasBusinessAssistant(contact, now));
}
export function assistantUpgrade(contact: unknown) {
  return ({ free: "starter", starter: "business", business: "custom", custom: null } as const)[packageId(contact)];
}
export function assistantQuotaMessage(contact: unknown) {
  const next = assistantUpgrade(contact);
  return `Your organization has used this month's AI credits. ${next === "starter" ? "Upgrade to Starter for 100 AI credits per month." : next === "business" ? "Upgrade to Business for 1,000 AI credits per month." : "Contact us about a Custom plan for more capacity."}`;
}
export function aiConfigured() { return process.env.AI_CHAT_ENABLED === "true" && !!process.env.OPENAI_API_KEY?.trim() && !!process.env.OPENAI_CHAT_MODEL?.trim(); }
export function botConfigured() { return aiConfigured() && process.env.WHATSAPP_ENABLED === "true" && !!process.env.WHATSAPP_APP_SECRET && !!process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN; }
export function validWhatsAppSignature(body: Buffer, header: string | undefined, secret: string | undefined) {
  if (!secret || !header || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const supplied = Buffer.from(header.slice(7), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
