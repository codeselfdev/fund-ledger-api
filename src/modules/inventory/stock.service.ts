import type { Prisma, StockMovementType } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
type Db = Prisma.TransactionClient;
export type StockScope = { tenantId: string; projectId: string; userId?: string };
const scope = (auth: StockScope) => ({ tenantId: auth.tenantId, projectId: auth.projectId });
export async function stockEnabled(db: Db, auth: StockScope) {
  const project = await db.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId } });
  if (!project) throw notFound('Project not found');
  return project.stockManagementEnabled !== false;
}
export async function stockLocation(db: Db, auth: StockScope, id?: string | null, allowArchived = false) {
  if (id) {
    const row = await db.inventoryLocation.findFirst({ where: { id, ...scope(auth), ...(allowArchived ? {} : { isActive: true }) } });
    if (!row) throw notFound('Active inventory location not found');
    return row;
  }
  const existing = await db.inventoryLocation.findFirst({ where: { ...scope(auth), isDefault: true } });
  return existing ?? db.inventoryLocation.create({ data: { ...scope(auth), name: 'Main store', isDefault: true } });
}
/** Legacy and imported opening quantities belong to Main store. Other locations
 * have signed movements, so their balances never consume another store's stock. */
export async function locationStocks(db: Db, auth: StockScope, items: { id: string; quantity: number }[]) {
  const main = await stockLocation(db, auth);
  const locations = await db.inventoryLocation.findMany({ where: scope(auth), orderBy: { createdAt: 'asc' } });
  const groups = items.length ? await db.stockMovement.groupBy({ by: ['itemId', 'locationId'], where: { ...scope(auth), itemId: { in: items.map(item => item.id) }, locationId: { not: null } }, _sum: { quantity: true } }) : [];
  return new Map(items.map(item => {
    const other = groups.filter(group => group.itemId === item.id && group.locationId !== main.id);
    const balances = locations.map(location => ({ locationId: location.id, locationName: location.name, isActive: location.isActive, quantity: location.id === main.id ? item.quantity - other.reduce((sum, row) => sum + (row._sum.quantity ?? 0), 0) : other.find(row => row.locationId === location.id)?._sum.quantity ?? 0 }));
    return [item.id, balances];
  }));
}
export async function changeStock(db: Db, auth: StockScope, input: { itemId: string; delta: number; locationId?: string | null; type: StockMovementType; referenceType: string; referenceId?: string; reason?: string; restoring?: boolean }) {
  const location = await stockLocation(db, auth, input.locationId, input.restoring);
  const item = await db.inventoryItem.findFirst({ where: { id: input.itemId, ...scope(auth) } });
  if (!item) throw notFound('Inventory item not found');
  if (!Number.isSafeInteger(input.delta) || !input.delta || Math.abs(input.delta) > 2147483647) throw badRequest('Use a non-zero whole stock quantity');
  if (input.delta < 0) {
    const balances = await locationStocks(db, auth, [item]);
    const available = balances.get(item.id)?.find(row => row.locationId === location.id)?.quantity ?? 0;
    if (available < -input.delta) throw conflict(`Insufficient stock for ${item.name} at ${location.name}`, { available, location_id: location.id });
  }
  const changed = await db.inventoryItem.updateMany({ where: { id: item.id, ...scope(auth), ...(input.delta < 0 ? { quantity: { gte: -input.delta } } : {}) }, data: { quantity: { increment: input.delta } } });
  if (!changed.count) throw conflict(`Insufficient stock for ${item.name}`);
  const updated = await db.inventoryItem.findFirstOrThrow({ where: { id: item.id, ...scope(auth) } });
  const movement = await db.stockMovement.create({ data: { ...scope(auth), itemId: item.id, locationId: location.id, type: input.type, quantity: input.delta, quantityAfter: updated.quantity, referenceType: input.referenceType, referenceId: input.referenceId, reason: input.reason, createdById: auth.userId } });
  return { item: updated, movement, locationId: location.id };
}
export async function openingStock(db: Db, auth: StockScope, item: { id: string; quantity: number }, locationId?: string | null) {
  if (!item.quantity) return;
  if (!await stockEnabled(db, auth)) throw badRequest('Enable stock management before setting opening quantities');
  const location = await stockLocation(db, auth, locationId);
  await db.stockMovement.create({ data: { ...scope(auth), itemId: item.id, locationId: location.id, type: 'adjustment_increase', quantity: item.quantity, quantityAfter: item.quantity, referenceType: 'opening_stock', referenceId: item.id, reason: 'Opening stock', createdById: auth.userId } });
}
