import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { created, ok } from '../../core/http/response.js';
import { prisma } from '../../core/prisma/client.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { validateBody, validateQuery } from '../../core/validation/validate.js';
import { financialTransaction } from '../accounting/transaction.js';
import { dateSchema, pastDateSchema } from '../accounting/workflow.js';
const router = Router();
const incomeSchema = z.object({ account_id: z.string().min(1), amount: z.number().int().positive().max(2147483647), source: z.string().trim().min(1).max(120).optional(), note: z.string().max(500).optional(), income_date: pastDateSchema.optional(), request_key: z.string().uuid().optional(), category_id: z.string().min(1).optional(), customer_id: z.string().min(1).optional() });
const filters = z.object({ category_id: z.string().optional(), customer_id: z.string().optional(), from: dateSchema.optional(), to: dateSchema.optional(), offset: z.coerce.number().int().min(0).default(0) }).refine(v => !v.from || !v.to || v.from <= v.to, 'From date must be on or before To date');
const incomeTagsSchema = z.object({ category_id: z.string().trim().min(1).nullable() }).strict();
const categorySchema = z.object({ name: z.string().trim().min(2).max(120), is_active: z.boolean().optional() }).strict();
async function canRecord(tenantId: string, roles: string[]) {
    const p = await prisma.onboardingProgress.findUnique({ where: { tenantId }, select: { incomeApprovalFlow: true } });
    const flow = p?.incomeApprovalFlow ?? 'accountant_only';
    return roles.includes('admin') || roles.includes('owner') || roles.includes(flow === 'accountant_only' ? 'accountant' : 'approver');
}
const include = { account: { select: { name: true } }, incomeCategory: { select: { name: true } }, incomeCustomer: { select: { name: true } } };
type IncomeRow = Prisma.AccountTransactionGetPayload<{
    include: typeof include;
}>;
const mapIncome = (t: IncomeRow) => ({ id: t.id, account_id: t.accountId, account_name: t.account.name, amount: t.amount, source: t.incomeSource ?? t.description ?? 'Income', description: t.description, income_date: (t.occurredOn ?? t.createdAt).toISOString().slice(0, 10), created_at: t.createdAt, balance_after: t.balanceAfter, category_id: t.incomeCategoryId, category_name: t.incomeCategory?.name ?? null, customer_id: t.incomeCustomerId, customer_name: t.incomeCustomer?.name ?? null });
function filterWhere(auth: ReturnType<typeof requireProjectContext>, q: z.infer<typeof filters>): Prisma.AccountTransactionWhereInput {
    const where: Prisma.AccountTransactionWhereInput = { tenantId: auth.tenantId, projectId: auth.projectId, referenceType: 'income', direction: 'money_in', reversedAt: null, incomeCategoryId: q.category_id === 'none' ? null : q.category_id, incomeCustomerId: q.customer_id === 'none' ? null : q.customer_id };
    if (q.from || q.to) {
        const nextDay = (v: string) => new Date(new Date(`${v}T00:00:00Z`).getTime() + 86400000);
        where.OR = [{ occurredOn: { gte: q.from ? new Date(`${q.from}T00:00:00Z`) : undefined, lt: q.to ? nextDay(q.to) : undefined } }, { occurredOn: null, createdAt: { gte: q.from ? new Date(`${q.from}T00:00:00Z`) : undefined, lt: q.to ? nextDay(q.to) : undefined } }];
    }
    return where;
}
router.use(requireProject);
router.get('/categories', requireRoles('any'), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req);
    return ok(res, await prisma.incomeCategory.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId }, orderBy: { name: 'asc' } }));
}));
router.post('/categories', requireRoles('accountant', 'approver'), validateBody(categorySchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), b = categorySchema.parse(req.body);
    const old = await prisma.incomeCategory.findFirst({ where: { tenantId: auth.tenantId, projectId: auth.projectId, name: { equals: b.name, mode: 'insensitive' } } });
    if (old)
        throw conflict('This income category already exists');
    return created(res, await prisma.incomeCategory.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, name: b.name } }));
}));
router.patch('/categories/:id', requireRoles('accountant', 'approver'), validateBody(categorySchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), b = categorySchema.parse(req.body), where = { id: req.params.id, tenantId: auth.tenantId, projectId: auth.projectId };
    const result = await prisma.incomeCategory.updateMany({ where, data: { name: b.name, isActive: b.is_active } });
    if (!result.count)
        throw notFound('Income category not found');
    return ok(res, await prisma.incomeCategory.findFirst({ where }));
}));
router.get('/report', requireRoles('any'), validateQuery(filters), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), where = filterWhere(auth, filters.parse(req.query));
    const [total, categoryGroups, customerGroups] = await Promise.all([
        prisma.accountTransaction.aggregate({ where, _sum: { amount: true }, _count: true }),
        prisma.accountTransaction.groupBy({ where, by: ['incomeCategoryId'], _sum: { amount: true }, _count: true }),
        prisma.accountTransaction.groupBy({ where, by: ['incomeCustomerId'], _sum: { amount: true }, _count: true })
    ]);
    const [categories, customers] = await Promise.all([prisma.incomeCategory.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId }, select: { id: true, name: true } }), prisma.customer.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId }, select: { id: true, name: true } })]);
    return ok(res, { total_amount: total._sum.amount ?? 0, entry_count: total._count, by_category: categoryGroups.map(g => ({ id: g.incomeCategoryId, name: categories.find(c => c.id === g.incomeCategoryId)?.name ?? 'Uncategorised', amount: g._sum.amount ?? 0, count: g._count })).sort((a, b) => b.amount - a.amount), by_customer: customerGroups.map(g => ({ id: g.incomeCustomerId, name: customers.find(c => c.id === g.incomeCustomerId)?.name ?? 'No customer tag', amount: g._sum.amount ?? 0, count: g._count })).sort((a, b) => b.amount - a.amount) });
}));
router.get('/', requireRoles('any'), validateQuery(filters), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), q = filters.parse(req.query);
    const rows = await prisma.accountTransaction.findMany({ where: filterWhere(auth, q), include, orderBy: { createdAt: 'desc' }, take: 51, skip: q.offset });
    return ok(res, { entries: rows.slice(0, 50).map(mapIncome), next_offset: rows.length > 50 ? q.offset + 50 : null, can_record: await canRecord(auth.tenantId, auth.roles) });
}));
router.post('/', requireRoles('accountant', 'approver', 'admin'), validateBody(incomeSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), b = incomeSchema.parse(req.body);
    if (!await canRecord(auth.tenantId, auth.roles))
        throw forbidden('Your project income approval flow does not allow this role to record income');
    const result = await financialTransaction(async (tx) => {
        if (b.request_key) {
            const old = await tx.accountTransaction.findFirst({ where: { tenantId: auth.tenantId, projectId: auth.projectId, requestKey: b.request_key }, include });
            if (old) {
                if (old.referenceType !== 'income' || old.amount !== b.amount || old.accountId !== b.account_id || old.incomeSource !== (b.source ?? null) || old.incomeCategoryId !== (b.category_id ?? null) || old.incomeCustomerId !== (b.customer_id ?? null) || old.description !== (b.note ?? b.source ?? 'Manual income entry') || b.income_date && old.occurredOn?.toISOString().slice(0, 10) !== b.income_date)
                    throw conflict('Request key already used for a different income');
                return old;
            }
        }
        const account = await tx.account.findFirst({ where: { id: b.account_id, tenantId: auth.tenantId, projectId: auth.projectId } });
        if (!account)
            throw notFound('Account not found');
        if (b.category_id && !await tx.incomeCategory.findFirst({ where: { id: b.category_id, tenantId: auth.tenantId, projectId: auth.projectId, isActive: true } }))
            throw notFound('Active income category not found');
        if (b.customer_id && !await tx.customer.findFirst({ where: { id: b.customer_id, tenantId: auth.tenantId, projectId: auth.projectId, isActive: true } }))
            throw notFound('Active customer not found');
        if (account.balance > 2147483647 - b.amount)
            throw badRequest('Account balance would exceed the supported amount');
        const updated = await tx.account.update({ where: { id: account.id }, data: { balance: { increment: b.amount } } });
        const transaction = await tx.accountTransaction.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, accountId: account.id, direction: 'money_in', amount: b.amount, referenceType: 'income', referenceId: account.id, incomeSource: b.source, incomeCategoryId: b.category_id, incomeCustomerId: b.customer_id, occurredOn: new Date(`${b.income_date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })}T00:00:00Z`), requestKey: b.request_key, description: b.note ?? b.source ?? 'Manual income entry', balanceAfter: updated.balance, createdById: auth.userId }, include });
        await tx.activity.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: 'income.recorded', entityType: 'account_transaction', entityId: transaction.id, after: { account_id: account.id, amount: b.amount, balance_after: updated.balance, category_id: b.category_id ?? null, customer_id: b.customer_id ?? null } } });
        return transaction;
    });
    return created(res, mapIncome(result));
}));
// Reporting tags can change without changing the financial transaction or balance.
router.patch('/:id/tags', requireRoles('accountant', 'approver', 'admin'), validateBody(incomeTagsSchema), asyncHandler(async (req, res) => {
    const auth = requireProjectContext(req), b = incomeTagsSchema.parse(req.body);
    if (!await canRecord(auth.tenantId, auth.roles))
        throw forbidden('Your project income approval flow does not allow this role to tag income');
    const result = await financialTransaction(async (tx) => {
        const where = { id: req.params.id, tenantId: auth.tenantId, projectId: auth.projectId, referenceType: 'income', direction: 'money_in', reversedAt: null } satisfies Prisma.AccountTransactionWhereUniqueInput;
        const old = await tx.accountTransaction.findFirst({ where, include });
        if (!old)
            throw notFound('Income entry not found');
        if (b.category_id && !await tx.incomeCategory.findFirst({ where: { id: b.category_id, tenantId: auth.tenantId, projectId: auth.projectId, isActive: true } }))
            throw notFound('Active income category not found');
        if (old.incomeCategoryId === b.category_id)
            return old;
        const updated = await tx.accountTransaction.update({ where: { ...where, id: old.id }, data: { incomeCategoryId: b.category_id }, include });
        await tx.activity.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: 'income.tagged', entityType: 'account_transaction', entityId: old.id, before: { category_id: old.incomeCategoryId }, after: { category_id: b.category_id } } });
        return updated;
    });
    return ok(res, mapIncome(result));
}));
export { router as incomesRouter };
