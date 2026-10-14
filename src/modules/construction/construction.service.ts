import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { financialTransaction } from '../accounting/transaction.js';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { atDate, hash, json, checkedMoney } from '../billing/billing.policy.js';
import { scope, sameRequest, type BillingScope } from '../billing/billing.service.js';
import { runningBill, paymentSchema, materialSchema, type decisionSchema } from './construction.policy.js';
export { scope, sameRequest, financialTransaction };
export type ConstructionScope = BillingScope;
type Tx = Prisma.TransactionClient;
export async function audit(tx: Tx, a: ConstructionScope, action: string, entityType: string, entityId: string, detail: unknown) {
    await tx.activity.create({ data: { ...scope(a), actorUserId: a.userId, action: `construction.${action}`, entityType, entityId, after: json(detail) } });
}
export async function head(tx: Tx, a: ConstructionScope, id: string) {
    const row = await tx.constructionCostHead.findFirst({ where: { id, ...scope(a), status: 'approved' } });
    if (!row)
        throw notFound('Approved cost head not found');
    return row;
}
export async function boq(tx: Tx, a: ConstructionScope, id: string, costHeadId?: string) {
    const row = await tx.constructionBoq.findFirst({ where: { id, ...scope(a), costHeadId, isActive: true } });
    if (!row)
        throw notFound('BOQ item not found for this cost head');
    return row;
}
export async function decide(a: ConstructionScope, kind: 'budget' | 'running_bill' | 'supplier_bill' | 'labor' | 'change_order', id: string, decision: z.infer<typeof decisionSchema>['decision']) {
    return financialTransaction(async (tx) => {
        const where = { id, ...scope(a) };
        const row = kind === 'budget' ? await tx.constructionCostHead.findFirst({ where }) : kind === 'running_bill' ? await tx.constructionRunningBill.findFirst({ where }) : kind === 'supplier_bill' ? await tx.constructionSupplierBill.findFirst({ where }) : kind === 'labor' ? await tx.constructionLaborEntry.findFirst({ where }) : await tx.constructionChangeOrder.findFirst({ where });
        if (!row)
            throw notFound('Approval request not found');
        const status = decision === 'approve' ? 'approved' : 'rejected';
        if (row.status !== 'pending') {
            if (row.status === status)
                return row;
            throw conflict('Request has already been decided');
        }
        if (row.createdById === a.userId)
            throw conflict('A different administrator or approver must review this request');
        if (decision === 'approve') {
            if (kind === 'running_bill') {
                const bill = row as Prisma.ConstructionRunningBillGetPayload<{}>;
                const contract = await tx.constructionContract.findFirst({ where: { id: bill.contractId, ...scope(a), status: 'active' } });
                if (!contract)
                    throw notFound('Active contract not found');
                if (contract.certifiedAmount !== bill.previousCertified)
                    throw conflict('Another bill was certified; submit a fresh cumulative running bill');
                const totals = runningBill(contract, bill.cumulativeCertified, bill.advanceRecovery);
                if (totals.retention !== bill.retention || totals.netPayable !== bill.netPayable)
                    throw conflict('Contract changed since this bill was requested');
                await tx.constructionContract.update({ where: { id: contract.id }, data: { certifiedAmount: bill.cumulativeCertified, retentionHeld: { increment: bill.retention }, advanceRecovered: { increment: bill.advanceRecovery } } });
            }
            else if (kind === 'change_order') {
                const change = row as Prisma.ConstructionChangeOrderGetPayload<{}>;
                if (change.budgetChange) {
                    const old = await head(tx, a, change.costHeadId!);
                    await tx.constructionCostHead.update({ where: { id: old.id }, data: { revisedBudget: checkedMoney(old.revisedBudget + change.budgetChange) } });
                }
                if (change.contractChange) {
                    const old = await tx.constructionContract.findFirst({ where: { id: change.contractId!, ...scope(a), status: 'active' } });
                    if (!old)
                        throw notFound('Active contract not found');
                    const amount = checkedMoney(old.revisedAmount + change.contractChange);
                    if (amount < Math.max(old.certifiedAmount, old.advancePaid))
                        throw conflict('Revised contract cannot be below certified work or advances');
                    await tx.constructionContract.update({ where: { id: old.id }, data: { revisedAmount: amount } });
                }
            }
            else if (kind === 'supplier_bill' || kind === 'labor')
                await head(tx, a, (row as {
                    costHeadId: string;
                }).costHeadId);
        }
        const data = { status, decidedById: a.userId, ...(kind === 'budget' ? {} : { decidedAt: new Date() }) };
        const updated = kind === 'budget' ? await tx.constructionCostHead.update({ where: { id }, data }) : kind === 'running_bill' ? await tx.constructionRunningBill.update({ where: { id }, data }) : kind === 'supplier_bill' ? await tx.constructionSupplierBill.update({ where: { id }, data }) : kind === 'labor' ? await tx.constructionLaborEntry.update({ where: { id }, data }) : await tx.constructionChangeOrder.update({ where: { id }, data });
        await audit(tx, a, `${kind}.${status}`, `construction_${kind}`, id, updated);
        return updated;
    });
}
export async function pay(a: ConstructionScope, b: z.infer<typeof paymentSchema>) {
    return financialTransaction(async (tx) => {
        const existing = await tx.constructionPayment.findFirst({ where: { ...scope(a), requestKey: b.request_key } });
        if (existing) {
            sameRequest(existing, b);
            return existing;
        }
        const account = await tx.account.findFirst({ where: { id: b.account_id, ...scope(a) } });
        if (!account)
            throw notFound('Account not found');
        if (account.balance < b.amount)
            throw conflict('Insufficient account balance');
        if (b.kind === 'advance' || b.kind === 'retention') {
            const c = await tx.constructionContract.findFirst({ where: { id: b.contract_id!, ...scope(a) } });
            if (!c)
                throw notFound('Contract not found');
            if (b.kind === 'advance') {
                if (c.status !== 'active' || b.amount > c.revisedAmount - c.certifiedAmount - (c.advancePaid - c.advanceRecovered))
                    throw conflict('Advance exceeds the active contract balance');
                await tx.constructionContract.update({ where: { id: c.id }, data: { advancePaid: { increment: b.amount } } });
            }
            else {
                if (c.status !== 'closed' || b.amount > c.retentionHeld - c.retentionReleased)
                    throw conflict('Close the fully certified contract before releasing available retention');
                await tx.constructionContract.update({ where: { id: c.id }, data: { retentionReleased: { increment: b.amount } } });
            }
        }
        else if (b.kind === 'running_bill') {
            const bill = await tx.constructionRunningBill.findFirst({ where: { id: b.running_bill_id!, ...scope(a), status: 'approved' } });
            if (!bill)
                throw notFound('Approved running bill not found');
            if (b.amount > bill.netPayable - bill.paidAmount)
                throw conflict('Payment exceeds the certified payable');
            await tx.constructionRunningBill.update({ where: { id: bill.id }, data: { paidAmount: { increment: b.amount } } });
        }
        else if (b.kind === 'supplier_bill') {
            const bill = await tx.constructionSupplierBill.findFirst({ where: { id: b.supplier_bill_id!, ...scope(a), status: 'approved' } });
            if (!bill)
                throw notFound('Approved supplier bill not found');
            if (b.amount > bill.amount - bill.paidAmount)
                throw conflict('Payment exceeds the supplier payable');
            await tx.constructionSupplierBill.update({ where: { id: bill.id }, data: { paidAmount: { increment: b.amount } } });
        }
        else {
            const entry = await tx.constructionLaborEntry.findFirst({ where: { id: b.labor_entry_id!, ...scope(a), status: 'approved' } });
            if (!entry)
                throw notFound('Approved labor record not found');
            if (b.amount > entry.amount - entry.paidAmount)
                throw conflict('Payment exceeds the labor payable');
            await tx.constructionLaborEntry.update({ where: { id: entry.id }, data: { paidAmount: { increment: b.amount } } });
        }
        const row = await tx.constructionPayment.create({ data: { ...scope(a), kind: b.kind, contractId: b.contract_id, runningBillId: b.running_bill_id, supplierBillId: b.supplier_bill_id, laborEntryId: b.labor_entry_id, accountId: account.id, amount: b.amount, paymentDate: atDate(b.payment_date), reference: b.reference, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } });
        const updated = await tx.account.update({ where: { id: account.id }, data: { balance: { decrement: b.amount } } });
        await tx.accountTransaction.create({ data: { ...scope(a), accountId: account.id, direction: 'money_out', amount: b.amount, balanceAfter: updated.balance, referenceType: `construction_${b.kind}`, referenceId: row.id, description: `Construction ${b.kind.replace(/_/g, ' ')} payment`, occurredOn: row.paymentDate, createdById: a.userId } });
        await audit(tx, a, 'payment.posted', 'construction_payment', row.id, row);
        return row;
    });
}
export async function moveMaterial(a: ConstructionScope, b: z.infer<typeof materialSchema>) {
    return financialTransaction(async (tx) => {
        const existing = await tx.constructionMaterialEntry.findFirst({ where: { ...scope(a), requestKey: b.request_key } });
        if (existing) {
            sameRequest(existing, b);
            return existing;
        }
        const item = await tx.inventoryItem.findFirst({ where: { id: b.item_id, ...scope(a), isActive: true } });
        if (!item)
            throw notFound('Material inventory item not found');
        if (b.boq_id)
            await boq(tx, a, b.boq_id);
        if (b.kind === 'return') {
            const source = await tx.constructionMaterialEntry.findFirst({ where: { id: b.source_id, ...scope(a), itemId: item.id, kind: 'consume' } });
            if (!source || b.quantity > source.quantity - source.returnedQuantity || source.boqId !== (b.boq_id ?? null))
                throw conflict('Return exceeds the source consumption or uses a different BOQ item');
            if (atDate(b.entry_date) < source.entryDate)
                throw badRequest('Return date cannot precede consumption');
            await tx.constructionMaterialEntry.update({ where: { id: source.id }, data: { returnedQuantity: { increment: b.quantity } } });
            checkedMoney(item.quantity + b.quantity);
        }
        else if (item.quantity < b.quantity)
            throw conflict('Insufficient stock for consumption or wastage');
        const change = b.kind === 'return' ? b.quantity : -b.quantity;
        const updated = await tx.inventoryItem.update({ where: { id: item.id }, data: { quantity: { increment: change } } });
        const row = await tx.constructionMaterialEntry.create({ data: { ...scope(a), itemId: item.id, boqId: b.boq_id, kind: b.kind, quantity: b.quantity, entryDate: atDate(b.entry_date), reason: b.reason, sourceId: b.source_id, requestKey: b.request_key, requestHash: hash(b), createdById: a.userId } });
        await tx.stockMovement.create({ data: { ...scope(a), itemId: item.id, type: change > 0 ? 'adjustment_increase' : 'adjustment_decrease', quantity: change, quantityAfter: updated.quantity, referenceType: `construction_${b.kind}`, referenceId: row.id, reason: b.reason, createdById: a.userId } });
        await audit(tx, a, 'material.recorded', 'construction_material_entry', row.id, row);
        return row;
    });
}
export async function receiveSupplierPurchase(tx: Tx, a: ConstructionScope, billId: string) {
    const bill = await tx.constructionSupplierBill.findFirst({ where: { id: billId, ...scope(a), status: 'approved' } });
    if (!bill?.purchaseId)
        throw notFound('Approved purchase-linked supplier bill not found');
    if (bill.receivedAt)
        return bill;
    const purchase = await tx.purchase.findFirst({ where: { id: bill.purchaseId, ...scope(a), status: 'ordered' }, include: { lines: true } });
    if (!purchase)
        throw conflict('Purchase is not awaiting receipt');
    for (const line of purchase.lines) {
        const item = await tx.inventoryItem.findFirst({ where: { id: line.itemId, ...scope(a) } });
        if (!item)
            throw notFound('Purchase material not found');
        checkedMoney(item.quantity + line.quantity);
        const updated = await tx.inventoryItem.update({ where: { id: item.id }, data: { quantity: { increment: line.quantity }, costPrice: line.unitCost } });
        await tx.stockMovement.create({ data: { ...scope(a), itemId: item.id, type: 'purchase_received', quantity: line.quantity, quantityAfter: updated.quantity, referenceType: 'construction_supplier_bill', referenceId: bill.id, createdById: a.userId } });
    }
    await tx.purchase.update({ where: { id: purchase.id }, data: { status: 'received', accountId: null, receivedById: a.userId, receivedAt: new Date() } });
    const row = await tx.constructionSupplierBill.update({ where: { id: bill.id }, data: { receivedAt: new Date() } });
    await audit(tx, a, 'purchase.received', 'construction_supplier_bill', row.id, row);
    return row;
}
