import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { conflict, notFound } from '../../core/http/api-error.js';
import { ok, created } from '../../core/http/response.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { financialTransaction } from '../accounting/transaction.js';
import { locationStocks, stockEnabled, stockLocation } from './stock.service.js';
const router = Router();
router.use(requireProject, requireRoles('staff', 'cashier'));
const admin = requireRoles('admin');
const locationSchema = z.object({ name: z.string().trim().min(2).max(120), address: z.string().trim().max(500).nullable().optional() }).strict();
const scope = (auth: { tenantId: string; projectId: string }) => ({ tenantId: auth.tenantId, projectId: auth.projectId });
router.get('/settings', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const settings = await financialTransaction(async db => {
    const main = await stockLocation(db, auth);
    return { stock_management_enabled: await stockEnabled(db, auth), default_location_id: main.id, locations: await db.inventoryLocation.findMany({ where: scope(auth), orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }) };
  });
  return ok(res, settings);
}));
router.patch('/settings', admin, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), body = z.object({ stock_management_enabled: z.boolean() }).strict().parse(req.body);
  await financialTransaction(async db => {
    await db.project.update({ where: { id: auth.projectId, tenantId: auth.tenantId }, data: { stockManagementEnabled: body.stock_management_enabled } });
    await db.activity.create({ data: { ...scope(auth), actorUserId: auth.userId, action: 'inventory.settings.updated', entityType: 'project', entityId: auth.projectId, after: body } });
  });
  return ok(res, body);
}));
router.get('/locations', asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  return ok(res, await financialTransaction(async db => { await stockLocation(db, auth); return db.inventoryLocation.findMany({ where: scope(auth), orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] }); }));
}));
router.post('/locations', admin, asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), body = locationSchema.parse(req.body);
  const row = await financialTransaction(async db => {
    await stockLocation(db, auth);
    if (await db.inventoryLocation.findFirst({ where: { ...scope(auth), name: { equals: body.name, mode: 'insensitive' } } })) throw conflict('A location with this name already exists');
    const location = await db.inventoryLocation.create({ data: { ...scope(auth), ...body } });
    await db.activity.create({ data: { ...scope(auth), actorUserId: auth.userId, action: 'inventory.location.created', entityType: 'inventory_location', entityId: location.id, after: body } });
    return location;
  });
  return created(res, row);
}));
const updateLocation = asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req), body = locationSchema.extend({ is_active: z.boolean().optional() }).partial().strict().parse(req.body);
  const row = await financialTransaction(async db => {
    const before = await db.inventoryLocation.findFirst({ where: { ...scope(auth), id: req.params.id } });
    if (!before) throw notFound('Location not found');
    if (body.name && await db.inventoryLocation.findFirst({ where: { ...scope(auth), id: { not: before.id }, name: { equals: body.name, mode: 'insensitive' } } })) throw conflict('A location with this name already exists');
    if (body.is_active === false) {
      if (before.isDefault) throw conflict('The default location must remain active to hold opening stock');
      const items = await db.inventoryItem.findMany({ where: scope(auth) });
      const balances = await locationStocks(db, auth, items);
      if ([...balances.values()].some(rows => rows.some(row => row.locationId === before.id && row.quantity !== 0))) throw conflict('Move or adjust this location’s stock before deleting it');
      if (await db.purchase.count({ where: { ...scope(auth), stockLocationId: before.id, status: 'ordered' } })) throw conflict('Receive or cancel pending purchases before deleting this location');
    }
    const location = await db.inventoryLocation.update({ where: { id: before.id }, data: { name: body.name, address: body.address, isActive: body.is_active } });
    await db.activity.create({ data: { ...scope(auth), actorUserId: auth.userId, action: 'inventory.location.updated', entityType: 'inventory_location', entityId: before.id, after: body } });
    return location;
  });
  return ok(res, row);
});
router.patch('/locations/:id', admin, updateLocation);
// Deletion archives records so historic sales and stock movements keep their location.
router.delete('/locations/:id', admin, (req, res, next) => { req.body = { is_active: false }; updateLocation(req, res, next); });
export { router as stockRouter };
