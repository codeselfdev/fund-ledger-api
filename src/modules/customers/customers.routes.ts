import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { notFound } from '../../core/http/api-error.js';
import { ok, created } from '../../core/http/response.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody } from '../../core/validation/validate.js';
const router = Router();
export const customerSchema = z.object({ name: z.string().trim().min(2).max(120), mobile: z.string().trim().min(5).max(32).optional(), email: z.string().email().max(200).optional(), address: z.string().max(500).optional(), is_active: z.boolean().optional() }).strict();
router.use(requireProject, requireRoles('accountant', 'cashier', 'approver', 'auditor'));
router.get('/', asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    return ok(res, await prisma.customer.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId }, orderBy: { name: 'asc' } }));
}));
router.post('/', requireRoles('accountant', 'cashier', 'approver'), validateBody(customerSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), b = customerSchema.parse(req.body);
    return created(res, await prisma.customer.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, name: b.name, mobile: b.mobile, email: b.email, address: b.address } }));
}));
router.patch('/:id', requireRoles('accountant', 'cashier', 'approver'), validateBody(customerSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), b = customerSchema.parse(req.body);
    const where = { id: req.params.id, tenantId: auth.tenantId, projectId: auth.projectId };
    const updated = await prisma.customer.updateMany({ where, data: { name: b.name, mobile: b.mobile ?? null, email: b.email ?? null, address: b.address ?? null, isActive: b.is_active } });
    if (!updated.count)
        throw notFound('Customer not found');
    return ok(res, await prisma.customer.findFirst({ where }));
}));
export { router as customersRouter };
