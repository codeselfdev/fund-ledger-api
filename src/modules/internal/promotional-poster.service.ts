import { randomUUID } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, serviceUnavailable } from '../../core/http/api-error.js';
import { publicObjectUrl, storeObject } from '../../core/storage/object-storage.service.js';
import { assistantImageInfo } from '../assistant/image-policy.js';
import { validHttpsUrl } from './notification-links.js';

export async function uploadPromotionalPoster(actor: string, buffer: Buffer,
  storage = { publicObjectUrl, storeObject }, db = prisma) {
  if (!buffer.length || buffer.length >= 1_000_000) throw badRequest('Choose a poster image below 1 MB.');
  const info = assistantImageInfo(buffer);
  if (!info) throw badRequest('Choose a static JPG, PNG or WebP poster, at most 1,600 pixels per side.');
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[info.type];
  const storageKey = `platform/promotions/${randomUUID()}.${extension}`;
  const image_url = storage.publicObjectUrl(storageKey);
  if (!image_url || !validHttpsUrl(image_url)) throw serviceUnavailable('Poster uploads require public HTTPS R2 storage. Configure R2_PUBLIC_URL or use a public image URL.');
  await storage.storeObject({ storageKey, buffer, contentType: info.type });
  await db.internalAudit.create({ data: { actor, action: 'notification.poster_uploaded', metadata: { storage_key: storageKey, bytes: buffer.length } } });
  return { image_url };
}
