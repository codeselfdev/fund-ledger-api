import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { storeObject, deleteObject } from '../../core/storage/object-storage.service.js';
import { screenshotType } from '../support/support.service.js';

const metadata = { id: true, fileName: true, mimeType: true, size: true } as const;

/** Retain action-chat images in the same private store used by the attachment endpoint. */
export async function retainChatAttachments(tenantId: string, replyId: string, files: Express.Multer.File[]) {
  if (!files.length) return [];
  const where = { tenantId, replyId };
  const existing = await prisma.assistantAttachment.findMany({ where, select: metadata });
  if (existing.length) return existing;
  const attachments = files.map(file => ({ ...where, fileName: file.originalname.slice(0, 180),
    mimeType: screenshotType(file.buffer), size: file.size,
    contentHash: createHash('sha256').update(file.buffer).digest('hex'),
    storageKey: `${tenantId}/assistant/${randomUUID()}` }));
  const written: string[] = [];
  let retained = false;
  try {
    for (const [i, attachment] of attachments.entries()) {
      written.push(attachment.storageKey);
      await storeObject({ storageKey: attachment.storageKey, buffer: files[i]!.buffer, contentType: attachment.mimeType });
    }
    const result = await prisma.$transaction(async tx => {
      // Serialize duplicate HTTP retries so one request retains one image set.
      await tx.$queryRaw`SELECT id FROM assistant_replies WHERE id = ${replyId} AND tenant_id = ${tenantId} FOR UPDATE`;
      const saved = await tx.assistantAttachment.findMany({ where, select: metadata });
      if (saved.length) return { created: false, attachments: saved };
      await tx.assistantAttachment.createMany({ data: attachments });
      return { created: true, attachments: await tx.assistantAttachment.findMany({ where, select: metadata }) };
    });
    retained = result.created;
    return result.attachments;
  } finally {
    if (!retained) await Promise.allSettled(written.map(storageKey => deleteObject(storageKey)));
  }
}

export const chatAttachmentSelection = metadata;
