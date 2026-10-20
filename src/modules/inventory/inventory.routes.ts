import { changeStock, stockEnabled, locationStocks, openingStock } from './stock.service.js';
import { financialTransaction } from '../accounting/transaction.js';
import { attributesFor, lockSetup } from '../business-setup/service.js';
import { attributeSchema } from '../business-setup/validation.js';
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();

const createItemSchema = z.object({
  location_id: z.string().min(1).optional(),
  attributes: attributeSchema,
  name: z.string().min(2).max(120),
  sku: z.string().min(1).max(64).optional(),
  category_id: z.string().min(1).optional(),
  unit: z.string().min(1).max(16).optional(),
  cost_price: z.number().int().min(0).default(0),
  sell_price: z.number().int().min(0).default(0),
  quantity: z.number().int().min(0).default(0),
  reorder_level: z.number().int().min(0).default(0),
  photo_file_id: z.string().optional()
});

const updateItemSchema = z.object({
  attributes: attributeSchema,
  name: z.string().min(2).max(120).optional(),
  sku: z.string().min(1).max(64).nullable().optional(),
  category_id: z.string().min(1).nullable().optional(),
  unit: z.string().min(1).max(16).optional(),
  cost_price: z.number().int().min(0).optional(),
  sell_price: z.number().int().min(0).optional(),
  reorder_level: z.number().int().min(0).optional(),
  photo_file_id: z.string().nullable().optional(),
  is_active: z.boolean().optional()
});

const listQuerySchema = z.object({
  category_id: z.string().optional(),
  search: z.string().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  low_stock: z.coerce.boolean().optional()
});

const adjustSchema = z.object({
  location_id: z.string().min(1).optional(),
  type: z.enum(["increase", "decrease"]),
  quantity: z.number().int().positive(),
  reason: z.string().min(3)
});

function withPhotoUrl<T extends { photoFileId: string | null }>(item: T) {
  return {
    ...item,
    photo_url: item.photoFileId ? `/v1/uploads/${item.photoFileId}/view` : null
  };
}

router.get("/items", requireProject, requireRoles("staff", "cashier"), validateQuery(listQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof listQuerySchema>;

  const rows = await prisma.inventoryItem.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.category_id ? { categoryId: query.category_id } : {}),
      ...(query.status ? { isActive: query.status === "active" } : {}),
      ...(query.search
        ? { OR: [{ name: { contains: query.search, mode: "insensitive" as const } }, { sku: { contains: query.search } }] }
        : {})
    },
    include: { category: true },
    orderBy: [{ isActive: "desc" }, { name: "asc" }]
  });

  const filtered = query.low_stock ? rows.filter((row) => row.quantity <= row.reorderLevel) : rows;
  const balances = await financialTransaction(db => locationStocks(db, auth, filtered));
  return ok(res, filtered.map(item => ({ ...withPhotoUrl(item), locationStocks: balances.get(item.id) })));
}));

router.get("/items/:id", requireProject, requireRoles("staff", "cashier"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const item = await prisma.inventoryItem.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { category: true }
  });
  if (!item) throw notFound("Item not found");

  return ok(res, withPhotoUrl(item));
}));

router.post("/items", requireProject, requireRoles("accountant", "admin"), validateBody(createItemSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createItemSchema>;

  if (body.category_id) {
    const category = await prisma.inventoryCategory.findFirst({
      where: { id: body.category_id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!category) throw notFound("Category not found");
  }

  if (body.sku) {
    const existing = await prisma.inventoryItem.findFirst({
      where: { projectId: auth.projectId, sku: body.sku }
    });
    if (existing) throw conflict("An item with this SKU already exists");
  }

  const item = await prisma.$transaction(async tx => { await lockSetup(tx, auth); const attributes = await attributesFor(tx, auth, 'item', body.attributes, undefined); const row = await tx.inventoryItem.create({
    data: {
      attributes,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      name: body.name,
      sku: body.sku,
      categoryId: body.category_id,
      unit: body.unit ?? "pcs",
      costPrice: body.cost_price,
      sellPrice: body.sell_price,
      quantity: body.quantity,
      reorderLevel: body.reorder_level,
      photoFileId: body.photo_file_id
    }
  });
    await openingStock(tx, auth, row, body.location_id);
    return row;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "inventory_item.created",
    entityType: "inventory_item",
    entityId: item.id,
    after: item
  });

  return created(res, withPhotoUrl(item));
}));

router.patch("/items/:id", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), validateBody(updateItemSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof updateItemSchema>;

  const before = await prisma.inventoryItem.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Item not found");

  if (body.category_id) {
    const category = await prisma.inventoryCategory.findFirst({
      where: { id: body.category_id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!category) throw notFound("Category not found");
  }

  if (body.sku && body.sku !== before.sku) {
    const clash = await prisma.inventoryItem.findFirst({
      where: { projectId: auth.projectId, sku: body.sku, NOT: { id } }
    });
    if (clash) throw conflict("An item with this SKU already exists");
  }

  const item = await prisma.$transaction(async tx => { await lockSetup(tx, auth); const current = await tx.inventoryItem.findFirstOrThrow({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } }); const attributes = await attributesFor(tx, auth, 'item', body.attributes, current.attributes); return tx.inventoryItem.update({
    where: { id },
    data: {
      attributes,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.sku !== undefined ? { sku: body.sku } : {}),
      ...(body.category_id !== undefined ? { categoryId: body.category_id } : {}),
      ...(body.unit !== undefined ? { unit: body.unit } : {}),
      ...(body.cost_price !== undefined ? { costPrice: body.cost_price } : {}),
      ...(body.sell_price !== undefined ? { sellPrice: body.sell_price } : {}),
      ...(body.reorder_level !== undefined ? { reorderLevel: body.reorder_level } : {}),
      ...(body.photo_file_id !== undefined ? { photoFileId: body.photo_file_id } : {}),
      ...(body.is_active !== undefined ? { isActive: body.is_active } : {})
    }
  }); });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "inventory_item.updated",
    entityType: "inventory_item",
    entityId: item.id,
    before,
    after: item
  });

  return ok(res, withPhotoUrl(item));
}));

router.delete("/items/:id", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const existing = await prisma.inventoryItem.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!existing) throw notFound("Item not found");

  const item = await prisma.inventoryItem.update({
    where: { id },
    data: { isActive: false }
  });
  return ok(res, item);
}));

router.post("/items/:id/adjust", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), validateBody(adjustSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof adjustSchema>;

  const before = await prisma.inventoryItem.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Item not found");

  const result = await financialTransaction(async tx => {
    if (!await stockEnabled(tx, auth)) throw badRequest('Stock management is disabled for this project');
    return changeStock(tx, auth, { itemId: id, delta: body.type === 'increase' ? body.quantity : -body.quantity, locationId: body.location_id, type: body.type === 'increase' ? 'adjustment_increase' : 'adjustment_decrease', referenceType: 'adjustment', reason: body.reason });
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "inventory_item.adjusted",
    entityType: "inventory_item",
    entityId: id,
    before,
    after: result.item
  });

  return ok(res, withPhotoUrl(result.item));
}));

router.get("/items/:id/movements", requireProject, requireRoles("staff"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const item = await prisma.inventoryItem.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!item) throw notFound("Item not found");

  const movements = await prisma.stockMovement.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, itemId: id },
    include: { location: true },
    orderBy: { createdAt: "desc" }
  });

  const details = await financialTransaction(async db => { const current = await db.inventoryItem.findFirstOrThrow({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } }); const balances = await locationStocks(db, auth, [current]); return { ...withPhotoUrl(current), locationStocks: balances.get(id) }; });
  return ok(res, { item: details, movements });
}));

export { router as inventoryRouter };
