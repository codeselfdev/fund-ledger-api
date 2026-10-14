import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from '../../core/prisma/client.js';
import { sendMail } from '../../core/mail/mailer.service.js';
import { evaluateSubscription } from '../../core/subscription/subscription.service.js';
import { processRun } from './billing.service.js';
let task: ScheduledTask | null = null;
let running = false;
async function allowed(tenantId: string, projectId: string, userId?: string) {
    const project = await prisma.project.findFirst({ where: { id: projectId, tenantId, isActive: true, projectType: 'billing' }, include: { tenant: true } });
    if (!project || !evaluateSubscription(project.tenant.contact).has_access)
        return false;
    if (userId && !await prisma.projectMembership.findFirst({ where: { tenantId, projectId, userId, isActive: true, role: { in: ['owner', 'admin', 'accountant'] }, user: { isActive: true } } }))
        return false;
    return true;
}
export async function runBillingWorker() {
    if (running)
        return;
    running = true;
    try {
        const runs = await prisma.billingRun.findMany({ where: { status: { in: ['queued', 'running'] } }, orderBy: { updatedAt: 'asc' }, take: 5 });
        for (const run of runs) {
            try {
                if (await allowed(run.tenantId, run.projectId, run.createdById))
                    await processRun(run.id, 100);
                else
                    await prisma.billingRun.updateMany({ where: { id: run.id, status: { in: ['queued', 'running'] } }, data: { status: run.status } });
            }
            catch (error) {
                console.error('[billing] invoice run will retry', run.id, error);
            }
        }
        const now = new Date();
        await prisma.billingMessage.updateMany({ where: { status: 'sending', attempts: { gte: 5 }, leaseUntil: { lt: now } }, data: { status: 'failed', leaseUntil: null, lastError: 'Delivery could not be confirmed after the final attempt' } });
        const where = { attempts: { lt: 5 }, OR: [{ status: 'queued', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, { status: 'sending', leaseUntil: { lt: now } }] };
        const messages = await prisma.billingMessage.findMany({ where, orderBy: { createdAt: 'asc' }, take: 25 });
        for (const row of messages) {
            if (!await allowed(row.tenantId, row.projectId)) {
                await prisma.billingMessage.updateMany({ where: { id: row.id, ...where }, data: { status: 'queued', leaseUntil: new Date(Date.now() + 600000), lastError: 'Project or subscription access is unavailable' } });
                continue;
            }
            const claimed = await prisma.billingMessage.updateMany({ where: { id: row.id, ...where }, data: { status: 'sending', leaseUntil: new Date(Date.now() + 300000), attempts: { increment: 1 } } });
            if (!claimed.count)
                continue;
            try {
                const sent = await sendMail({ to: row.recipient, subject: row.subject, text: row.body });
                if (!sent)
                    throw new Error('SMTP is not configured');
                await prisma.billingMessage.update({ where: { id: row.id }, data: { status: 'sent', sentAt: new Date(), leaseUntil: null, lastError: null } });
            }
            catch (error) {
                await prisma.billingMessage.update({ where: { id: row.id }, data: { status: row.attempts + 1 >= 5 ? 'failed' : 'queued', leaseUntil: new Date(Date.now() + 600000), lastError: error instanceof Error ? error.message.slice(0, 500) : 'Mail delivery failed' } });
            }
        }
    }
    catch (error) {
        console.error('[billing] worker failed', error);
    }
    finally {
        running = false;
    }
}
export function startBillingWorker() {
    if (!task)
        task = cron.schedule('*/10 * * * * *', () => { void runBillingWorker(); });
    return task;
}
export function stopBillingWorker() { task?.stop(); task = null; }
