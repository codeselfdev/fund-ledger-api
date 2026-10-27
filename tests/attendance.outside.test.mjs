import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:55439/payroll_test';
process.env.JWT_SECRET ??= 'disposable-payroll-tests';
const p = await import('../dist/modules/payroll/attendance.policy.js');
const base = { employee_id: 'e1', date: '2026-10-26', status: 'present', reason: 'Client site visit', revision: null, request_key: '6f1c2d7e-1111-4a2b-9c3d-123456789abc' };
test('HR can record outside work with times, but not as absence or without a place', () => {
  assert.equal(p.attendanceMarkSchema.safeParse({ ...base, outside: true, place: 'Gulshan client office', check_in: '09:40', check_out: '17:30' }).success, true);
  assert.equal(p.attendanceMarkSchema.safeParse({ ...base, outside: true }).success, false);
  assert.equal(p.attendanceMarkSchema.safeParse({ ...base, status: 'absent', outside: true, place: 'Site' }).success, false);
  assert.equal(p.attendanceMarkSchema.safeParse({ ...base, check_in: '18:00', check_out: '09:00' }).success, false);
  assert.equal(p.attendanceMarkSchema.safeParse({ ...base, check_out: '17:00' }).success, false);
  assert.equal(p.attendanceMarkSchema.safeParse({ ...base, check_in: '25:00' }).success, false);
  assert.equal(p.attendanceMarkSchema.safeParse(base).success, true);
  assert.equal(p.dhakaAt('2026-10-26', '09:40').toISOString(), '2026-10-26T03:40:00.000Z');
});
const policy = await import('../dist/modules/payroll/payroll.policy.js');
test('office days and leave allowances are configurable, defaulting to a Friday weekend', () => {
  const s = { shiftStart: '09:00', shiftEnd: '18:00', lateAfter: '09:15', gpsRequired: true, officeName: 'HQ', latitude: 23.7, longitude: 90.4, radiusM: 150, holidays: [], revision: 0 };
  const parsed = p.attendanceSettingsSchema.parse(s);
  assert.deepEqual(parsed.weekendDays, [5]); assert.deepEqual(parsed.leaveAllowance, { Annual: 20, Sick: 14, Casual: 10 });
  assert.equal(p.attendanceSettingsSchema.safeParse({ ...s, weekendDays: [5, 5] }).success, false);
  assert.equal(p.attendanceSettingsSchema.safeParse({ ...s, weekendDays: [0, 1, 2, 3, 4, 5, 6] }).success, false);
  assert.equal(p.isDayOff('2026-10-24', { holidays: [], weekendDays: [5, 6] }), true); // Saturday
  assert.equal(p.isDayOff('2026-10-24', { holidays: [] }), false);
  assert.deepEqual(policy.workingDates('2026-10-29', 3, [5, 6]), ['2026-10-29', '2026-11-01', '2026-11-02']);
  assert.equal(policy.leaveLeft([{ type: 'Annual', status: 'approved', days: 4, startDate: new Date('2026-03-01') }], '2026', false, { Annual: 15, Sick: 10, Casual: 5 }).Annual, 11);
});
const r = await import('../dist/modules/payroll/attendance.requests.js');
const personal = await import('../dist/core/security/payroll-personal-routes.js');
test('employees outside the GPS area can request check-in/out; rejections need a reason', () => {
  const key = '6f1c2d7e-1111-4a2b-9c3d-123456789abc';
  assert.equal(r.attendanceRequestSchema.safeParse({ action: 'in', reason: 'Client meeting in Uttara', request_key: key }).success, true);
  assert.equal(r.attendanceRequestSchema.safeParse({ action: 'in', reason: 'x', request_key: key }).success, false);
  assert.equal(r.attendanceRequestSchema.safeParse({ action: 'in', reason: 'Visit', latitude: 1, request_key: key }).success, false);
  assert.equal(r.attendanceRequestDecisionSchema.safeParse({ decision: 'reject', request_key: key }).success, false);
  assert.equal(r.attendanceRequestDecisionSchema.safeParse({ decision: 'approve', request_key: key }).success, true);
  // Members may create their own request; deciding stays a staff route.
  assert.equal(personal.payrollPersonalRoute('/v1/payroll/attendance/requests', 'POST'), true);
  assert.equal(personal.payrollPersonalRoute('/v1/payroll/attendance/requests/x/decision', 'POST'), false);
  const row = r.mapAttendanceRequest({ id: 'q', employeeId: 'e', employee: { name: 'Sadia' }, date: new Date('2026-10-27T00:00:00Z'), action: 'in', requestedAt: new Date('2026-10-27T03:40:00Z'), reason: 'Site', distanceM: 820, accuracyM: 12, status: 'pending', decisionNote: null, decidedAt: null });
  assert.deepEqual([row.date, row.name, row.distanceM, row.decidedAt], ['2026-10-27', 'Sadia', 820, null]);
  assert.equal('latitude' in row, false);
});
test('a wrong joining date can be corrected with a reason', () => {
  const key = '6f1c2d7e-1111-4a2b-9c3d-123456789abc';
  assert.equal(policy.joiningDateSchema.safeParse({ joining_date: '2026-10-01', revision: 0, reason: 'Imported with next month by mistake', request_key: key }).success, true);
  assert.equal(policy.joiningDateSchema.safeParse({ joining_date: '2026-10-01', revision: 0, reason: '', request_key: key }).success, false);
  assert.equal(policy.joiningDateSchema.safeParse({ joining_date: '2026-13-01', revision: 0, reason: 'Fix', request_key: key }).success, false);
});
