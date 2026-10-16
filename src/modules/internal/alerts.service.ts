import { prisma } from "../../core/prisma/client.js";
import { sendMail } from "../../core/mail/mailer.service.js";
import { customerDetails } from "./customers.service.js";
export async function platformAlerts(offset = 0, unread = false, kind?: string) {
    const where = { ...(unread ? { readAt: null } : {}), ...(kind ? { kind } : {}) };
    const [rows, count] = await Promise.all([prisma.platformAlert.findMany({ where, include: { tenant: { select: { name: true, slug: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 31, skip: offset }), prisma.platformAlert.count({ where: { readAt: null } })]);
    return { alerts: await Promise.all(rows.slice(0, 30).map(async (row) => ({ ...row, customer: await customerDetails(row.tenantId, row.userId) }))), unread: count, next_offset: rows.length > 30 ? offset + 30 : null };
}
let timer: ReturnType<typeof setInterval> | undefined, running = false;
async function alertText(row: {
    tenantId: string;
    userId: string | null;
    ticketId: string | null;
    kind: string;
}) {
    const [customer, tenant] = await Promise.all([customerDetails(row.tenantId, row.userId), prisma.tenant.findUnique({ where: { id: row.tenantId } })]);
    if (!tenant)
        return null;
    const root = process.env.ADMIN_WEB_URL?.replace(/\/$/, ""), link = root ? `${root}/?view=${row.ticketId ? 'support&ticket=' + encodeURIComponent(row.ticketId) : 'organizations&organization=' + encodeURIComponent(row.tenantId)}` : '';
    return { subject: `Fund Nesta · ${row.kind === 'signup' ? 'New signup' : 'New support message'} · ${tenant.name}`, text: [tenant.name, customer ? `Customer: ${customer.name}\nMobile: ${customer.mobile}\nEmail: ${customer.email ?? 'Not supplied'}\nShares: ${customer.shares}\n${customer.members.map(m => `${m.project.name}${m.mid ? ' #' + m.mid : ''}: ${m.shares} shares`).join('\n')}` : 'Customer details unavailable', link ? 'Open and reply: ' + link : 'Open the super-admin panel to view details and reply.'].join("\n\n") };
}
export async function deliverPlatformAlerts() {
    const emails = (process.env.PLATFORM_ALERT_EMAILS ?? "").split(",").map(s => s.trim()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)), chatId = process.env.PLATFORM_ALERT_TELEGRAM_CHAT_ID, botToken = process.env.TELEGRAM_BOT_TOKEN;
    const now = new Date();
    // Separate leases, attempts and success markers prevent a failed channel resending a successful one.
    if (emails.length) {
        const rows = await prisma.platformAlert.findMany({ where: { emailSentAt: null, attempts: { lt: 5 }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, orderBy: { createdAt: "asc" }, take: 10 });
        for (const row of rows) {
            const lease = new Date(Date.now() + 120000);
            const claim = await prisma.platformAlert.updateMany({ where: { id: row.id, emailSentAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseUntil: lease, attempts: { increment: 1 } } });
            if (!claim.count)
                continue;
            try {
                const content = await alertText(row);
                if (!content)
                    throw new Error();
                const accepted = await sendMail({ to: emails.join(","), ...content });
                if (!accepted)
                    throw new Error();
                await prisma.platformAlert.updateMany({ where: { id: row.id, leaseUntil: lease }, data: { emailSentAt: new Date(), leaseUntil: null } });
            }
            catch {
                await prisma.platformAlert.updateMany({ where: { id: row.id, leaseUntil: lease }, data: { leaseUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts)) } });
            }
        }
    }
    if (chatId && botToken) {
        const rows = await prisma.platformAlert.findMany({ where: { telegramSentAt: null, telegramAttempts: { lt: 5 }, telegramNextAttemptAt: { lte: now }, OR: [{ telegramLeaseUntil: null }, { telegramLeaseUntil: { lt: now } }] }, orderBy: { createdAt: "asc" }, take: 10 });
        for (const row of rows) {
            const lease = new Date(Date.now() + 120000);
            const claim = await prisma.platformAlert.updateMany({ where: { id: row.id, telegramSentAt: null, OR: [{ telegramLeaseUntil: null }, { telegramLeaseUntil: { lt: now } }] }, data: { telegramLeaseUntil: lease, telegramAttempts: { increment: 1 } } });
            if (!claim.count)
                continue;
            try {
                const content = await alertText(row);
                if (!content)
                    throw new Error();
                const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: (content.subject + "\n\n" + content.text).slice(0, 4096), link_preview_options: { is_disabled: true } }), signal: AbortSignal.timeout(20000) });
                const result = await response.json() as {
                    ok?: boolean;
                };
                if (!response.ok || !result.ok)
                    throw new Error();
                await prisma.platformAlert.updateMany({ where: { id: row.id, telegramLeaseUntil: lease }, data: { telegramSentAt: new Date(), telegramLeaseUntil: null } });
            }
            catch {
                await prisma.platformAlert.updateMany({ where: { id: row.id, telegramLeaseUntil: lease }, data: { telegramLeaseUntil: null, telegramNextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** row.telegramAttempts)) } });
            }
        }
    }
}
export function startPlatformAlerts() { if (timer)
    return; const run = async () => { if (running)
    return; running = true; try {
    await deliverPlatformAlerts();
}
catch {
    console.error('[platform-alerts] delivery failed');
}
finally {
    running = false;
} }; timer = setInterval(() => void run(), 30000); timer.unref(); }
export function stopPlatformAlerts() { if (timer)
    clearInterval(timer); timer = undefined; }
