import { financialTransaction } from '../accounting/transaction.js';
import { attributesFor, lockSetup } from '../business-setup/service.js';
import { attributeSchema } from '../business-setup/validation.js';
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
export const customerSchema = z.object({ attributes: attributeSchema, name: z.string().trim().min(2).max(120), mobile: z.string().trim().min(5).max(32).optional(), email: z.string().email().max(200).optional(), address: z.string().max(500).optional(), is_active: z.boolean().optional() }).strict();
router.use(requireProject, requireRoles('accountant', 'cashier', 'approver', 'auditor'));
router.get('/', asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    return ok(res, await prisma.customer.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId }, orderBy: { name: 'asc' } }));
}));
router.post('/', requireRoles('accountant', 'cashier', 'approver'), validateBody(customerSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), b = customerSchema.parse(req.body);
    return created(res, await financialTransaction(async tx => { await lockSetup(tx, auth); const attributes = await attributesFor(tx, auth, 'customer', b.attributes); return tx.customer.create({ data: { attributes, tenantId: auth.tenantId, projectId: auth.projectId, name: b.name, mobile: b.mobile, email: b.email, address: b.address, isActive: b.is_active } }); }));
}));
router.patch('/:id', requireRoles('accountant', 'cashier', 'approver'), validateBody(customerSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), b = customerSchema.parse(req.body);
    const where = { id: req.params.id, tenantId: auth.tenantId, projectId: auth.projectId };
    const saved = await financialTransaction(async tx => {
      await lockSetup(tx, auth);
      const before = await tx.customer.findFirst({ where });
      if (!before) throw notFound('Customer not found');
      const attributes = await attributesFor(tx, auth, 'customer', b.attributes, before.attributes);
      return tx.customer.update({ where: { id: before.id }, data: { name: b.name, mobile: b.mobile ?? null, email: b.email ?? null, address: b.address ?? null, isActive: b.is_active, attributes } });
    });
    return ok(res, saved);
}));
export { router as customersRouter };
