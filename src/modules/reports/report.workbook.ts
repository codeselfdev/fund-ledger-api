import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { prisma } from '../../core/prisma/client.js';
import { notFound, badRequest } from '../../core/http/api-error.js';
import { dueRemaining, reportRange, type ExportConfig, type Scope } from './report.policy.js';
export type Sheet = { key: string; name: string; rows: (string | number | null)[][]; total_rows: number };
const MAX_ROWS = 100000;
export async function buildReport(scope: Scope, config: ExportConfig, now = new Date()) {
  const range = reportRange(now, config.timezone, config.period);
  return prisma.$transaction(async tx => {
    const where = { tenantId: scope.tenantId, projectId: scope.projectId };
    const project = await tx.project.findFirst({ where: { id: scope.projectId, tenantId: scope.tenantId } });
    if (!project) throw notFound('Project not found');
    const [accounts, dues, todayTx, periodTx, members, payments] = await Promise.all([
      tx.account.findMany({ where, orderBy: { name: 'asc' } }),
      tx.due.findMany({ where }),
      tx.accountTransaction.findMany({ where: { ...where, createdAt: { gte: range.dayStart, lte: now } }, take: MAX_ROWS + 1 }),
      config.sheets.includes('ie') ? tx.accountTransaction.findMany({ where: { ...where, direction: { in: ['money_in','money_out'] }, OR: [{ occurredOn: { gte: new Date(`${range.from}T00:00:00Z`), lt: new Date(`${range.until}T00:00:00Z`) } }, { occurredOn: null, createdAt: { gte: range.start, lte: range.end } }] }, include: { account: true, incomeCategory: true, incomeCustomer: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: MAX_ROWS + 1 }) : [],
      config.sheets.includes('members') ? tx.member.findMany({ where, orderBy: { name: 'asc' }, take: MAX_ROWS + 1 }) : [],
      config.sheets.includes('members') ? tx.deposit.groupBy({ where: { ...where, status: 'confirmed' }, by: ['memberId'], _max: { confirmedAt: true } }) : [],
    ]);
    if ([todayTx, periodTx, members].some(rows => rows.length > MAX_ROWS)) throw badRequest('Report exceeds 100,000 rows. Select a shorter period.');
    const transferIds = todayTx.filter(t=>t.direction==='transfer'&&t.referenceId).map(t=>t.referenceId!);
    const transfers = transferIds.length ? await tx.transfer.findMany({where:{...where,id:{in:transferIds}}}) : [];
    const transferMap = new Map(transfers.map(t=>[t.id,t]));
    const moneyIn = (t: typeof todayTx[number]) => t.direction==='money_in'||(t.direction==='transfer'&&!!t.referenceId&&transferMap.get(t.referenceId)?.toAccountId===t.accountId);
    const moneyOut = (t: typeof todayTx[number]) => t.direction==='money_out'||(t.direction==='transfer'&&!!t.referenceId&&transferMap.get(t.referenceId)?.fromAccountId===t.accountId);
    const expenseIds = periodTx.filter(t => t.referenceType === 'expense' && t.referenceId).map(t => t.referenceId!);
    const expenseRows = expenseIds.length ? await tx.expense.findMany({ where: { ...where, id: { in: expenseIds } }, include: { categoryDef: true, vendorRef: true } }) : [];
    const expenseMap = new Map(expenseRows.map(e => [e.id, e]));
    const collectedTx = todayTx.filter(t => t.referenceType === 'deposit' && t.direction === 'money_in');
    const spentTx = todayTx.filter(t => t.direction === 'money_out' && t.referenceType !== 'transfer');
    const stats = { collected: collectedTx.reduce((n,t) => n + t.amount,0), spent: spentTx.reduce((n,t) => n+t.amount,0), balance: accounts.reduce((n,a) => n+a.balance,0), outstanding: dues.reduce((n,d) => n+dueRemaining(d),0), deposits: collectedTx.length, expenses: spentTx.length, accounts: accounts.length, due_members: new Set(dues.filter(d => dueRemaining(d)>0).map(d=>d.memberId)).size };
    const sheets: Sheet[] = [];
    const add = (key: string, name: string, rows: Sheet['rows']) => sheets.push({ key, name, rows, total_rows: rows.length - 1 });
    if (config.sheets.includes('summary')) add('summary','Summary', [['Metric','Amount (BDT)'],['Date',range.today],['Collected today',stats.collected],['Spent today',stats.spent],['Cash & bank',stats.balance],['Outstanding dues',stats.outstanding],['Deposits today',stats.deposits],['Expenses today',stats.expenses],['Accounts',stats.accounts],['Members with dues',stats.due_members]]);
    if (config.sheets.includes('members')) {
      const grouped = new Map<string, typeof dues>();
      for (const d of dues) { const group = grouped.get(d.memberId) ?? []; group.push(d); grouped.set(d.memberId, group); }
      const last = new Map(payments.map(p=>[p.memberId,p._max.confirmedAt]));
      add('members','Members',[['Member','Status','Shares','Payable (BDT)','Paid (BDT)','Due (BDT)','Last payment'],...members.map(m=> { const ds = grouped.get(m.id) ?? []; return [m.name,m.status,m.shares,ds.reduce((n,d)=>n+d.amount-d.waivedAmount+d.penaltyDue,0),ds.reduce((n,d)=>n+d.paidAmount+d.penaltyPaid,0),ds.reduce((n,d)=>n+dueRemaining(d),0),last.get(m.id)?.toISOString() ?? '']; })]);
    }
    if (config.sheets.includes('banks')) add('banks','Accounts',[['Account','Type','Opening today (BDT)','In (BDT)','Out (BDT)','Closing (BDT)'],...accounts.map(a=> { const txns=todayTx.filter(t=>t.accountId===a.id); const incoming=txns.filter(moneyIn).reduce((n,t)=>n+t.amount,0), outgoing=txns.filter(moneyOut).reduce((n,t)=>n+t.amount,0); return [a.name,a.type,a.balance-incoming+outgoing,incoming,outgoing,a.balance]; })]);
    if (config.sheets.includes('ie')) add('ie','Income & Expense',[['Date','Type','Account','Description','Category','Vendor / customer','In (BDT)','Out (BDT)'],...periodTx.filter(t=>t.referenceType!=='transfer').map(t=> { const e=t.referenceId?expenseMap.get(t.referenceId):undefined; return [(t.occurredOn??t.createdAt).toISOString().slice(0,10),t.referenceType??t.direction,t.account.name,t.description??'',e?.categoryDef?.name??e?.category??t.incomeCategory?.name??'',e?.vendorRef?.name??e?.vendor??t.incomeCustomer?.name??'',t.direction==='money_in'?t.amount:0,t.direction==='money_out'?t.amount:0]; })]);
    return { project_name: project.name, generated_at: now.toISOString(), date: range.today, period_from: range.from, period_until: range.until, stats, sheets };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60000 });
}
export function workbookFiles(report: Awaited<ReturnType<typeof buildReport>>, layout: ExportConfig['layout']) {
  const stem = `${report.project_name.replace(/[^\p{L}\p{N}_-]/gu,'_').slice(0,70) || 'Report'}_${report.date}`;
  const groups = layout === 'sep' ? report.sheets.map(sheet=>[sheet]) : [report.sheets];
  return groups.map(sheets=> {
    const workbook = XLSX.utils.book_new();
    for (const sheet of sheets) {
      // aoa_to_sheet preserves untrusted strings as text, never as formula cells.
      const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
      ws['!cols'] = sheet.rows[0].map((_,i)=>({ wch: Math.min(45, Math.max(16,...sheet.rows.slice(0,100).map(r=>String(r[i]??'').length+2))) }));
      ws['!autofilter'] = { ref: ws['!ref'] ?? 'A1' };
      XLSX.utils.book_append_sheet(workbook,ws,sheet.name);
    }
    return { filename: `${stem}${layout==='sep'?`_${sheets[0].name.replace(/[^a-z0-9]/gi,'_')}`:''}.xlsx`, buffer: XLSX.write(workbook,{type:'buffer',bookType:'xlsx',compression:true}) as Buffer };
  });
}
