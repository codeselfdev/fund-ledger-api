import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { ok } from '../../core/http/response.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { deleteObject, storeObject } from '../../core/storage/object-storage.service.js';
import { tenantQuota } from '../../core/subscription/quota.service.js';
import { addCalendarMonths } from '../../core/subscription/packages.js';
import { financialTransaction } from '../accounting/transaction.js';

type Auth = ReturnType<typeof requireProjectContext>;
type LogoEntity = 'customer' | 'dealer';
const entitySchema = z.enum(['customer', 'dealer']);
export const MAX_BUSINESS_LOGO_BYTES = 2_000_000;
const receive = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BUSINESS_LOGO_BYTES + 1, files: 1, fields: 1 } }).single('file');
const router = Router({ mergeParams: true });
const scope = (auth: Auth) => ({ tenantId: auth.tenantId, projectId: auth.projectId });
const purpose = (entity: LogoEntity, id: string) => `${entity}_logo:${id}`;

async function assertRecord(auth: Auth, entity: LogoEntity, id: string, write = false) {
  if (write) {
    const finance = auth.roles.some(role => ['owner', 'admin', 'accountant'].includes(role));
    const cashier = entity === 'customer' && auth.roles.includes('cashier');
    if (!finance && !cashier) throw forbidden('You cannot change this logo.');
    if (!finance && (await prisma.project.findFirst({ where: { tenantId: auth.tenantId, id: auth.projectId } }))?.projectType === 'billing') throw forbidden('Only administrators and accountants can edit billing customers.');
  }
  const where = { ...scope(auth), id };
  const record = entity === 'customer' ? await prisma.customer.findFirst({ where }) : await prisma.vendor.findFirst({ where });
  if (!record) throw notFound(`${entity === 'customer' ? 'Customer' : 'Dealer'} not found`);
}

export async function withBusinessLogos<T extends { id: string }>(rows: T[], auth: Auth, entity: LogoEntity, db: Prisma.TransactionClient = prisma) {
  if (!rows.length) return [];
  const logos = await db.upload.findMany({ where: { ...scope(auth), deletedAt: null, purpose: { in: rows.map(row => purpose(entity, row.id)) } }, select: { id: true, purpose: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const current = new Map<string, string>();
  for (const logo of logos) if (logo.purpose && !current.has(logo.purpose)) current.set(logo.purpose, logo.id);
  return rows.map(row => ({ ...row, logoFileId: current.get(purpose(entity, row.id)) ?? null }));
}

router.get('/', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entitySchema.parse(req.params.entity), id = req.params.id;
  await assertRecord(auth, entity, id);
  const [row] = await withBusinessLogos([{ id }], auth, entity);
  return ok(res, { file_id: row.logoFileId });
}));

async function replace(auth: Auth, entity: LogoEntity, id: string, expected: string | null, file?: Express.Multer.File) {
  const mime = file?.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : 'image/jpeg';
  const storageKey = `${auth.tenantId}/${auth.projectId}/${entity}_logo/${id}-${nanoid()}`;
  if (file) await storeObject({ storageKey, buffer: file.buffer, contentType: mime });
  try {
    return await financialTransaction(async db => {
      // Upload quota guards use this same lock. Replacement frees its own slot atomically.
      await db.$queryRaw`SELECT id FROM tenants WHERE id = ${auth.tenantId} FOR NO KEY UPDATE`;
      const owned = { ...scope(auth), id };
      const record = entity === 'customer' ? await db.customer.findFirst({ where: owned }) : await db.vendor.findFirst({ where: owned });
      if (!record) throw notFound('Record not found');
      const active = { ...scope(auth), purpose: purpose(entity, id), deletedAt: null };
      const previous = await db.upload.findFirst({ where: active, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if ((previous?.id ?? null) !== expected) throw conflict('The logo changed. Reopen this record to review its latest logo before saving.');
      const now = new Date();
      await db.upload.updateMany({ where: active, data: { deletedAt: now, purgeAfterAt: addCalendarMonths(now, 3) } });
      let next: string | null = null;
      if (file) {
        const quota = await tenantQuota(auth.tenantId, db);
        if (quota.documents.limit !== null && quota.documents.used >= quota.documents.limit) throw new ApiError(409, 'DOCUMENT_QUOTA_EXCEEDED', 'Your organization has reached its document limit. Remove a document or upgrade your package.', { quota });
        const upload = await db.upload.create({ data: { ...scope(auth), userId: auth.userId, fileName: file.originalname, mimeType: mime, size: file.size, storageKey, purpose: purpose(entity, id) } });
        next = upload.id;
      }
      await db.activity.create({ data: { ...scope(auth), actorUserId: auth.userId, action: file ? 'business.logo.updated' : 'business.logo.removed', entityType: entity, entityId: id, before: { logo_file_id: previous?.id ?? null }, after: { logo_file_id: next } } });
      return { file_id: next };
    });
  } catch (error) { if (file) await deleteObject(storageKey).catch(() => {}); throw error; }
}

router.post('/', asyncHandler(async (req, _res, next) => {
  const entity = entitySchema.parse(req.params.entity);
  await assertRecord(requireProjectContext(req), entity, req.params.id, true); next();
}), (req, res, next) => receive(req, res, error => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return next(badRequest('Choose a logo of 2 MB or smaller.'));
  next(error);
}), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entitySchema.parse(req.params.entity), file = req.file;
  if (!file || file.size <= 0) throw badRequest('Choose an image for the logo.');
  if (file.size > MAX_BUSINESS_LOGO_BYTES) throw badRequest('Choose a logo of 2 MB or smaller.');
  const png = file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff;
  if (!png && !jpeg) throw badRequest('Logo must be a JPG or PNG image.');
  const body = z.object({ expected_file_id: z.string().max(200).transform(value => value || null) }).strict().parse(req.body);
  return ok(res, await replace(auth, entity, req.params.id, body.expected_file_id, file));
}));
router.delete('/', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), entity = entitySchema.parse(req.params.entity);
  await assertRecord(auth, entity, req.params.id, true);
  const body = z.object({ expected_file_id: z.string().max(200).nullable() }).strict().parse(req.body);
  return ok(res, await replace(auth, entity, req.params.id, body.expected_file_id));
}));
export { router as recordLogosRouter };
