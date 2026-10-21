import type { Prisma } from '@prisma/client';
import { readObject } from '../../core/storage/object-storage.service.js';
export async function documentLogo(db: Prisma.TransactionClient, auth: { tenantId: string; projectId: string }, snapshot: unknown, read = readObject) {
  const p = snapshot as { logoFileId?: string | null } | null;
  const id = p && 'logoFileId' in p ? p.logoFileId : (await db.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId } }))?.logoFileId;
  if (!id) return null;
  const file = await db.upload.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId, purpose: 'project_logo', mimeType: { in: ['image/png', 'image/jpeg'] } } });
  if (!file) return null;
  try { const object = await read(file.storageKey); return object.buffer.length < 2_000_000 ? { buffer: object.buffer, mime: file.mimeType } : null; } catch { return null; }
}
