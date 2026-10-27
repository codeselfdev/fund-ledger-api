import {procurementAccruals} from './construction.procurement.service.js';
import {valuationAdjustments} from './construction.valuation.js';
import {moneyFromMicro} from './construction.control.engine.js';
import { financialTransaction, scope, type ConstructionScope } from './construction.service.js';
export async function constructionReport(a: ConstructionScope) {
    return financialTransaction(async (tx) => {
        const [heads, boq, allocations, contracts, bills, suppliers, labor, expenses, purchases, accounts, payments, dues, deposits] = await Promise.all([
            tx.constructionCostHead.findMany({ where: scope(a) }), tx.constructionBoq.findMany({ where: scope(a) }),
            tx.constructionCostAllocation.findMany({ where: scope(a), include: { expense: true } }),
            tx.constructionContract.findMany({ where: scope(a), include: { contractor: true } }),
            tx.constructionRunningBill.findMany({ where: { ...scope(a), status: 'approved' } }),
            tx.constructionSupplierBill.findMany({ where: { ...scope(a), status: 'approved' } }),
            tx.constructionLaborEntry.findMany({ where: { ...scope(a), status: 'approved' } }),
            tx.expense.findMany({ where: scope(a) }), tx.purchase.findMany({ where: scope(a), include: { constructionSupplierBill: true } }),
            tx.account.findMany({ where: scope(a) }), tx.constructionPayment.findMany({ where: scope(a) }),
            tx.due.findMany({ where: scope(a) }), tx.deposit.findMany({ where: { ...scope(a), status: 'confirmed' } })
        ]);
        const valuation=await valuationAdjustments(tx,a);
        const procurement=await procurementAccruals(tx,a);
        const [materialEntries,valueEntries,reclassifications]=valuation.method==='expense'?[[],[],[]]:await Promise.all([tx.constructionMaterialEntry.findMany({where:scope(a)}),tx.constructionValuationEntry.findMany({where:scope(a)}),tx.constructionReclassification.findMany({where:scope(a)})]);

        const activation=valuation.method==='expense'?null:(await tx.constructionControlSetting.findFirst({where:scope(a)}))?.valuationActivation as {opening_boq_credits?:Record<string,string>}|null;
        const approvedExpenses = expenses.filter(e => ['approved', 'paid'].includes(e.status));
        const recognizedAllocations = allocations.filter(row => ['approved', 'paid'].includes(row.expense.status));
        const approvedHeads = heads.filter(h => h.status === 'approved');
        const perHead = approvedHeads.map(h => {
            const associated = contracts.filter(c => c.costHeadId === h.id);
            const legacyActual = recognizedAllocations.filter(row => row.costHeadId === h.id).reduce((n, r) => n + r.amount, 0)
                + associated.reduce((n, c) => n + c.certifiedAmount - bills.filter(b => b.contractId === c.id).reduce((d,b) => d + b.wastageDeduction, 0), 0)
                + suppliers.filter(b => b.costHeadId === h.id).reduce((n, b) => n + b.amount, 0)
                + labor.filter(l => l.costHeadId === h.id).reduce((n, l) => n + l.amount, 0);
            const actual=legacyActual+(valuation.method==='expense'?(procurement.unbilled.get(h.id)??0):0)+moneyFromMicro((valuation.work.get(h.id)??0n)-(valuation.credits.get(h.id)??0n));
            const commitment = (procurement.commitments.get(h.id)??0)+associated.filter(c => c.status === 'active'||c.status==='suspended').reduce((n, c) => n + c.revisedAmount - c.certifiedAmount, 0);
            const remaining = Math.max(h.forecastRemaining, commitment);
            return { ...h, actual, commitments: commitment, cost_to_complete: remaining, projected_final_cost: actual + remaining, unspent_budget: h.revisedBudget - actual, projected_variance: h.revisedBudget - actual - remaining };
        });
        const unallocatedExpense = approvedExpenses.reduce((n, e) => n + e.amount, 0) - recognizedAllocations.reduce((n, r) => n + r.amount, 0);
        const unlinkedPurchases = purchases.filter(p => !p.constructionManaged && p.status === 'received' && (!p.constructionSupplierBill || p.constructionSupplierBill.status === 'rejected'));
        const purchaseCost = unlinkedPurchases.reduce((n, p) => n + p.totalAmount, 0);
        const unallocatedValuation=moneyFromMicro((valuation.work.get('')??0n)-(valuation.credits.get('')??0n));
        const actual = unallocatedValuation+perHead.reduce((n, h) => n + h.actual, 0) + unallocatedExpense + purchaseCost;
        const budget = approvedHeads.reduce((n, h) => n + h.revisedBudget, 0);
        const payable = procurement.total_unbilled + approvedExpenses.filter(e => e.status === 'approved').reduce((n, e) => n + e.amount, 0)
            + bills.reduce((n, b) => n + b.netPayable - b.paidAmount, 0) + suppliers.reduce((n, b) => n + b.amount - b.paidAmount, 0)
            + labor.reduce((n, l) => n + l.amount - l.paidAmount, 0) + contracts.reduce((n, c) => n + c.retentionHeld - c.retentionReleased, 0);
        const cash = accounts.reduce((n, c) => n + c.balance, 0);
        const unlinkedPurchaseCommitments = purchases.filter(p => !p.constructionManaged && p.status === 'ordered' && (!p.constructionSupplierBill || p.constructionSupplierBill.status !== 'approved')).reduce((n, p) => n + p.totalAmount, 0);
        const advances = contracts.reduce((n, c) => n + c.advancePaid - c.advanceRecovered, 0);
        const forecast = perHead.reduce((n, h) => n + h.cost_to_complete, 0) + unlinkedPurchaseCommitments;
        const inventoryOffset=Math.min(moneyFromMicro(valuation.inventory+valuation.transit),perHead.filter(h=>h.category==='materials').reduce((n,h)=>n+h.cost_to_complete,0));
        const approvedCosts = approvedExpenses.reduce((n, e) => n + e.amount, 0);
        const totalFundingCollected = deposits.reduce((n, d) => n + d.amount - d.refundedAmount, 0);
        const outstandingContributions = dues.reduce((n, d) => n + Math.max(0, d.amount - d.paidAmount - d.waivedAmount) + Math.max(0, d.penaltyDue - d.penaltyPaid), 0);
        const costByPhase = new Map<string, {
            phase: string;
            budget: number;
            actual: number;
            commitments: number;
            cost_to_complete: number;
        }>();
        for (const h of perHead) {
            const group = costByPhase.get(h.phase) ?? { phase: h.phase, budget: 0, actual: 0, commitments: 0, cost_to_complete: 0 };
            group.budget += h.revisedBudget;
            group.actual += h.actual;
            group.commitments += h.commitments;
            group.cost_to_complete += h.cost_to_complete;
            costByPhase.set(h.phase, group);
        }
        return { approved_budget: budget, actual_cost: actual, cash_paid: approvedExpenses.filter(e => e.status === 'paid').reduce((n, e) => n + e.amount, 0) + purchaseCost + payments.reduce((n, p) => n + p.amount, 0), approved_expense_cost: approvedCosts,
            unspent_budget: budget - actual, cost_to_complete: forecast, projected_final_cost: actual + forecast, projected_variance: budget - actual - forecast,
            unpaid_liabilities: payable, cash_available: cash, forecast_cash_to_complete: Math.max(0, forecast - advances - inventoryOffset), cash_requirement: Math.max(0, payable + Math.max(0, forecast - advances - inventoryOffset) - cash),
            unallocated_cost: unallocatedExpense + purchaseCost + unallocatedValuation, procurement_commitments: unlinkedPurchaseCommitments+procurement.total_commitments,unallocated_procurement_commitments:unlinkedPurchaseCommitments,controlled_procurement_commitments:procurement.total_commitments, received_not_invoiced:procurement.total_unbilled,
            advance_outstanding: advances, retention_payable: contracts.reduce((n, c) => n + c.retentionHeld - c.retentionReleased, 0),
            funding_collected: totalFundingCollected, contribution_dues: outstandingContributions,
            cost_heads: perHead, by_phase: [...costByPhase.values()],
            boq: boq.map(b => {
                const allocationCost=recognizedAllocations.filter(r=>r.boqId===b.id).reduce((n,r)=>n+r.amount,0),supplierCost=suppliers.filter(r=>r.boqId===b.id).reduce((n,r)=>n+r.amount,0),acquisition=allocationCost+supplierCost;
                if(valuation.method==='expense')return {...b,quantity:Number(b.quantity),actual:acquisition,remaining:b.estimated-acquisition};
                // Opening credits were apportioned once from reviewed source costs.
                const creditForBill=(id:string)=>reclassifications.filter(r=>r.sourceType==='supplier_bill'&&r.sourceId===id).reduce((n,r)=>n+moneyFromMicro(BigInt(String(r.valueMicro))),0);
                const ownCost=allocationCost+suppliers.filter(r=>r.boqId===b.id).reduce((n,r)=>n+r.amount-creditForBill(r.id),0);
                const openingCredit=moneyFromMicro(BigInt(activation?.opening_boq_credits?.[b.id]??'0'));
                const usage=valueEntries.filter(e=>!['opening','receipt'].includes(e.kind)&&materialEntries.some(m=>m.id===e.referenceId&&m.boqId===b.id)).reduce((n,e)=>n-BigInt(String(e.valueMicro)),0n);
                const actual=ownCost-openingCredit+moneyFromMicro(usage);
                return {...b,quantity:Number(b.quantity),actual,acquisition_cost:acquisition,remaining:b.estimated-actual};
            }),
            contracts: contracts.map(c => ({ ...c, unexecuted_commitment: ['active','suspended'].includes(c.status)?c.revisedAmount - c.certifiedAmount:0, advance_outstanding: c.advancePaid - c.advanceRecovered, retention_payable: c.retentionHeld - c.retentionReleased, bill_payable: bills.filter(b => b.contractId === c.id).reduce((n, b) => n + b.netPayable - b.paidAmount, 0) })),
            material_valuation:{method:valuation.method,inventory_value:moneyFromMicro(valuation.inventory),wip_value:moneyFromMicro(valuation.wip),loss_value:moneyFromMicro(valuation.loss),in_transit_value:moneyFromMicro(valuation.transit),inventory_cash_offset:inventoryOffset},
            recognition: valuation.method!=='expense'?'Material purchases and reviewed opening stock are reclassified into inventory. Net consumption enters WIP once; losses remain costs. Supplier liabilities and cash payments stay separate.':'Approved/paid expenses, approved supplier and labor bills, certified running work less approved wastage recoveries, and received purchases without a linked supplier bill. Accepted controlled deliveries accrue until their matched invoices are approved. Controlled PO receipts do not post cash. Material movements track quantities and do not add costs a second time.' };
    });
}
