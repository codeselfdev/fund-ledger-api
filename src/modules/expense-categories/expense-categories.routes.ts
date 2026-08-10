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
  name: z.string().min(2).max(64)
});

const updateSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  is_active: z.boolean().optional()
});

router.get("/", requireProject, requireRoles("staff", "cashier"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const rows = await prisma.expenseCategoryDef.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }]
  });
  return ok(res, rows);
}));

router.post("/", requireProject, requireRoles("accountant", "admin"), validateBody(createSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof createSchema>;

  const existing = await prisma.expenseCategoryDef.findFirst({
    where: { projectId: auth.projectId, name: body.name }
  });
  if (existing) throw conflict("An expense category with this name already exists");

  const row = await prisma.expenseCategoryDef.create({
    data: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      name: body.name
    }
  });
  return created(res, row);
}));

router.patch("/:id", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), validateBody(updateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof updateSchema>;

  const existing = await prisma.expenseCategoryDef.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!existing) throw notFound("Category not found");

  if (body.name && body.name !== existing.name) {
    const clash = await prisma.expenseCategoryDef.findFirst({
      where: { projectId: auth.projectId, name: body.name, NOT: { id } }
    });
    if (clash) throw conflict("An expense category with this name already exists");
  }

  const row = await prisma.expenseCategoryDef.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.is_active !== undefined ? { isActive: body.is_active } : {})
    }
  });
  return ok(res, row);
}));

router.delete("/:id", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;

  const existing = await prisma.expenseCategoryDef.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!existing) throw notFound("Category not found");

  const row = await prisma.expenseCategoryDef.update({
    where: { id },
    data: { isActive: false }
  });
  return ok(res, row);
}));

export { router as expenseCategoriesRouter };
