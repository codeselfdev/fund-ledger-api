import { Prisma } from '@prisma/client';
import { prisma } from '../../core/prisma/client.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/api-error.js';
import { financialTransaction } from '../accounting/transaction.js';
export type ReversalKind = 'income' | 'expense' | 'deposit' | 'fixed_asset';
export type Scope = { tenantId: string; projectId: string; userId: string };
const scoped = (a: Scope) => ({ tenantId: a.tenantId, projectId: a.projectId });
const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v));
export function requireReversalAdmin(a: { roles?: string[]; builtinRoles?: string[]; menuRouteGranted?: boolean; impersonation?: unknown }) {
  const roles = a.builtinRoles ?? (a.menuRouteGranted ? [] : a.roles ?? []);
  if (a.impersonation || !roles.some(r => r === 'owner' || r === 'admin')) throw forbidden('Only a built-in project owner or admin can reverse posted transactions');
}
async function plan(tx: Prisma.TransactionClient, a: Scope, kind: ReversalKind, id: string) {
  const scope = scoped(a), blockers: string[] = [];
  let title = '', originals: Awaited<ReturnType<typeof tx.accountTransaction.findMany>> = [], assets: Awaited<ReturnType<typeof tx.fixedAsset.findMany>> = [];
  let deposit: Awaited<ReturnType<typeof tx.deposit.findFirst>> = null;
  if (kind === 'income') {
    const row = await tx.accountTransaction.findFirst({ where: { ...scope, id, referenceType: 'income', direction: 'money_in' } });
    if (!row) throw notFound('Income not found');
    title = row.incomeSource ?? row.description ?? 'Income'; originals = [row];
  } else if (kind === 'expense') {
    const row = await tx.expense.findFirst({ where: { ...scope, id } });
    if (!row) throw notFound('Expense not found');
    title = row.title;
    if (row.status !== 'paid') blockers.push('Only a paid expense can be reversed.');
    if (row.recurringBillId || await tx.constructionCostAllocation.count({ where: { ...scope, expenseId: id } })) blockers.push('This expense is linked to a recurring bill or construction costs. Resolve those records first.');
    originals = await tx.accountTransaction.findMany({ where: { ...scope, referenceType: 'expense', referenceId: id } });
    if (originals.length !== 1 || originals[0]?.amount !== row.amount || originals[0]?.direction !== 'money_out') blockers.push('The expense cash posting is incomplete or ambiguous.');
  } else if (kind === 'deposit') {
    deposit = await tx.deposit.findFirst({ where: { ...scope, id } });
    if (!deposit) throw notFound('Deposit not found');
    title = 'Member deposit';
    if (deposit.status !== 'confirmed') blockers.push('Only a confirmed deposit can be reversed.');
    if (deposit.refundedAmount) blockers.push('This deposit has already been refunded in part or in full.');
    const member = await tx.member.findFirst({ where: { ...scope, id: deposit.memberId } });
    if (member?.status !== 'active') blockers.push('The member is inactive. Resolve the member settlement first.');
    const allocations = await tx.depositAllocation.findMany({ where: { ...scope, depositId: id } });
    if (deposit.allocate === 'advance' && allocations.some(r => r.amount > 0)) blockers.push('This advance has been used. Undo its allocations before reversing it.');
    if (deposit.allocate !== 'advance' && (allocations.reduce((n,r) => n+r.amount,0) !== deposit.amount || allocations.some(r => r.principalAmount === null || r.penaltyAmount === null || r.principalAmount < 0 || r.penaltyAmount < 0 || r.principalAmount! + r.penaltyAmount! !== r.amount))) blockers.push('This legacy deposit has no exact principal/penalty snapshot. It requires an accountant-reviewed correction.');
    originals = await tx.accountTransaction.findMany({ where: { ...scope, referenceType: 'deposit', referenceId: id } });
    if (originals.length !== 1 || originals[0]?.amount !== deposit.amount || originals[0]?.direction !== 'money_in') blockers.push('The deposit cash posting is incomplete or ambiguous.');
  } else {
    const row = await tx.fixedAsset.findFirst({ where: { ...scope, id } });
    if (!row) throw notFound('Asset not found');
    // The operation receipt identifies every unit sharing the original cash posting.
    const receipt = await tx.fixedAssetOperation.findFirst({ where: { ...scope, result: { array_contains: [{ id }] } } });
    const ids = receipt && Array.isArray(receipt.result) ? receipt.result.map(r => (r as { id: string }).id) : [id];
    assets = await tx.fixedAsset.findMany({ where: { tenantId: a.tenantId, id: { in: ids } } });
    title = assets.length > 1 ? `${row.name} · ${assets.length} units (entire purchase)` : row.name;
    if (assets.length !== ids.length || assets.some(r => r.projectId !== a.projectId || r.status !== 'active')) blockers.push('Every unit must still be active in this project.');
    const events = await tx.fixedAssetEvent.count({ where: { tenantId: a.tenantId, assetId: { in: ids }, kind: { not: 'purchase' } } });
    if (events) blockers.push('This purchase has later service, transfer or disposal activity. Resolve it before reversal.');
    originals = await tx.accountTransaction.findMany({ where: { ...scope, referenceType: 'fixed_asset_purchase', referenceId: { in: ids } } });
    if (originals.length !== 1 || originals[0]?.amount !== assets.reduce((n,r) => n+r.cost,0) || originals[0]?.direction !== 'money_out') blockers.push('The purchase cash posting is incomplete or ambiguous.');
  }
  if (originals.some(r => r.reversedAt)) blockers.push('This transaction has already been reversed.');
  for (const row of originals) {
    const account = await tx.account.findFirst({ where: { ...scope, id: row.accountId } });
    if (!account) blockers.push('The original payment account is unavailable.');
    else if (row.direction === 'money_in' && account.balance < row.amount) blockers.push('The original account has insufficient funds to reverse this receipt.');
    else if (row.direction === 'money_out' && account.balance > 2147483647 - row.amount) blockers.push('The reversal would exceed the supported account balance.');
  }
  return { title, originals, assets, deposit, blockers };
}
export async function reversalPreview(a: Scope, kind: ReversalKind, id: string) {
  const p = await plan(prisma, a, kind, id);
  const accounts=await prisma.account.findMany({where:{...scoped(a),id:{in:p.originals.map(r=>r.accountId)}}});
  return { title: p.title, amount: p.originals.reduce((n,r) => n+r.amount,0), accounts: p.originals.map(r => ({ id: r.accountId, name: accounts.find(a=>a.id===r.accountId)?.name ?? 'Original account', change: r.direction === 'money_in' ? -r.amount : r.amount })), units: p.assets.length, blockers: p.blockers,
    effects: kind === 'deposit' ? 'The account credit will be removed, exact dues reopened and the receipt voided. This does not send a bank refund.' : kind === 'fixed_asset' ? 'The entire purchase and posted depreciation will be reversed. All original records remain in history.' : 'A linked opposite cash entry will correct the balance. The original record remains in history. No bank transfer is made.' };
}
export async function reverseTransaction(a: Scope, kind: ReversalKind, id: string, b: { reason: string; request_key: string }) {
  return financialTransaction(async tx => {
    const scope = scoped(a);
    if (!await tx.projectMembership.findFirst({ where: { ...scope, userId: a.userId, isActive: true, customRoleId: null, role: { in: ['owner','admin'] } } })) throw forbidden('Your project admin access changed. Sign in again.');
    const previous = await tx.transactionReversal.findFirst({ where: { ...scope, requestKey: b.request_key } });
    if (previous) {
      if (previous.kind !== kind || previous.recordId !== id || previous.reason !== b.reason) throw conflict('This retry key belongs to a different reversal');
      return previous.result;
    }
    if (await tx.transactionReversal.findFirst({ where: { ...scope, kind, recordId: id } })) throw conflict('This transaction was already reversed');
    const project = await tx.project.findFirst({ where: { id: a.projectId, tenantId: a.tenantId, isActive: true, deletionStartedAt: null } });
    if (!project) throw forbidden('Project is unavailable');
    const p = await plan(tx, a, kind, id);
    if (p.blockers.length) throw conflict(p.blockers.join(' '));
    const now = new Date(), createdIds: string[] = [];
    for (const original of p.originals) {
      const delta = original.direction === 'money_in' ? -original.amount : original.amount;
      const updated = await tx.account.update({ where: { id: original.accountId }, data: { balance: { increment: delta } } });
      const entry = await tx.accountTransaction.create({ data: { ...scope, accountId: original.accountId, direction: delta > 0 ? 'money_in' : 'money_out', amount: original.amount, referenceType: `${kind}_reversal`, referenceId: id, reversalOfId: original.id, description: `Reversal: ${b.reason}`, occurredOn: now, balanceAfter: updated.balance, createdById: a.userId } });
      await tx.accountTransaction.update({ where: { id: original.id }, data: { reversedAt: now } });
      createdIds.push(entry.id);
    }
    if (kind === 'expense') await tx.expense.update({ where: { id }, data: { status: 'reversed' } });
    if (p.deposit) {
      const allocations = await tx.depositAllocation.findMany({ where: { ...scope, depositId: id }, include: { due: true } });
      for (const allocation of allocations.filter(r => r.amount > 0)) {
        const due = allocation.due;
        if (due.tenantId !== a.tenantId || due.projectId !== a.projectId || due.memberId !== p.deposit.memberId) throw conflict('Deposit allocation is outside this member/project');
        const paidAmount = due.paidAmount - allocation.principalAmount!, penaltyPaid = due.penaltyPaid - allocation.penaltyAmount!;
        if (paidAmount < 0 || penaltyPaid < 0) throw conflict('The due allocation changed. Review the member ledger first.');
        const status = paidAmount + due.waivedAmount >= due.amount && penaltyPaid >= due.penaltyDue ? 'paid' : paidAmount > 0 || penaltyPaid > 0 ? 'partial' : 'due';
        await tx.due.update({ where: { id: due.id }, data: { paidAmount, penaltyPaid, status, paidAt: status === 'paid' ? due.paidAt : null } });
      }
      await tx.deposit.update({ where: { id }, data: { status: 'reversed' } });
      await tx.receipt.updateMany({ where: { ...scope, depositId: id }, data: { voidedAt: now, voidReason: b.reason } });
      const existingCommitment = await tx.paymentCommitment.count({ where: { ...scope, memberId: p.deposit.memberId, status: 'pending' } });
      await tx.paymentCommitment.updateMany({ where: { ...scope, resolvedDepositId: id }, data: { status: existingCommitment ? 'cancelled' : 'pending', resolvedDepositId: null, resolvedAt: null, resolvedById: null, resolveReason: null } });
    }
    for (const asset of p.assets) {
      const journals = await tx.fixedAssetJournal.findMany({ where: { ...scope, assetId: asset.id } });
      for (const j of journals) {
        const lines = j.lines as unknown as { account: string; debit: number; credit: number }[];
        if (!Array.isArray(lines) || lines.some(l => !Number.isSafeInteger(l.debit) || !Number.isSafeInteger(l.credit))) throw badRequest('Asset journal needs review');
        await tx.fixedAssetJournal.create({ data: { ...scope, assetId: asset.id, kind: `${j.kind}_reversal`, period: j.period, amount: -j.amount, lines: json(lines.map(l => ({ account: l.account, debit: l.credit, credit: l.debit }))) } });
      }
      await tx.fixedAsset.update({ where: { id: asset.id }, data: { status: 'reversed' } });
      await tx.fixedAssetEvent.create({ data: { ...scope, assetId: asset.id, kind: 'reversal', date: now, detail: { reason: b.reason }, createdById: a.userId } });
    }
    const result = { kind, record_id: id, reversed_at: now.toISOString(), transaction_ids: createdIds, asset_ids: p.assets.map(r => r.id) };
    await tx.transactionReversal.create({ data: { ...scope, kind, recordId: id, requestKey: b.request_key, reason: b.reason, userId: a.userId, result: json(result) } });
    await tx.activity.create({ data: { ...scope, actorUserId: a.userId, action: `${kind}.reversed`, entityType: kind, entityId: id, before: json(p.originals), after: { ...result, reason: b.reason } } });
    return result;
  }, 30000);
}
