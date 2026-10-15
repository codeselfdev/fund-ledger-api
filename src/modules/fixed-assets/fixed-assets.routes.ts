import { readObject, StorageObjectNotFoundError } from '../../core/storage/object-storage.service.js';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { validateBody } from '../../core/validation/validate.js';
import { created, ok } from '../../core/http/response.js';
import { conflict, notFound, badRequest } from '../../core/http/api-error.js';
import { atDate, json, today } from '../billing/billing.policy.js';
import { financialTransaction } from '../accounting/transaction.js';
import { purchaseSchema, maintenanceSchema, transferSchema, disposalSchema, metadataSchema, completedMonth, valuation, CATEGORIES } from './fixed-assets.policy.js';
import { scope, asset, purchase, maintenance, transfer, dispose, postProject, overview } from './fixed-assets.service.js';
import { exportAssets } from './fixed-assets.reports.js';
const router = Router();
router.use(requireProject, requireRoles('accountant', 'auditor'));
const write = requireRoles('accountant');
router.get('/overview', asyncHandler(async (req, res) => ok(res, await overview(requireProjectContext(req)))));
router.get('/categories', (_req, res) => ok(res, Object.entries(CATEGORIES).map(([key, value]) => ({ key, ...value }))));
router.post('/assets', write, validateBody(purchaseSchema), asyncHandler(async (req, res) => created(res, await purchase(requireProjectContext(req), purchaseSchema.parse(req.body)))));
router.get('/assets/:id', asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), row = await asset(prisma, a, req.params.id);
    const events = await prisma.fixedAssetEvent.findMany({ where: { tenantId: a.tenantId, assetId: row.id }, orderBy: { createdAt: 'desc' } });
    return ok(res, { ...row, ...valuation(row, completedMonth(today())), events });
}));
router.get('/assets/:id/invoice', asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), row = await asset(prisma, a, req.params.id);
    const upload = row.invoiceUploadId ? await prisma.upload.findFirst({ where: { id: row.invoiceUploadId, tenantId: a.tenantId } }) : null;
    if (!upload)
        throw notFound('Invoice not found');
    try {
        const file = await readObject(upload.storageKey);
        return ok(res, { filename: upload.fileName, base64: file.buffer.toString('base64'), mime_type: upload.mimeType });
    }
    catch (error) {
        if (error instanceof StorageObjectNotFoundError)
            throw notFound('Invoice file is missing from storage');
        throw error;
    }
}));
router.patch('/assets/:id', write, validateBody(metadataSchema), asyncHandler(async (req, res) => {
    const a = requireProjectContext(req), b = metadataSchema.parse(req.body);
    const result = await financialTransaction(async (tx) => {
        const row = await asset(tx, a, req.params.id, true);
        if (b.warranty_until && b.warranty_until < row.purchaseDate.toISOString().slice(0, 10))
            throw badRequest('Warranty expiry predates purchase');
        if (b.serial && await tx.fixedAsset.findFirst({ where: { tenantId: a.tenantId, serial: b.serial, id: { not: row.id } } }))
            throw conflict('Serial already exists');
        const updated = await tx.fixedAsset.update({ where: { id: row.id }, data: { serial: b.serial, warrantyUntil: b.warranty_until ? atDate(b.warranty_until) : null, nextServiceDate: b.next_service_date ? atDate(b.next_service_date) : null } });
        await tx.activity.create({ data: { ...scope(a), actorUserId: a.userId, action: 'fixed_asset.updated', entityType: 'fixed_asset', entityId: row.id, after: json(b) } });
        return updated;
    });
    return ok(res, result);
}));
router.post('/assets/:id/maintenance', write, validateBody(maintenanceSchema), asyncHandler(async (req, res) => created(res, await maintenance(requireProjectContext(req), req.params.id, maintenanceSchema.parse(req.body)))));
router.post('/assets/:id/transfer', write, validateBody(transferSchema), asyncHandler(async (req, res) => ok(res, await transfer(requireProjectContext(req), req.params.id, transferSchema.parse(req.body)))));
router.post('/assets/:id/dispose', write, validateBody(disposalSchema), asyncHandler(async (req, res) => ok(res, await dispose(requireProjectContext(req), req.params.id, disposalSchema.parse(req.body)))));
router.post('/depreciation/post', write, validateBody(z.object({}).strict()), asyncHandler(async (req, res) => ok(res, await postProject(requireProjectContext(req)))));
router.get('/journals', requireRoles('accountant'), asyncHandler(async (req, res) => ok(res, await prisma.fixedAssetJournal.findMany({ where: scope(requireProjectContext(req)), orderBy: { createdAt: 'desc' }, take: 1000 }))));
router.get('/reports/export', asyncHandler(async (req, res) => { const format = z.enum(['xlsx', 'pdf']).parse(req.query.format ?? 'xlsx'); return ok(res, await exportAssets(requireProjectContext(req), format)); }));
export { router as fixedAssetsRouter };
