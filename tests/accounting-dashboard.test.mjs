import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountingDashboard as build, dashboardRange } from '../dist/modules/accounting/dashboard.js';
const now = new Date('2026-10-20T20:00:00Z');
const doc = (id, extra = {}) => ({ id, tenantId: 't', projectId: 'p', kind: 'sale', status: 'issued', total: 1000, paidAmount: 0, documentDate: new Date('2026-10-02'), dueDate: new Date('2026-10-10'), customerSnapshot: { name: 'Test customer' }, number: id, sourceId: null, createdAt: new Date('2026-10-02'), updatedAt: new Date('2026-10-02'), ...extra });
const pay = (id, documentId, amount, date = '2026-10-03') => ({ id, documentId, amount, paymentDate: new Date(date), createdAt: new Date(date) });
const input = extra => ({ documents: [], payments: [], items: [], customers: 0, stockEnabled: true, period: 'this_month', now, ...extra });
test('Dhaka calendar boundaries, year rollover and leap day comparisons', () => {
  assert.deepEqual(dashboardRange('this_month', now), { from: '2026-10-01', to: '2026-10-21', previousFrom: '2026-09-01', previousTo: '2026-09-21' });
  assert.equal(dashboardRange('last_month', new Date('2026-01-01T00:00Z')).from, '2025-12-01');
  assert.equal(dashboardRange('last_month', new Date('2026-03-15T00:00Z')).to, '2026-02-28');
  assert.equal(dashboardRange('this_year', new Date('2024-02-29T00:00Z')).previousTo, '2023-02-28');
});
test('invoice cohorts conserve collected + due + overdue and exclude drafts/cancellations', () => {
  const data = build(input({ documents: [doc('late', { paidAmount: 300 }), doc('due', { total: 600, dueDate: new Date('2026-11-01') }), doc('paid', { paidAmount: 1000 }), doc('draft', { status: 'draft' }), doc('cancelled', { status: 'cancelled' }), doc('previous', { documentDate: new Date('2026-09-01') })] }));
  assert.equal(data.metrics.invoiced, 2600); assert.equal(data.metrics.collected, 1300); assert.equal(data.metrics.overdue, 700); assert.equal(data.metrics.due, 600);
  assert.equal(data.metrics.collected + data.metrics.due + data.metrics.overdue, data.metrics.invoiced);
});
test('trend and comparisons use actual payment dates, including receipts for earlier invoices', () => {
  const data = build(input({ documents: [doc('old', { documentDate: new Date('2026-09-01'), paidAmount: 1000 })], payments: [pay('one', 'old', 600), pay('two', 'old', 300, '2026-09-03'), pay('future-comparison', 'old', 999, '2026-09-30')] }));
  assert.equal(data.metrics.invoiced, 0); assert.equal(data.metrics.received, 600); assert.equal(data.metrics.priorReceived, 300); assert.equal(data.metrics.collectionChange, 100);
  assert.equal(data.trend.reduce((total, point) => total + point.amount, 0), 600); assert.equal(data.trend[2].amount, 600);
});
test('conversion rates follow real source links, rather than unrelated stage counts', () => {
  const documents = [doc('q1', { kind: 'quotation', status: 'converted' }), doc('q2', { kind: 'quotation', status: 'sent' }), doc('o1', { kind: 'order', status: 'converted', sourceId: 'q1' }), doc('o2', { kind: 'order', status: 'confirmed' }), doc('sale', { sourceId: 'o1' }), doc('direct-sale'), doc('cancelled-order', { kind: 'order', sourceId: 'q2', status: 'cancelled' })];
  const data = build(input({ documents })); assert.equal(data.pipeline.stages[0].conversionRate, 50); assert.equal(data.pipeline.stages[1].conversionRate, 50); assert.equal(data.pipeline.stages[2].value, 2000);
});
test('filters operate over all activity, never just the first five rows; cancelled sales are not unpaid', () => {
  const documents = [doc('cancelled', { status: 'cancelled' }), doc('draft', { status: 'draft' }), ...Array.from({ length: 8 }, (_, i) => doc('d' + i)), doc('paid', { paidAmount: 1000 })];
  const data = build(input({ documents, payments: [pay('p', 'paid', 1000)] }));
  assert.equal(data.activity.unpaid.length, 8); assert.equal(data.activity.paid.length, 2); assert.ok(data.activity.unpaid.every(row => row.status === 'overdue')); assert.equal(data.activity.unpaid[0].overdueDays, 11);
});
test('new businesses have a real setup checklist and no invented conversion rates or trends', () => {
  const data = build(input()); assert.equal(data.setup.isNew, true); assert.equal(data.setup.completed, 1); assert.equal(data.metrics.collectionChange, null); assert.ok(data.pipeline.stages.every(stage => stage.conversionRate === null)); assert.ok(data.trend.every(point => point.amount === 0)); assert.deepEqual(data.activity.all, []);
});
test('stock suggestions obey stock configuration and active item reorder levels', () => {
  const items = [{ name: 'Low', quantity: 1, reorderLevel: 2, isActive: true }, { name: 'Inactive', quantity: 0, reorderLevel: 2, isActive: false }, { name: 'Healthy', quantity: 3, reorderLevel: 2, isActive: true }];
  assert.match(build(input({ items })).suggestions.find(s => s.action === 'stock').title, /^1 item/);
  assert.ok(!build(input({ items, stockEnabled: false })).suggestions.some(s => s.action === 'stock'));
});


test('expense activity uses payment/post timestamps, keeps correct status filters and leaves sales metrics unchanged',()=>{
 const expense=(id,status)=>({id,title:'Lunch',vendor:'Cafe',amount:8800,status,expenseDate:new Date('2025-03-25'),paidAt:status==='paid'?new Date('2026-10-20'):null,createdAt:new Date('2026-10-19'),updatedAt:new Date('2026-10-20')});
 const data=build(input({expenses:['paid','pending','approved','draft'].map(status=>expense(status,status))}));
 assert.equal(data.activity.all.length,4);assert.equal(data.activity.paid.length,1);assert.equal(data.activity.paid[0].expenseId,'paid');assert.equal(data.activity.paid[0].documentDate,'2026-10-20');assert.equal(data.activity.unpaid.length,2);assert.equal(data.metrics.invoiced,0);assert.equal(data.metrics.received,0);
});
