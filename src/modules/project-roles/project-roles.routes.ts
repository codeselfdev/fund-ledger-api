import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { accessMenus, menuReadDependencies } from '../../core/security/menu-access.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { ok, created } from '../../core/http/response.js';
import { validateBody } from '../../core/validation/validate.js';
import { writeAudit } from '../../core/audit/audit.service.js';
const router = Router();
const permission = z.object({ read: z.boolean(), write: z.boolean() }).strict().refine(value => !value.write || value.read, 'Write requires Read');
const input = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(300).default(''), permissions: z.record(permission) }).strict();
const update = input.extend({ revision: z.number().int().positive() });
const revision = z.object({ revision: z.number().int().positive() }).strict();
router.use(requireProject, requireRoles('owner', 'admin'), (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
export function roleResponse(role: { id: string; name: string; description: string; permissions: unknown; revision: number; _count?: { memberships: number } }) {
  return { id: role.id, name: role.name, description: role.description, permissions: role.permissions, revision: role.revision, ...(role._count ? { assignments_count: role._count.memberships } : {}) };
}
async function validatePermissions(tenantId: string, projectId: string, permissions: z.infer<typeof input>['permissions']) {
  const project = await prisma.project.findFirst({ where: { id: projectId, tenantId, isActive: true } });
  if (!project) throw notFound('Project not found');
  const menus = accessMenus(project.projectType);
  if (!Object.entries(permissions).some(([, access]) => access.read)) throw badRequest('Select at least one readable menu');
  for (const [key, value] of Object.entries(permissions)) {
    if (value.read && (menuReadDependencies[key] ?? []).some(dependency => !permissions[dependency]?.read)) throw badRequest(`Allow Read on the records needed by ${key}`);
    const menu = menus.find(menu => menu.key === key);
    if (!menu || ('read_only' in menu && menu.read_only && value.write)) throw badRequest(`Invalid menu access: ${key}`);
  }
}
router.get('/', asyncHandler(async (req, res) => {
  const a = requireProjectContext(req);
  return ok(res, (await prisma.projectRole.findMany({ where: { tenantId: a.tenantId, projectId: a.projectId }, orderBy: { name: 'asc' }, include: { _count: { select: { memberships: { where: { isActive: true } } } } } })).map(roleResponse));
}));
router.post('/', validateBody(input), asyncHandler(async (req, res) => {
  const a = requireProjectContext(req), body = input.parse(req.body);
  await validatePermissions(a.tenantId, a.projectId, body.permissions);
  try {
    const role = await prisma.$transaction(async tx => {
      const row = await tx.projectRole.create({ data: { tenantId: a.tenantId, projectId: a.projectId, ...body, nameKey: body.name.toLocaleLowerCase('en-US') } });
      await writeAudit({ tenantId: a.tenantId, projectId: a.projectId, actorUserId: a.userId, action: 'project_role.created', entityType: 'project_role', entityId: row.id, after: row }, tx);
      return row;
    });
    return created(res, roleResponse(role));
  } catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A role with this name already exists'); throw e; }
}));
router.put('/:id', validateBody(update), asyncHandler(async (req, res) => {
  const a = requireProjectContext(req), { revision: expected, ...body } = update.parse(req.body);
  await validatePermissions(a.tenantId, a.projectId, body.permissions);
  try {
    const role = await prisma.$transaction(async tx => {
      const where = { id: req.params.id, tenantId: a.tenantId, projectId: a.projectId };
      const before = await tx.projectRole.findFirst({ where });
      if (!before) throw notFound('Custom role not found');
      const changed = await tx.projectRole.updateMany({ where: { ...where, revision: expected }, data: { ...body, nameKey: body.name.toLocaleLowerCase('en-US'), revision: { increment: 1 } } });
      if (!changed.count) throw conflict('This role changed. Close and reopen it before saving again.');
      const row = await tx.projectRole.findFirstOrThrow({ where });
      await writeAudit({ tenantId: a.tenantId, projectId: a.projectId, actorUserId: a.userId, action: 'project_role.updated', entityType: 'project_role', entityId: row.id, before, after: row }, tx);
      return row;
    });
    return ok(res, roleResponse(role));
  } catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A role with this name already exists'); throw e; }
}));
router.delete('/:id', validateBody(revision), asyncHandler(async (req, res) => {
  const a = requireProjectContext(req), expected = revision.parse(req.body).revision;
  await prisma.$transaction(async tx => {
    const where = { id: req.params.id, tenantId: a.tenantId, projectId: a.projectId };
    // Lock against concurrent assignment and edits before checking linked memberships.
    const locked = await tx.projectRole.updateMany({ where: { ...where, revision: expected }, data: { revision: { increment: 1 } } });
    if (!locked.count) throw conflict('This role changed or was deleted. Reload the role list.');
    const before = await tx.projectRole.findFirstOrThrow({ where });
    if (await tx.projectMembership.count({ where: { customRoleId: req.params.id, isActive: true } })) throw conflict('Remove this role from all people before deleting it');
    await tx.projectMembership.updateMany({ where: { customRoleId: req.params.id, isActive: false }, data: { customRoleId: null } });
    await tx.projectRole.deleteMany({ where });
    await writeAudit({ tenantId: a.tenantId, projectId: a.projectId, actorUserId: a.userId, action: 'project_role.deleted', entityType: 'project_role', entityId: req.params.id, before }, tx);
  });
  return ok(res, { deleted: true });
}));
export { router as projectRolesRouter };
