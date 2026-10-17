import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { sendMail } from "../../core/mail/mailer.service.js";
import { sendPushMessage } from "../../core/notifications/fcm.service.js";

const title = "Fund Nesta support replied";
export function supportReplyPreview(body: string) {
  return body.trim().slice(0, 240) || "The Fund Nesta team sent you an attachment. Open Support to view it.";
}

/** Called inside the message transaction, after its idempotency check. */
export async function queueSupportReply(
  tx: Prisma.TransactionClient,
  ticket: { id: string; tenantId: string; requesterId: string },
  message: { id: string; body: string },
) {
  await tx.notification.create({ data: {
    id: `support-reply:${message.id}`,
    tenantId: ticket.tenantId,
    recipientUserId: ticket.requesterId,
    type: "support.replied",
    title,
    body: supportReplyPreview(message.body),
    entityType: "support_ticket",
    entityId: ticket.id,
  } });
  await tx.supportReplyDelivery.createMany({ data: ["push", "email"].map(channel => ({
    tenantId: ticket.tenantId, messageId: message.id, channel,
  })) });
}

export function createSupportReplyNotifier(
  db = prisma,
  transports = { push: sendPushMessage, email: sendMail },
) {
  async function deliver() {
    const now = new Date();
    // A crash during the final attempt must not leave an unclaimable pending row.
    await db.supportReplyDelivery.updateMany({ where: { status: "pending", attempts: { gte: 5 },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { status: "failed", lastError: "retry_limit_reached", leaseUntil: null, leaseToken: null } });
    const available = { status: "pending", attempts: { lt: 5 }, nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
    const rows = await db.supportReplyDelivery.findMany({ where: available, orderBy: { createdAt: "asc" }, take: 20 });
    for (const row of rows) {
      const leaseToken = randomUUID();
      const claim = await db.supportReplyDelivery.updateMany({ where: { id: row.id, ...available },
        data: { leaseToken, leaseUntil: new Date(Date.now() + 300000), attempts: { increment: 1 } } });
      if (!claim.count) continue;
      const finish = (data: Prisma.SupportReplyDeliveryUpdateManyMutationInput) => db.supportReplyDelivery.updateMany({
        where: { id: row.id, leaseToken }, data: { ...data, leaseUntil: null, leaseToken: null },
      });
      try {
        const message = await db.supportMessage.findFirst({ where: { id: row.messageId, tenantId: row.tenantId, sender: "team" },
          include: { ticket: { include: { requester: true, tenant: { select: { deletionStartedAt: true } } } }, _count: { select: { attachments: true } } } });
        const ticket = message?.ticket, user = ticket?.requester;
        if (!message || !ticket || !user || ticket.tenantId !== row.tenantId || user.tenantId !== row.tenantId || !user.isActive || ticket.tenant.deletionStartedAt) {
          await finish({ status: "skipped", lastError: "recipient_unavailable" }); continue;
        }
        if (row.channel === "push") {
          const token = user.deviceId?.trim();
          if (!token) { await finish({ status: "skipped", lastError: "no_registered_device" }); continue; }
          const result = await transports.push({ tokens: [token], title, body: supportReplyPreview(message.body), data: {
            type: "support.replied", tenant_id: row.tenantId, entity_type: "support_ticket", entity_id: ticket.id,
          } });
          if (result.invalid_tokens.includes(token)) {
            await db.user.updateMany({ where: { id: user.id, tenantId: row.tenantId, deviceId: token }, data: { deviceId: null } });
            await finish({ status: "skipped", lastError: "invalid_device_token" }); continue;
          }
          if (result.sent_count !== 1) throw new Error("push_unavailable");
        } else if (row.channel === "email") {
          const email = user.email?.trim();
          if (!email) { await finish({ status: "skipped", lastError: "no_email_address" }); continue; }
          const link = `fundnesta://support?ticket_id=${encodeURIComponent(ticket.id)}&tenant_id=${encodeURIComponent(row.tenantId)}`;
          const accepted = await transports.email({ to: email, fromName: "Fund Nesta support",
            subject: `Fund Nesta support: ${ticket.subject.replace(/[\r\n]/g, " ")}`,
            text: [`Hello ${user.name},`, `The Fund Nesta team replied to your support request: ${ticket.subject}`,
              message.body || "The team sent you an attachment.",
              message._count.attachments ? `${message._count.attachments} screenshot(s) available in your private support conversation.` : "",
              "Open Fund Nesta → Support to view the conversation and reply.", link].filter(Boolean).join("\n\n"),
          });
          if (!accepted) throw new Error("email_unavailable");
        } else {
          await finish({ status: "skipped", lastError: "unsupported_channel" }); continue;
        }
        await finish({ status: "sent", sentAt: new Date(), lastError: null });
      } catch {
        await finish({ status: row.attempts + 1 >= 5 ? "failed" : "pending", lastError: "provider_unavailable",
          nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts)) });
      }
    }
  }
  return { deliver };
}

const notifier = createSupportReplyNotifier();
let timer: ReturnType<typeof setInterval> | undefined, running = false;
export function startSupportReplyNotifications() {
  if (timer) return;
  const run = async () => {
    if (running) return;
    running = true;
    try { await notifier.deliver(); }
    catch { console.error("[support-notifications] delivery failed"); }
    finally { running = false; }
  };
  timer = setInterval(() => void run(), 15000);
  timer.unref();
  void run();
}
export function stopSupportReplyNotifications() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
