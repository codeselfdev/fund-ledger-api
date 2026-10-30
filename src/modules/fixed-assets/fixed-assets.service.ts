import { randomUUID } from 'node:crypto';
import { Prisma, type FixedAsset } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { financialTransaction as runFinancialTransaction } from '../accounting/transaction.js';
import { badRequest, conflict, notFound, forbidden } from '../../core/http/api-error.js';
import { atDate, hash, json, today, checkedMoney } from '../billing/billing.policy.js';
import { CATEGORIES, valuation, monthlyCharge, completedMonth, monthIndex, monthLabel } from './fixed-assets.policy.js';
import type { purchaseSchema, maintenanceSchema, transferSchema, disposalSchema } from './fixed-assets.policy.js';
import type { z } from 'zod';
export type Scope = {
    tenantId: string;
    projectId: string;
    userId: string;
    roles?: string[];
};
type Tx = Prisma.TransactionClient;
const financialTransaction = <T>(fn: (tx: Tx) => Promise<T>) => runFinancialTransaction(fn, 30000);
export const scope = (a: Scope) => ({ tenantId: a.tenantId, projectId: a.projectId });
export async function asset(tx: Tx, a: Scope, id: string, active = false) {
    const row = await tx.fixedAsset.findFirst({ where: { id, ...scope(a) } });
    if (!row)
        throw notFound('Asset not found');
    if (active && row.status !== 'active')
        throw conflict('This asset is disposed or its purchase was reversed');
    return row;
}
async function audit(tx: Tx, a: Scope, kind: string, id: string, detail: unknown) {
    await tx.activity.create({ data: { ...scope(a), actorUserId: a.userId, action: `fixed_asset.${kind}`, entityType: 'fixed_asset', entityId: id, after: json(detail) } });
}
async function event(tx: Tx, a: Scope, row: FixedAsset, kind: string, date: string, detail: unknown) {
    await tx.fixedAssetEvent.create({ data: { ...scope(a), assetId: row.id, kind, date: atDate(date), detail: json(detail), createdById: a.userId } });
    await audit(tx, a, kind, row.id, detail);
}
export type Line = {
    account: string;
    debit: number;
    credit: number;
};
const debit = (account: string, amount: number): Line => ({ account, debit: amount, credit: 0 });
const credit = (account: string, amount: number): Line => ({ account, debit: 0, credit: amount });
async function journal(tx: Tx, a: Scope, row: FixedAsset, kind: string, period: string, amount: number, lines: Line[]) {
    if (lines.reduce((n, l) => n + l.debit - l.credit, 0) !== 0)
        throw new Error('Unbalanced asset journal');
    return tx.fixedAssetJournal.create({ data: { ...scope(a), assetId: row.id, kind, period, amount, lines: json(lines) } });
}
async function cash(tx: Tx, a: Scope, accountId: string, amount: number, direction: 'in' | 'out', referenceType: string, referenceId: string, date: string) {
    const account = await tx.account.findFirst({ where: { id: accountId, ...scope(a) } });
    if (!account)
        throw notFound('Payment account not found in this project');
    if (direction === 'out' && account.balance < amount)
        throw conflict('Insufficient account balance');
    const balance = checkedMoney(account.balance + (direction === 'in' ? amount : -amount));
    await tx.account.update({ where: { id: account.id }, data: { balance } });
    await tx.accountTransaction.create({ data: { ...scope(a), accountId: account.id, direction: direction === 'in' ? 'money_in' : 'money_out', amount, referenceType, referenceId, description: referenceType.replace(/_/g, ' '), balanceAfter: balance, createdById: a.userId, occurredOn: atDate(date) } });
}
/** Every mutation, including its cash entry, journal and audit, replays atomically. */
export async function operation(a: Scope, key: string, body: unknown, fn: (tx: Tx) => Promise<unknown>) {
    return financialTransaction(async (tx) => {
        const requestHash = hash(body), old = await tx.fixedAssetOperation.findFirst({ where: { ...scope(a), requestKey: key } });
        if (old) {
            if (old.requestHash !== requestHash)
                throw conflict('Request key was used for different asset data');
            return old.result;
        }
        const result = await fn(tx);
        await tx.fixedAssetOperation.create({ data: { ...scope(a), requestKey: key, requestHash, result: json(result) } });
        return result;
    });
}
export async function postAsset(tx: Tx, row: FixedAsset, through: string) {
    const a = { tenantId: row.tenantId, projectId: row.projectId, userId: row.createdById };
    const first = Math.max(monthIndex(row.inUseDate), row.postedThrough ? monthIndex(row.postedThrough) + 1 : monthIndex(row.inUseDate));
    const last = Math.min(monthIndex(through), monthIndex(row.inUseDate) + row.lifeMonths - 1, row.disposedAt ? monthIndex(row.disposedAt) - 1 : Infinity);
    const entries: Prisma.FixedAssetJournalCreateManyInput[] = [];
    for (let n = first; n <= last; n++) {
        const period = monthLabel(n), amount = monthlyCharge(row, period);
        if (amount) {
            const priorOwner = row.depreciationSourceId && row.depreciationSourceThrough && period <= row.depreciationSourceThrough && row.depreciationSourceId !== row.projectId;
            if (priorOwner) {
                entries.push({ ...scope(a), projectId: row.depreciationSourceId!, assetId: row.id, kind: 'depreciation', period, amount, lines: json([debit('Depreciation expense', amount), credit('Inter-project asset transfer', amount)]) });
                entries.push({ ...scope(a), assetId: row.id, kind: 'transferred_depreciation', period, amount, lines: json([debit('Inter-project asset transfer', amount), credit('Accumulated depreciation', amount)]) });
            }
            else
                entries.push({ ...scope(a), assetId: row.id, kind: 'depreciation', period, amount, lines: json([debit('Depreciation expense', amount), credit('Accumulated depreciation', amount)]) });
        }
    }
    if (entries.length)
        await tx.fixedAssetJournal.createMany({ data: entries });
    if (last >= first)
        await tx.fixedAsset.update({ where: { id: row.id }, data: { postedThrough: monthLabel(last) } });
}
export async function purchase(a: Scope, b: z.infer<typeof purchaseSchema>) {
    return operation(a, b.request_key, { kind: 'purchase', ...b }, async (tx) => {
        if (b.invoice_upload_id && !await tx.upload.findFirst({ where: { id: b.invoice_upload_id, ...scope(a) } }))
            throw notFound('Invoice attachment not found');
        const rows: FixedAsset[] = [];
        for (let i = 0; i < b.quantity; i++) {
            const unit = b.units[i];
            if (unit.serial && await tx.fixedAsset.findFirst({ where: { tenantId: a.tenantId, serial: unit.serial, status: { not: 'reversed' } } }))
                throw conflict(`Serial ${unit.serial} already exists`);
            const id = randomUUID();
            const row = await tx.fixedAsset.create({ data: { id, ...scope(a), code: `FA-${CATEGORIES[b.category].code}-${id.slice(0, 8).toUpperCase()}`, name: b.name, category: b.category, cost: b.cost, residual: b.residual, lifeMonths: b.life_months, purchaseDate: atDate(b.purchase_date), inUseDate: atDate(b.in_use_date), supplier: b.supplier, invoice: b.invoice, invoiceUploadId: b.invoice_upload_id, accountId: b.account_id, ...{ location: unit.location, assignedTo: unit.assigned_to, serial: unit.serial }, warrantyUntil: b.warranty_until ? atDate(b.warranty_until) : null, createdById: a.userId } });
            await journal(tx, a, row, 'purchase', b.purchase_date, b.cost, [debit('Fixed assets', b.cost), credit(`Cash:${b.account_id}`, b.cost)]);
            await event(tx, a, row, 'purchase', b.purchase_date, { cost: b.cost, supplier: b.supplier, location: unit.location });
            await postAsset(tx, row, completedMonth(today()));
            rows.push(row);
        }
        await cash(tx, a, b.account_id, b.cost * b.quantity, 'out', 'fixed_asset_purchase', rows[0].id, b.purchase_date);
        return rows;
    });
}
export async function maintenance(a: Scope, id: string, b: z.infer<typeof maintenanceSchema>) {
    return operation(a, b.request_key, { kind: 'maintenance', id, ...b }, async (tx) => {
        const row = await asset(tx, a, id, true);
        if (b.service_date < row.purchaseDate.toISOString().slice(0, 10))
            throw badRequest('Service predates purchase');
        if (b.cost) {
            await cash(tx, a, b.account_id!, b.cost, 'out', 'fixed_asset_maintenance', id, b.service_date);
            await journal(tx, a, row, 'maintenance', b.request_key, b.cost, [debit('Maintenance expense', b.cost), credit(`Cash:${b.account_id}`, b.cost)]);
        }
        await tx.fixedAsset.update({ where: { id }, data: { nextServiceDate: b.next_service_date ? atDate(b.next_service_date) : null } });
        await event(tx, a, row, 'maintenance', b.service_date, b);
        return { asset_id: id, ...b };
    });
}
export async function transfer(a: Scope, id: string, b: z.infer<typeof transferSchema>) {
    return operation(a, b.request_key, { operation: 'transfer', id, ...b }, async (tx) => {
        const row = await asset(tx, a, id, true), date = today();
        await postAsset(tx, row, completedMonth(date));
        const from = b.kind === 'location' ? row.location : b.kind === 'person' ? row.assignedTo : row.projectId;
        if (from === b.target)
            throw badRequest('Choose a different destination');
        if (b.kind === 'project') {
            if (!await tx.project.findFirst({ where: { id: b.target, tenantId: a.tenantId, isActive: true } }))
                throw notFound('Destination project not found');
            if (!await tx.projectMembership.findFirst({ where: { tenantId: a.tenantId, projectId: b.target, userId: a.userId, isActive: true, role: { in: ['owner', 'admin', 'accountant'] } } }))
                throw forbidden('You need asset management access in the destination project');
            const value = valuation(row, completedMonth(date));
            // Carry gross cost and accumulated depreciation into the receiving project.
            await journal(tx, a, row, 'transfer_out', b.request_key, value.book_value, [debit('Accumulated depreciation', value.accumulated), debit('Inter-project asset transfer', value.book_value), credit('Fixed assets', row.cost)]);
            await journal(tx, { ...a, projectId: b.target }, row, 'transfer_in', b.request_key, value.book_value, [debit('Fixed assets', row.cost), credit('Accumulated depreciation', value.accumulated), credit('Inter-project asset transfer', value.book_value)]);
        }
        await event(tx, a, row, 'transfer', date, { ...b, from });
        const updated = await tx.fixedAsset.update({ where: { id }, data: b.kind === 'location' ? { location: b.target } : b.kind === 'person' ? { assignedTo: b.target === 'Nobody' ? '' : b.target } : { projectId: b.target, depreciationSourceId: row.depreciationSourceThrough && row.depreciationSourceThrough >= date.slice(0, 7) ? row.depreciationSourceId : row.projectId, depreciationSourceThrough: date.slice(0, 7) } });
        if (b.kind === 'project')
            await audit(tx, { ...a, projectId: b.target }, 'transfer_received', id, { from: a.projectId, ...b });
        return updated;
    });
}
export async function dispose(a: Scope, id: string, b: z.infer<typeof disposalSchema>) {
    return operation(a, b.request_key, { operation: 'dispose', id, ...b }, async (tx) => {
        const row = await asset(tx, a, id, true);
        if (b.date < row.purchaseDate.toISOString().slice(0, 10) || b.date.slice(0, 7) < today().slice(0, 7))
            throw badRequest('Disposal must be in the current month and on or after purchase');
        await postAsset(tx, row, completedMonth(b.date));
        const value = valuation(row, completedMonth(b.date)), gain = b.proceeds - value.book_value;
        if (b.kind === 'sell')
            await cash(tx, a, b.account_id!, b.proceeds, 'in', 'fixed_asset_sale', id, b.date);
        const lines = [debit('Accumulated depreciation', value.accumulated), credit('Fixed assets', row.cost)];
        if (b.proceeds)
            lines.push(debit(`Cash:${b.account_id}`, b.proceeds));
        if (gain >= 0)
            lines.push(credit('Gain on disposal', gain));
        else
            lines.push(debit('Loss on disposal', -gain));
        await journal(tx, a, row, 'disposal', b.date, value.book_value, lines);
        const result = { ...b, book_value: value.book_value, gain_loss: gain };
        const updated = await tx.fixedAsset.update({ where: { id }, data: { status: 'disposed', disposedAt: atDate(b.date), disposal: json(result) } });
        await event(tx, a, row, 'disposal', b.date, result);
        return updated;
    });
}
export async function postProject(a: Scope) {
    return financialTransaction(async (tx) => { const rows = await tx.fixedAsset.findMany({ where: { ...scope(a), status: 'active' } }); for (const row of rows)
        await postAsset(tx, row, completedMonth(today())); return { through: completedMonth(today()), assets: rows.length }; });
}
export async function overview(a: Scope) {
    const through = completedMonth(today()), rows = await prisma.fixedAsset.findMany({ where: scope(a), orderBy: { createdAt: 'desc' } });
    const assets = rows.map(r => ({ ...r, ...valuation(r, through) })), active = assets.filter(r => r.status === 'active');
    const months = Array.from({ length: 12 }, (_, i) => monthLabel(monthIndex(through) - 10 + i));
    const journals = await prisma.fixedAssetJournal.findMany({ where: { ...scope(a), kind: { in: ['depreciation', 'depreciation_reversal'] }, period: { gte: months[0], lte: through } } });
    const outgoing = await prisma.fixedAsset.findMany({ where: { tenantId: a.tenantId, depreciationSourceId: a.projectId, status: 'active', depreciationSourceThrough: { gt: through } } });
    const forecast = (month: string, category?: string) => active.filter(r => !category || r.category === category).reduce((n, r) => n + (r.depreciationSourceId && r.depreciationSourceId !== a.projectId && r.depreciationSourceThrough && month <= r.depreciationSourceThrough ? 0 : monthlyCharge(r, month)), 0) + outgoing.filter(r => r.projectId !== a.projectId && r.depreciationSourceThrough && month <= r.depreciationSourceThrough && (!category || r.category === category)).reduce((n, r) => n + monthlyCharge(r, month), 0);
    const monthly = months.map(month => ({ month, amount: month > through ? forecast(month) : journals.filter(j => j.period === month).reduce((n, j) => n + j.amount, 0), forecast: month > through }));
    const fiscalStart = `${Number(today().slice(0, 4)) - (Number(today().slice(5, 7)) < 7 ? 1 : 0)}-07`;
    const fyJournals = journals.filter(j => j.period >= fiscalStart);
    const journalAssets = await prisma.fixedAsset.findMany({ where: { tenantId: a.tenantId, id: { in: [...new Set(fyJournals.map(j => j.assetId))] } } });
    const categoryById = new Map(journalAssets.map(r => [r.id, r.category]));
    return { through, assets, count: active.length, cost: active.reduce((n, r) => n + r.cost, 0), accumulated: active.reduce((n, r) => n + r.accumulated, 0), book_value: active.reduce((n, r) => n + r.book_value, 0), monthly, fiscal_start: fiscalStart, fytd: fyJournals.reduce((n, j) => n + j.amount, 0),
        categories: Object.entries(CATEGORIES).map(([key, cat]) => ({ key, ...cat, forecast: forecast(today().slice(0, 7), key), fytd: fyJournals.filter(j => categoryById.get(j.assetId) === key).reduce((n, j) => n + j.amount, 0), count: active.filter(r => r.category === key).length, book_value: active.filter(r => r.category === key).reduce((n, r) => n + r.book_value, 0) })),
        alerts: active.flatMap(r => { const alerts: {
            asset_id: string;
            title: string;
            text: string;
        }[] = []; if (r.remaining <= 6)
            alerts.push({ asset_id: r.id, title: r.name, text: r.remaining === 0 ? 'Fully depreciated · still in use?' : `${r.remaining} months of useful life left` }); if (r.nextServiceDate && r.nextServiceDate.toISOString().slice(0, 10) <= today())
            alerts.push({ asset_id: r.id, title: r.name, text: 'Maintenance is due' }); if (r.warrantyUntil && r.warrantyUntil.toISOString().slice(0, 10) >= today() && r.warrantyUntil.getTime() - atDate(today()).getTime() <= 30 * 86400000)
            alerts.push({ asset_id: r.id, title: r.name, text: 'Warranty expires within 30 days' }); return alerts; }) };
}
