import { prisma } from "../prisma/client.js";
import { purgeObject } from "../storage/object-storage.service.js";
import { getStoredSubscription } from "./subscription.service.js";
import { packageId, addCalendarMonths } from "./packages.js";

export function freeDocumentsPurgeAt(contact: unknown): Date | null {
  const stored = getStoredSubscription(contact);
  if (packageId(contact) !== "free" || !stored?.trial_ends_at) return null;
  const end = new Date(stored.trial_ends_at);
  return Number.isNaN(end.getTime()) ? null : addCalendarMonths(end, 3);
}
/** Bounded and retryable; failed storage deletes retain the row for the next run. */
export async function cleanupRetainedDocuments(now = new Date()) {
  const candidates = await prisma.tenant.findMany({
    where: { contact: { path: ["subscription", "trial_ends_at"], lte: now.toISOString() } },
    select: { id: true, contact: true }
  });
  // Deleted paid documents use the same three-month recovery period.
  const removed = await prisma.upload.findMany({ where: { purgeAfterAt: { lte: now } }, select: { tenantId: true }, distinct: ["tenantId"], take: 100 });
  const ids = [...new Set([...candidates.filter(t => { const at = freeDocumentsPurgeAt(t.contact); return at && at <= now; }).map(t => t.id), ...removed.map(u => u.tenantId)])];
  let purged = 0, failed = 0;
  for (const tenantId of ids) {
    try {
      purged += await prisma.$transaction(async tx => {
      // Approval updates this same row. Recheck after the lock, before touching storage.
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      const cutoff = freeDocumentsPurgeAt(tenant.contact), expiredFree = cutoff !== null && cutoff <= now;
      const rows = await tx.upload.findMany({ where: { tenantId, ...(expiredFree ? {} : { purgeAfterAt: { lte: now } }) }, take: 50 });
      for (const row of rows) {
        await purgeObject(row.storageKey);
        await tx.upload.delete({ where: { id: row.id } });
        await tx.activity.create({ data: { tenantId, projectId: row.projectId, action: "document.retention_purged", entityType: "upload", entityId: row.id } });
      }
      return rows.length;
      }, { timeout: 60000 });
    } catch { failed++; console.error("[documents] tenant retention cleanup failed", { tenantId }); }
  }
  return { purged, failed };
}
