import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { conflict, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";

const router = Router();

const createSchema = z.object({
  name: z.string().min(2).max(120),
  phone: z.string().min(6).max(32).optional(),
  email: z.string().email().optional(),
  address: z.string().max(255).optional(),
  notes: z.string().max(2000).optional()
});

const updateSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  phone: z.string().min(6).max(32).nullable().optional(),
  email: z.string().email().nullable().optional(),
  address: z.string().max(255).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  is_active: z.boolean().optional()
});

const listQuerySchema = z.object({
  search: z.string().optional(),
  status: z.enum(["active", "inactive"]).optional()
});

router.get("/", requireProject, requireRoles("staff", "cashier"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const q = listQuerySchema.parse(req.query);
  const rows = await prisma.vendor.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(q.status ? { isActive: q.status === "active" } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { phone: { contains: q.search } }] }
        : {})
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }]
  });
  return ok(res, rows);
}));

router.post("/", requireProject, requireRoles("accountant", "admin"), validateBody(createSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createSchema>;
  const existing = await prisma.vendor.findFirst({
    where: { projectId: auth.projectId, name: body.name }
  });
  if (existing) throw conflict("A vendor with this name already exists");

  const row = await prisma.vendor.create({
    data: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      name: body.name,
      phone: body.phone,
      email: body.email,
      address: body.address,
      notes: body.notes
    }
  });
  return created(res, row);
}));

router.patch("/:id", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), validateBody(updateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof updateSchema>;

  const existing = await prisma.vendor.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!existing) throw notFound("Vendor not found");

  if (body.name && body.name !== existing.name) {
    const clash = await prisma.vendor.findFirst({
      where: { projectId: auth.projectId, name: body.name, NOT: { id } }
    });
    if (clash) throw conflict("A vendor with this name already exists");
  }

  const row = await prisma.vendor.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.is_active !== undefined ? { isActive: body.is_active } : {})
    }
  });
  return ok(res, row);
}));

router.delete("/:id", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const existing = await prisma.vendor.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!existing) throw notFound("Vendor not found");

  // Soft delete: mark inactive so existing expense references stay intact.
  const row = await prisma.vendor.update({
    where: { id },
    data: { isActive: false }
  });
  return ok(res, row);
}));

export { router as vendorsRouter };
