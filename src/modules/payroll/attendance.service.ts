import type { z } from 'zod';
import type { PayrollAttendance } from '@prisma/client';
import { badRequest, conflict } from '../../core/http/api-error.js';
import { financialTransaction } from '../accounting/transaction.js';
import { json } from '../billing/billing.policy.js';
import { day, atDate, today } from './payroll.policy.js';
import { attendanceConfig, scope, access, allowed, ownEmployee, employee, project, mutate, revision, history, audit, rebuild, type Tx, type PayrollAuth } from './payroll.service.js';
import { officeDistance, dhakaClock, isDayOff, type AttendanceSettings, type attendanceMarkSchema, type attendancePunchSchema } from './attendance.policy.js';
export function mapAttendance(row: PayrollAttendance) { return { id: row.id, employeeId: row.employeeId, date: day(row.date), status: row.status, checkIn: row.checkIn?.toISOString() ?? null, checkOut: row.checkOut?.toISOString() ?? null, source: row.source, officeVerified: row.officeVerified, revision: row.revision, history: row.history }; }
async function unpaidMonth(tx: Tx, a: PayrollAuth, date: string) {
  const paid = await tx.payrollRun.findFirst({ where: { ...scope(a), month: date.slice(0, 7), status: 'paid' } });
  if (paid) throw conflict(`Payroll for ${paid.month} is already paid. Attendance changes require an explicit payroll adjustment.`);
}
async function workingDay(tx: Tx, a: PayrollAuth, employeeId: string, date: string, settings: AttendanceSettings) {
  if (isDayOff(date, settings)) throw conflict('Attendance cannot be changed on a weekend or holiday');
  const leave = await tx.payrollLeave.findFirst({ where: { ...scope(a), employeeId, status: 'approved', workingDates: { has: date } } });
  if (leave) throw conflict('This employee is on approved leave for this date');
}
export async function markAttendance(a: PayrollAuth, b: z.infer<typeof attendanceMarkSchema>) {
  allowed(access(a).manage || access(a).check, 'Only project managers and accountants can correct attendance');
  return mutate(a, 'attendance.mark', b, async tx => {
    const person = await employee(tx, a, b.employee_id);
    if (b.date > today() || b.date < day(person.joiningDate)) throw badRequest('Choose a date between joining and today');
    await unpaidMonth(tx, a, b.date);
    await workingDay(tx, a, person.id, b.date, await attendanceConfig(tx, a));
    const old = await tx.payrollAttendance.findFirst({ where: { ...scope(a), employeeId: person.id, date: atDate(b.date) } });
    if (old) { if (b.revision === null) throw conflict('Attendance was recorded. Refresh before correcting it.'); revision(old.revision, b.revision); }
    else if (b.revision !== null) throw conflict('Attendance changed. Refresh before correcting it.');
    const value = { status: b.status, source: 'manual', history: json(await history(tx, a, `Marked ${b.status}`, old?.history, b.reason)) };
    const row = old ? await tx.payrollAttendance.update({ where: { id: old.id }, data: { ...value, revision: { increment: 1 } } }) : await tx.payrollAttendance.create({ data: { ...scope(a), employeeId: person.id, date: atDate(b.date), ...value } });
    await rebuild(tx, a, 'Reprepared after attendance correction');
    await audit(tx, a, 'attendance.corrected', 'payroll_attendance', row.id, { employeeId: person.id, date: b.date, before: old?.status ?? null, status: row.status, reason: b.reason });
    return mapAttendance(row);
  });
}
export async function punchAttendance(a: PayrollAuth, b: z.infer<typeof attendancePunchSchema>) {
  allowed(access(a).staff || access(a).member);
  return mutate(a, `attendance.${b.action}`, b, async tx => {
    const person = await ownEmployee(tx, a);
    if (!person || person.status === 'inactive') throw conflict('Link an active employee profile before checking in');
    const date = today(), now = new Date(), settings = await attendanceConfig(tx, a);
    if (date < day(person.joiningDate)) throw conflict('You cannot check in before your joining date');
    await unpaidMonth(tx, a, date); await workingDay(tx, a, person.id, date, settings);
    const old = await tx.payrollAttendance.findFirst({ where: { ...scope(a), employeeId: person.id, date: atDate(date) } });
    if (b.action === 'in' && old) throw conflict('Attendance is already recorded for today. Ask HR to correct it if needed.');
    if (b.action === 'out' && (!old?.checkIn || old.checkOut)) throw conflict('Check in first; a completed check-out cannot be repeated');
    let officeVerified = false;
    if (settings.gpsRequired) {
      if (settings.latitude === null || settings.longitude === null) throw conflict('The owner must configure the office location before GPS check-in');
      const l = b.location;
      if (!l || l.mocked || Math.abs(now.getTime() - new Date(l.captured_at).getTime()) > 120000 || l.accuracy > Math.min(settings.radiusM, 100)) throw badRequest('A fresh, accurate device location is required. Enable precise location and try again.');
      if (officeDistance(l.latitude, l.longitude, settings.latitude, settings.longitude) > settings.radiusM) throw conflict('You are outside the configured office check-in area');
      officeVerified = true;
    }
    const entry = json(await history(tx, a, b.action === 'in' ? 'Checked in' : 'Checked out', old?.history, officeVerified ? 'Office location verified' : 'Location not required'));
    const row = b.action === 'in' ? await tx.payrollAttendance.create({ data: { ...scope(a), employeeId: person.id, date: atDate(date), checkIn: now, status: dhakaClock(now) > settings.lateAfter ? 'late' : 'present', source: 'phone', officeVerified, history: entry } }) : await tx.payrollAttendance.update({ where: { id: old!.id }, data: { checkOut: now, revision: { increment: 1 }, history: entry } });
    await rebuild(tx, a, 'Reprepared after employee attendance');
    // Coordinates are checked transiently and are not stored in attendance or audit records.
    await audit(tx, a, `attendance.checked_${b.action}`, 'payroll_attendance', row.id, { employeeId: person.id, officeVerified });
    return mapAttendance(row);
  });
}
export async function saveAttendanceSettings(a: PayrollAuth, b: AttendanceSettings) {
  allowed(access(a).manage);
  return financialTransaction(async tx => {
    await project(tx, a);
    const old = await attendanceConfig(tx, a); revision(old.revision, b.revision);
    // Holidays can remove a salary deduction; paid salary snapshots must remain immutable.
    const before = new Set(old.holidays.map(h => h.date)), after = new Set(b.holidays.map(h => h.date));
    const months = [...new Set([...before, ...after].filter(d => before.has(d) !== after.has(d)).map(d => d.slice(0, 7)))];
    if (months.length && await tx.payrollRun.findFirst({ where: { ...scope(a), status: 'paid', month: { in: months } } })) throw conflict('A holiday change affects a paid salary month. Record a payroll adjustment before changing it.');
    const value = { ...b, revision: b.revision + 1 };
    await tx.payrollAttendanceConfiguration.upsert({ where: { projectId: a.projectId }, create: { ...scope(a), settings: json(value), revision: value.revision }, update: { settings: json(value), revision: value.revision } });
    await rebuild(tx, a, 'Reprepared after attendance holidays changed');
    await audit(tx, a, 'attendance.settings_saved', 'project', a.projectId, { shiftStart: b.shiftStart, shiftEnd: b.shiftEnd, lateAfter: b.lateAfter, gpsRequired: b.gpsRequired, officeName: b.officeName, radiusM: b.radiusM, holidays: b.holidays });
    return value;
  }, 30000);
}
