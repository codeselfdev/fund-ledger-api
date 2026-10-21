import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { requireProject, requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { created, ok } from '../../core/http/response.js';
import { validateBody } from '../../core/validation/validate.js';
import { atDate, hash, json } from '../billing/billing.policy.js';
import { settingsSchema, headSchema, boqSchema, allocationSchema, contractorSchema, contractSchema, runningSchema, supplierSchema, laborSchema, materialSchema, paymentSchema, changeSchema, decisionSchema, estimated, runningBill, money } from './construction.policy.js';
import { audit, head, boq, scope, sameRequest, financialTransaction, decide, pay, moveMaterial, receiveSupplierPurchase } from './construction.service.js';
import { constructionReport } from './construction.reports.js';
import { constructionMenus } from './construction.menu.js';
import { vendorsRouter } from '../vendors/vendors.routes.js';
import { siteRouter } from './construction.site.routes.js';
const router = Router();
const write = requireRoles('accountant');
router.use(requireProject, requireRoles('accountant', 'approver', 'auditor', 'cashier'), asyncHandler(async (req, _res, next) => {
    const a = requireProjectContext(req);
    const p = await prisma.project.findFirst({ where: { id: a.projectId, tenantId: a.tenantId, isActive: true } });
    if (!p || p.projectType !== 'construction')
        throw forbidden('This feature belongs to Construction Financial Management projects');
    next();
}));
router.use(siteRouter);
router.get('/configuration', asyncHandler(async (req, res) => { const a = requireProjectContext(req); const p = await prisma.project.findFirstOrThrow({ where: { id: a.projectId, tenantId: a.tenantId } }); return ok(res, { settings: { ...(p.constructionSettings as object ?? { building: p.name, site: p.address ?? '', financial_target: 0 }), total_shares: p.totalShares }, menus: constructionMenus(a.roles) }); }));
router.put('/configuration', requireRoles('admin'), validateBody(settingsSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = settingsSchema.parse(req.body); await financialTransaction(async (tx) => { if (b.total_shares !== undefined) {
    const shares = await tx.member.aggregate({ where: { ...scope(a), status: 'active' }, _sum: { shares: true } });
    if (b.total_shares < (shares._sum.shares ?? 0))
        throw badRequest('Total shares cannot be below active assigned shares');
} await tx.project.update({ where: { id: a.projectId }, data: { name: b.building, address: b.site, totalShares: b.total_shares, constructionSettings: json(b) } }); await audit(tx, a, 'settings.updated', 'project', a.projectId, b); }); return ok(res, b); }));
router.get('/overview', asyncHandler(async (req, res) => ok(res, await constructionReport(requireProjectContext(req)))));
router.get('/cost-heads', asyncHandler(async (req, res) => ok(res, await prisma.constructionCostHead.findMany({ where: scope(requireProjectContext(req)), orderBy: [{ phase: 'asc' }, { name: 'asc' }] }))));
router.post('/cost-heads', write, validateBody(headSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = headSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const row = await tx.constructionCostHead.create({ data: { ...scope(a), name: b.name, phase: b.phase, category: b.category, budget: b.budget, revisedBudget: b.budget, forecastRemaining: b.forecast_remaining, createdById: a.userId } }); await audit(tx, a, 'budget.requested', 'construction_cost_head', row.id, row); return row; }); return created(res, row); }));
router.patch('/cost-heads/:id/forecast', write, validateBody(z.object({ forecast_remaining: money }).strict()), asyncHandler(async (req, res) => { const a = requireProjectContext(req); const row = await financialTransaction(async (tx) => { const h = await head(tx, a, req.params.id); const row = await tx.constructionCostHead.update({ where: { id: h.id }, data: { forecastRemaining: req.body.forecast_remaining } }); await audit(tx, a, 'forecast.updated', 'construction_cost_head', h.id, row); return row; }); return ok(res, row); }));
router.get('/boq', asyncHandler(async (req, res) => { const a = requireProjectContext(req); const rows = await prisma.constructionBoq.findMany({ where: scope(a), include: { costHead: true }, orderBy: { createdAt: 'desc' } }); return ok(res, rows.map(row => ({ ...row, quantity: Number(row.quantity) }))); }));
router.post('/boq', write, validateBody(boqSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = boqSchema.parse(req.body); const row = await financialTransaction(async (tx) => { await head(tx, a, b.cost_head_id); const row = await tx.constructionBoq.create({ data: { ...scope(a), costHeadId: b.cost_head_id, name: b.name, unit: b.unit, quantity: b.quantity, rate: b.rate, estimated: estimated(b.quantity, b.rate), isActive: b.is_active } }); await audit(tx, a, 'boq.created', 'construction_boq', row.id, row); return row; }); return created(res, { ...row, quantity: Number(row.quantity) }); }));
router.patch('/boq/:id', write, validateBody(boqSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = boqSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const old = await boq(tx, a, req.params.id); await head(tx, a, b.cost_head_id); if (old.costHeadId !== b.cost_head_id)
    throw conflict('Create a new BOQ item to change its cost head'); const row = await tx.constructionBoq.update({ where: { id: old.id }, data: { name: b.name, unit: b.unit, quantity: b.quantity, rate: b.rate, estimated: estimated(b.quantity, b.rate), isActive: b.is_active } }); await audit(tx, a, 'boq.updated', 'construction_boq', row.id, { before: old, after: row }); return row; }); return ok(res, { ...row, quantity: Number(row.quantity) }); }));
router.get('/allocations', asyncHandler(async (req, res) => ok(res, await prisma.constructionCostAllocation.findMany({ where: scope(requireProjectContext(req)), include: { expense: true, boq: true } }))));
router.post('/allocations', write, validateBody(allocationSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = allocationSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const old = await tx.constructionCostAllocation.findFirst({ where: { ...scope(a), requestKey: b.request_key } }); if (old) {
    sameRequest(old, b);
    return old;
} await head(tx, a, b.cost_head_id); if (b.boq_id)
    await boq(tx, a, b.boq_id, b.cost_head_id); const expense = await tx.expense.findFirst({ where: { id: b.expense_id, ...scope(a), status: { in: ['approved', 'paid'] } } }); if (!expense)
    throw notFound('Approved or paid expense not found'); const allocated = await tx.constructionCostAllocation.aggregate({ where: { ...scope(a), expenseId: expense.id }, _sum: { amount: true } }); if ((allocated._sum.amount ?? 0) + b.amount > expense.amount)
    throw conflict('Allocations exceed the expense amount'); const row = await tx.constructionCostAllocation.create({ data: { ...scope(a), expenseId: expense.id, costHeadId: b.cost_head_id, boqId: b.boq_id, amount: b.amount, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } }); await audit(tx, a, 'expense.allocated', 'construction_cost_allocation', row.id, row); return row; }); return created(res, row); }));
router.get('/contractors', asyncHandler(async (req, res) => ok(res, await prisma.constructionContractor.findMany({ where: scope(requireProjectContext(req)), orderBy: { name: 'asc' } }))));
router.post('/contractors', write, validateBody(contractorSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = contractorSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const row = await tx.constructionContractor.create({ data: { ...scope(a), name: b.name, mobile: b.mobile, email: b.email, address: b.address, isActive: b.is_active } }); await audit(tx, a, 'contractor.created', 'construction_contractor', row.id, row); return row; }); return created(res, row); }));
router.patch('/contractors/:id', write, validateBody(contractorSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = contractorSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const old = await tx.constructionContractor.findFirst({ where: { id: req.params.id, ...scope(a) } }); if (!old)
    throw notFound('Contractor not found'); const row = await tx.constructionContractor.update({ where: { id: old.id }, data: { name: b.name, mobile: b.mobile ?? null, email: b.email ?? null, address: b.address ?? null, isActive: b.is_active } }); await audit(tx, a, 'contractor.updated', 'construction_contractor', row.id, row); return row; }); return ok(res, row); }));
router.get('/contracts', asyncHandler(async (req, res) => ok(res, await prisma.constructionContract.findMany({ where: scope(requireProjectContext(req)), include: { contractor: true, costHead: true }, orderBy: { createdAt: 'desc' } }))));
router.post('/contracts', write, validateBody(contractSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = contractSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const old = await tx.constructionContract.findFirst({ where: { ...scope(a), requestKey: b.request_key } }); if (old) {
    sameRequest(old, b);
    return old;
} await head(tx, a, b.cost_head_id); if (!await tx.constructionContractor.findFirst({ where: { id: b.contractor_id, ...scope(a), isActive: true } }))
    throw notFound('Active contractor not found'); const row = await tx.constructionContract.create({ data: { ...scope(a), contractorId: b.contractor_id, costHeadId: b.cost_head_id, title: b.title, amount: b.amount, revisedAmount: b.amount, retentionBps: b.retention_bps, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } }); await audit(tx, a, 'contract.created', 'construction_contract', row.id, row); return row; }); return created(res, row); }));
router.patch('/contracts/:id/status', requireRoles('admin'), validateBody(z.object({ status: z.enum(['active', 'suspended', 'closed']) }).strict()), asyncHandler(async (req, res) => { const a = requireProjectContext(req); const row = await financialTransaction(async (tx) => { const old = await tx.constructionContract.findFirst({ where: { id: req.params.id, ...scope(a) } }); if (!old)
    throw notFound('Contract not found'); if (req.body.status === 'closed' && (old.certifiedAmount !== old.revisedAmount || old.advancePaid !== old.advanceRecovered))
    throw conflict('Fully certify work and recover advances before closing the contract'); const row = await tx.constructionContract.update({ where: { id: old.id }, data: { status: req.body.status } }); await audit(tx, a, 'contract.status_changed', 'construction_contract', row.id, row); return row; }); return ok(res, row); }));
router.get('/running-bills', asyncHandler(async (req, res) => ok(res, await prisma.constructionRunningBill.findMany({ where: scope(requireProjectContext(req)), include: { contract: { include: { contractor: true } } }, orderBy: { createdAt: 'desc' } }))));
router.post('/running-bills', write, validateBody(runningSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = runningSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const old = await tx.constructionRunningBill.findFirst({ where: { ...scope(a), requestKey: b.request_key } }); if (old) {
    sameRequest(old, b);
    return old;
} const c = await tx.constructionContract.findFirst({ where: { id: b.contract_id, ...scope(a), status: 'active' } }); if (!c)
    throw notFound('Active contract not found'); const totals = runningBill(c, b.cumulative_certified, b.advance_recovery);
 const wasteIds = [...new Set(b.waste_entry_ids ?? [])], waste = await tx.constructionMaterialEntry.findMany({ where: { ...scope(a), id: { in: wasteIds }, kind: 'waste', chargeContractId: c.id, chargeBillId: null } });
 if (waste.length !== wasteIds.length) throw conflict('Wastage was already assigned to another bill or does not belong to this contract');
 const deduction = waste.reduce((n,e) => n + e.quantity * (e.unitRate ?? 0), 0);
 if (deduction > totals.netPayable) throw badRequest('Wastage deductions exceed the current payable');
 totals.netPayable -= deduction;
 const row = await tx.constructionRunningBill.create({ data: { ...scope(a), contractId: c.id, cumulativeCertified: b.cumulative_certified, ...totals, wastageDeduction: deduction, wasteEntryIds: wasteIds, billDate: atDate(b.bill_date), note: b.note, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } }); await tx.constructionMaterialEntry.updateMany({ where: { ...scope(a), id: { in: wasteIds }, chargeBillId: null }, data: { chargeBillId: row.id } }); await audit(tx, a, 'running_bill.requested', 'construction_running_bill', row.id, row); return row; }); return created(res, row); }));
router.use('/suppliers', vendorsRouter);
router.get('/supplier-bills', asyncHandler(async (req, res) => ok(res, await prisma.constructionSupplierBill.findMany({ where: scope(requireProjectContext(req)), include: { vendor: true, costHead: true, boq: true }, orderBy: { createdAt: 'desc' } }))));
router.post('/supplier-bills', write, validateBody(supplierSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = supplierSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const old = await tx.constructionSupplierBill.findFirst({ where: { ...scope(a), requestKey: b.request_key } }); if (old) {
    sameRequest(old, b);
    return old;
} await head(tx, a, b.cost_head_id); if (b.boq_id)
    await boq(tx, a, b.boq_id, b.cost_head_id); if (!await tx.vendor.findFirst({ where: { id: b.vendor_id, ...scope(a), isActive: true } }))
    throw notFound('Active supplier not found'); if (b.purchase_id) {
    const purchase = await tx.purchase.findFirst({ where: { id: b.purchase_id, ...scope(a), status: 'ordered', vendorId: b.vendor_id } });
    if (!purchase)
        throw notFound('Ordered supplier purchase not found');
    if (purchase.totalAmount !== b.amount)
        throw badRequest('Bill amount must match the linked purchase');
} const row = await tx.constructionSupplierBill.create({ data: { ...scope(a), vendorId: b.vendor_id, costHeadId: b.cost_head_id, boqId: b.boq_id, purchaseId: b.purchase_id, number: b.number, description: b.description, amount: b.amount, billDate: atDate(b.bill_date), requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } }); await audit(tx, a, 'supplier_bill.requested', 'construction_supplier_bill', row.id, row); return row; }); return created(res, row); }));
router.post('/supplier-bills/:id/receive', write, asyncHandler(async (req, res) => { const a = requireProjectContext(req); return ok(res, await financialTransaction(tx => receiveSupplierPurchase(tx, a, req.params.id))); }));
router.get('/labor', asyncHandler(async (req, res) => { const rows = await prisma.constructionLaborEntry.findMany({ where: scope(requireProjectContext(req)), orderBy: { workDate: 'desc' } }); return ok(res, rows.map(r => ({ ...r, units: Number(r.units) }))); }));
router.post('/labor', write, validateBody(laborSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = laborSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const old = await tx.constructionLaborEntry.findFirst({ where: { ...scope(a), requestKey: b.request_key } }); if (old) {
    sameRequest(old, b);
    return old;
} await head(tx, a, b.cost_head_id); const row = await tx.constructionLaborEntry.create({ data: { ...scope(a), costHeadId: b.cost_head_id, workerName: b.worker_name, workDate: atDate(b.work_date), units: b.units, rate: b.rate, amount: estimated(b.units, b.rate), note: b.note, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } }); await audit(tx, a, 'labor.requested', 'construction_labor_entry', row.id, row); return row; }); return created(res, { ...row, units: Number(row.units) }); }));
router.get('/materials', asyncHandler(async (req, res) => ok(res, await prisma.constructionMaterialEntry.findMany({ where: scope(requireProjectContext(req)), include: { item: true, boq: true }, orderBy: { entryDate: 'desc' } }))));
router.post('/materials', write, validateBody(materialSchema), asyncHandler(async (req, res) => created(res, await moveMaterial(requireProjectContext(req), materialSchema.parse(req.body)))));
router.get('/payments', asyncHandler(async (req, res) => ok(res, await prisma.constructionPayment.findMany({ where: scope(requireProjectContext(req)), orderBy: { paymentDate: 'desc' } }))));
router.post('/payments', write, validateBody(paymentSchema), asyncHandler(async (req, res) => created(res, await pay(requireProjectContext(req), paymentSchema.parse(req.body)))));
router.get('/change-orders', asyncHandler(async (req, res) => ok(res, await prisma.constructionChangeOrder.findMany({ where: scope(requireProjectContext(req)), orderBy: { createdAt: 'desc' } }))));
router.post('/change-orders', write, validateBody(changeSchema), asyncHandler(async (req, res) => { const a = requireProjectContext(req), b = changeSchema.parse(req.body); const row = await financialTransaction(async (tx) => { const old = await tx.constructionChangeOrder.findFirst({ where: { ...scope(a), requestKey: b.request_key } }); if (old) {
    sameRequest(old, b);
    return old;
} if (b.cost_head_id)
    await head(tx, a, b.cost_head_id); if (b.contract_id && !await tx.constructionContract.findFirst({ where: { id: b.contract_id, ...scope(a), status: 'active' } }))
    throw notFound('Active contract not found'); const row = await tx.constructionChangeOrder.create({ data: { ...scope(a), costHeadId: b.cost_head_id, contractId: b.contract_id, budgetChange: b.budget_change, contractChange: b.contract_change, reason: b.reason, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } }); await audit(tx, a, 'change_order.requested', 'construction_change_order', row.id, row); return row; }); return created(res, row); }));
for (const [path, kind] of [['cost-heads', 'budget'], ['running-bills', 'running_bill'], ['supplier-bills', 'supplier_bill'], ['labor', 'labor'], ['change-orders', 'change_order']] as const)
    router.post(`/${path}/:id/decision`, requireRoles('approver'), validateBody(decisionSchema), asyncHandler(async (req, res) => ok(res, await decide(requireProjectContext(req), kind, req.params.id, decisionSchema.parse(req.body).decision))));
router.get('/funding', asyncHandler(async (req, res) => { const a = requireProjectContext(req); const [members, dues, deposits, schedules] = await Promise.all([prisma.member.findMany({ where: scope(a), select: { id: true, name: true, shares: true, status: true } }), prisma.due.findMany({ where: scope(a) }), prisma.deposit.findMany({ where: { ...scope(a), status: 'confirmed' } }), prisma.schedule.findMany({ where: scope(a), orderBy: { createdAt: 'desc' } })]); return ok(res, { members: members.map(m => ({ ...m, contributed: deposits.filter(d => d.memberId === m.id).reduce((n, d) => n + d.amount - d.refundedAmount, 0), outstanding: dues.filter(d => d.memberId === m.id).reduce((n, d) => n + Math.max(0, d.amount - d.paidAmount - d.waivedAmount) + Math.max(0, d.penaltyDue - d.penaltyPaid), 0) })), schedules, member_endpoints: '/v1/members', schedule_endpoints: '/v1/schedules', recurring_schedule_endpoints: '/v1/recurring-schedules', deposits_endpoint: '/v1/deposits', settlement_endpoint: '/v1/members/:id/exit' }); }));
export { router as constructionRouter };
