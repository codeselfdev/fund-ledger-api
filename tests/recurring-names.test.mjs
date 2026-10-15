import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'recurring-names-isolated-test';
const { scheduleNameForOccurrence, computeNextRunAt } = await import('../dist/modules/recurring-schedules/recurring-schedules.service.js');
const date = (year, month, day) => new Date(year, month - 1, day, 0, 0, 0);
test('weekly runs advance through the month instead of repeating 1W', () => {
  let run = date(2026, 10, 6);
  const start = run;
  const names = [];
  for (let i = 0; i < 5; i++) {
    names.push(scheduleNameForOccurrence('weekly', run));
    run = computeNextRunAt(run, 'weekly', start);
  }
  assert.deepEqual(names, ['1W OCT 26', '2W OCT 26', '3W OCT 26', '4W OCT 26', '1W NOV 26']);
});
test('weekly names cover month boundaries, a fifth week, leap days and years', () => {
  for (const [year, month, day, expected] of [
    [2026, 10, 7, '1W OCT 26'], [2026, 10, 8, '2W OCT 26'],
    [2026, 10, 14, '2W OCT 26'], [2026, 10, 15, '3W OCT 26'],
    [2026, 10, 21, '3W OCT 26'], [2026, 10, 22, '4W OCT 26'],
    [2026, 10, 28, '4W OCT 26'], [2026, 10, 29, '5W OCT 26'],
    [2024, 2, 29, '5W FEB 24'], [2026, 12, 31, '5W DEC 26'], [2027, 1, 1, '1W JAN 27'],
  ]) assert.equal(scheduleNameForOccurrence('weekly', date(year, month, day)), expected);
});
test('other frequencies retain their naming and run intervals', () => {
  const run = date(2026, 10, 13);
  for (const [frequency, expected] of [['biweekly', '2W OCT 26'], ['monthly', 'OCT 26'], ['bimonthly', '2M OCT 26'], ['quarterly', 'Q4 26'], ['yearly', 'YR 26']]) {
    assert.equal(scheduleNameForOccurrence(frequency, run), expected);
  }
  assert.equal(computeNextRunAt(run, 'weekly', run).getDate(), 20);
  assert.equal(computeNextRunAt(run, 'biweekly', run).getDate(), 27);
});
