import cron, { type ScheduledTask } from 'node-cron';
import { prisma } from '../../core/prisma/client.js';
let task: ScheduledTask | null = null;
export async function expireBusinessImports() {
  return prisma.businessImport.updateMany({ where: { status: 'preview', expiresAt: { lt: new Date() } }, data: { status: 'expired', payload: {}, preview: {} } });
}
export function startBusinessImportRetention() {
  if (!task) task = cron.schedule('*/15 * * * *', () => { void expireBusinessImports().catch(error => console.error('[business-import] preview cleanup failed', error)); });
}
export function stopBusinessImportRetention() { task?.stop(); task = null; }
