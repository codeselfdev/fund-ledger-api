import assert from 'node:assert/strict';
import test from 'node:test';
import { openingDueView, openingScheduleView, dueRemaining } from '../dist/modules/schedules/schedule-summary.service.js';

const due = (extra = {}) => ({ id: 'due', memberId: 'member', amount: 2131000,
  paidAmount: 1795000, waivedAmount: 0, penaltyDue: 0, penaltyPaid: 0, ...extra });
const profile = { opening_import: { previous_paid: 1795000, as_of_date: '2025-10-16' } };

test('opening projection removes imported paid history without changing raw dues or remaining', () => {
  const raw = due();
  const projected = openingDueView(raw, profile);
  assert.equal(projected.due.amount, 336000);
  assert.equal(projected.due.paidAmount, 0);
  assert.equal(dueRemaining(projected.due), dueRemaining(raw));
  assert.equal(raw.amount, 2131000);
  assert.equal(raw.paidAmount, 1795000);
  assert.deepEqual(projected.opening_balance, { original_due: 336000, historical_paid: 1795000, recovered: 0, as_of_date: '2025-10-16' });
});

test('only original debtors count; fully settled debtors remain available in Paid and All', () => {
  const raw = [due(), due({ id: 'never-owed', memberId: 'clear', paidAmount: 2131000 })];
  const members = [{ id: 'member', profile }, { id: 'clear', profile: { opening_import: { previous_paid: 2131000 } } }];
  let view = openingScheduleView(raw, members, new Map([['due', { amount: 100000 }]]));
  assert.equal(view.rows.length, 1);
  assert.deepEqual(view.collection, { total: 336000, collected: 0, remaining: 336000, pending: 100000, waived: 0, dues_count: 1, paid_count: 0, collected_percent: 0 });
  raw[0].paidAmount += 336000;
  view = openingScheduleView(raw, members, new Map());
  assert.equal(view.rows.length, 1);
  assert.equal(view.collection.remaining, 0);
  assert.equal(view.collection.paid_count, 1);
  assert.equal(view.collection.collected_percent, 100);
  assert.equal(view.opening_balance.recovered, 336000);
  assert.equal(view.opening_balance.historical_paid, 3926000);
});

test('waivers and penalties reconcile without counting waivers as recovered money', () => {
  const raw = due({ paidAmount: 1895000, waivedAmount: 36000, penaltyDue: 300, penaltyPaid: 100 });
  const view = openingScheduleView([raw], [{ id: 'member', profile }], new Map());
  assert.equal(view.collection.total, 300300);
  assert.equal(view.collection.collected, 100100);
  assert.equal(view.collection.remaining, 200200);
  assert.equal(view.collection.waived, 36000);
  assert.equal(dueRemaining(raw), view.collection.remaining);
});

test('legacy opening dues without import metadata remain payable and malformed metadata cannot create negative balances', () => {
  for (const value of [undefined, null, {}, { opening_import: { previous_paid: '-' } }, { opening_import: { previous_paid: -1 } }]) {
    const projected = openingDueView(due(), value);
    assert.equal(projected.opening_balance.historical_paid, 0);
    assert.equal(dueRemaining(projected.due), 336000);
  }
  const clamped = openingDueView(due(), { opening_import: { previous_paid: 9999999 } });
  assert.equal(clamped.due.paidAmount, 0);
  assert.equal(clamped.due.amount, 336000);
  assert.equal(openingScheduleView([], [], new Map()).collection.dues_count, 0);
});
