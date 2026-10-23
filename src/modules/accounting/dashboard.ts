import type { BusinessDocument, BusinessPayment, InventoryItem, Expense } from '@prisma/client';
import { paymentStatus } from './workflow.js';

export type DashboardPeriod = 'this_month' | 'last_month' | 'this_year';
const dayKey = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const atDay = (date: string) => new Date(`${date}T00:00:00Z`);
const shiftMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
export function dashboardRange(period: DashboardPeriod, now = new Date()) {
  const today = dayKey(now), year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)) - 1;
  if (period === 'this_year') return { from: `${year}-01-01`, to: today, previousFrom: `${year - 1}-01-01`, previousTo: `${year - 1}-${today.slice(5, 7)}-${Math.min(Number(today.slice(8)), new Date(Date.UTC(year - 1, month + 1, 0)).getUTCDate()).toString().padStart(2, '0')}` };
  const start = period === 'last_month' ? shiftMonth(year, month - 1) : shiftMonth(year, month);
  const previous = shiftMonth(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 2);
  const endOfMonth = (start: string) => new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const to = period === 'last_month' ? endOfMonth(start) : today;
  const previousTo = period === 'last_month' ? endOfMonth(previous) : `${previous.slice(0, 8)}${Math.min(Number(today.slice(8)), Number(endOfMonth(previous).slice(8))).toString().padStart(2, '0')}`;
  return { from: start, to, previousFrom: previous, previousTo };
}
const inRange = (date: Date, from: string, to: string, businessDate = false) => {
  const key = businessDate ? date.toISOString().slice(0, 10) : dayKey(date);
  return key >= from && key <= to;
};
const sum = <T>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);
const remaining = (doc: BusinessDocument) => Math.max(0, doc.total - doc.paidAmount);
const eligible = (doc: BusinessDocument) => !['cancelled', 'rejected', 'expired'].includes(doc.status);
export function buildAccountingDashboard(input: { documents: BusinessDocument[]; payments: BusinessPayment[]; expenses?: Expense[]; items: InventoryItem[]; customers: number; stockEnabled: boolean; period: DashboardPeriod; now?: Date }) {
  const { documents, payments, items, customers, stockEnabled, period } = input, now = input.now ?? new Date();
  const range = dashboardRange(period, now), today = dayKey(now);
  const selected = documents.filter(doc => inRange(doc.documentDate, range.from, range.to, true));
  const allSales = documents.filter(doc => doc.kind === 'sale' && doc.status === 'issued');
  const sales = selected.filter(doc => doc.kind === 'sale' && doc.status === 'issued');
  const invoiced = sum(sales, doc => doc.total), collected = sum(sales, doc => doc.paidAmount);
  const overdueSales = sales.filter(doc => paymentStatus(doc, now) === 'overdue');
  const outstanding = sum(sales, remaining), overdue = sum(overdueSales, remaining);
  const issuedIds = new Set(allSales.map(doc => doc.id));
  const validPayments = payments.filter(payment => issuedIds.has(payment.documentId));
  const currentPayments = validPayments.filter(payment => inRange(payment.paymentDate, range.from, range.to, true));
  const priorPayments = validPayments.filter(payment => inRange(payment.paymentDate, range.previousFrom, range.previousTo, true));
  const received = sum(currentPayments, payment => payment.amount), priorReceived = sum(priorPayments, payment => payment.amount);
  const delta = priorReceived > 0 ? Math.round((received - priorReceived) / priorReceived * 100) : null;
  const bucketCount = period === 'this_year' ? Number(range.to.slice(5, 7)) : Number(range.to.slice(8));
  const trend = Array.from({ length: bucketCount }, (_, i) => ({ label: period === 'this_year' ? `${range.from.slice(0, 4)}-${String(i + 1).padStart(2, '0')}` : `${range.from.slice(0, 8)}${String(i + 1).padStart(2, '0')}`, amount: 0 }));
  for (const payment of currentPayments) {
    const key = payment.paymentDate.toISOString().slice(0, period === 'this_year' ? 7 : 10);
    const bucket = trend.find(point => point.label === key); if (bucket) bucket.amount += payment.amount;
  }
  const nextBySource = new Map(documents.filter(doc => doc.sourceId && eligible(doc)).map(doc => [doc.sourceId!, doc]));
  const stages = (['quotation', 'order', 'sale'] as const).map(kind => {
    const rows = selected.filter(doc => doc.kind === kind && eligible(doc) && (kind !== 'sale' || doc.status === 'issued'));
    const converted = kind === 'sale' ? 0 : rows.filter(doc => nextBySource.has(doc.id)).length;
    return { kind, count: rows.length, value: sum(rows, doc => doc.total), converted, conversionRate: rows.length ? Math.round(converted / rows.length * 100) : null };
  });
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  const activity = [
    ...documents.map(doc => ({ id: `document:${doc.id}`, documentId: doc.id, kind: 'document' as const, documentKind: doc.kind, name: (doc.customerSnapshot as { name?: string })?.name ?? 'Customer', number: doc.number, date: (doc.updatedAt ?? doc.createdAt).toISOString(), documentDate: doc.documentDate.toISOString().slice(0, 10), dueDate: doc.dueDate?.toISOString().slice(0, 10) ?? null, amount: doc.total, remaining: remaining(doc), status: paymentStatus(doc, now) ?? doc.status, overdueDays: paymentStatus(doc, now) === 'overdue' ? Math.max(0, Math.floor((atDay(today).getTime() - atDay(doc.dueDate!.toISOString().slice(0, 10)).getTime()) / 86400000)) : 0 })),
    ...validPayments.map(payment => { const doc = byId.get(payment.documentId)!; return { id: `payment:${payment.id}`, documentId: doc.id, kind: 'payment' as const, documentKind: doc.kind, name: (doc.customerSnapshot as { name?: string })?.name ?? 'Customer', number: doc.number, date: payment.createdAt.toISOString(), documentDate: payment.paymentDate.toISOString().slice(0, 10), dueDate: null, amount: payment.amount, remaining: 0, status: 'received', overdueDays: 0 }; }),
    ...(input.expenses??[]).map(expense=>({id:`expense:${expense.id}`,documentId:'',expenseId:expense.id,kind:'expense' as const,documentKind:'expense',name:expense.vendor||expense.title,number:expense.title,date:(expense.updatedAt??expense.paidAt??expense.createdAt).toISOString(),documentDate:dayKey(expense.status==='paid'?(expense.paidAt??expense.createdAt):expense.createdAt),dueDate:null,amount:expense.amount,remaining:expense.status==='paid'?0:expense.amount,status:expense.status,overdueDays:0})),
  ].sort((a, b) => b.date.localeCompare(a.date)||b.id.localeCompare(a.id));
  const lowStock = stockEnabled ? items.filter(item => item.isActive && item.quantity <= item.reorderLevel) : [];
  const suggestions: Array<{ id: string; title: string; body: string; action: 'overdue' | 'collections' | 'stock'; cta: string; tone: 'amber' | 'teal' | 'blue' }> = [];
  if (overdueSales.length) suggestions.push({ id: 'overdue', title: `${overdueSales.length} invoice${overdueSales.length === 1 ? '' : 's'} overdue`, body: `${overdue.toLocaleString('en-US')} BDT outstanding. Review the invoices and follow up with your customers.`, action: 'overdue', cta: 'Review overdue', tone: 'amber' });
  suggestions.push({ id: 'collections', title: delta === null ? 'Your collections at a glance' : `Collections ${delta >= 0 ? 'up' : 'down'} ${Math.abs(delta)}%`, body: `${received.toLocaleString('en-US')} BDT received ${period === 'last_month' ? 'last month' : period === 'this_year' ? 'this year' : 'this month'}${delta === null ? '.' : ' compared with the same elapsed period before.'}`, action: 'collections', cta: 'View collections', tone: 'teal' });
  if (lowStock.length) suggestions.push({ id: 'stock', title: `${lowStock.length} item${lowStock.length === 1 ? '' : 's'} running low`, body: `${lowStock.slice(0, 2).map(item => item.name).join(' and ')}${lowStock.length > 2 ? ` and ${lowStock.length - 2} more` : ''} at or below reorder level.`, action: 'stock', cta: 'Review stock', tone: 'blue' });
  const hasSent = documents.some(doc => eligible(doc) && !['draft'].includes(doc.status));
  const steps = [{ id: 'profile', label: 'Business profile', done: true }, { id: 'customer', label: 'Add your first customer', done: customers > 0 }, { id: 'document', label: 'Send a quote or invoice', done: hasSent }, { id: 'payment', label: 'Record a payment', done: validPayments.length > 0 }];
  return { period, range, metrics: { invoiced, collected, outstanding, due: Math.max(0, outstanding - overdue), overdue, received, priorReceived, collectionChange: delta, overdueCount: overdueSales.length }, trend, pipeline: { stages, count: sum(stages, stage => stage.count) }, suggestions, setup: { isNew: allSales.length === 0, completed: steps.filter(step => step.done).length, steps }, activity: { all: activity.slice(0, 20), unpaid: activity.filter(row => row.kind === 'expense'?['pending','approved'].includes(row.status):row.kind === 'document' && ['unpaid', 'partial', 'overdue'].includes(row.status)).slice(0, 20), paid: activity.filter(row => ['paid', 'received'].includes(row.status)).slice(0, 20) } };
}
