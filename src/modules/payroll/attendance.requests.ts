import { z } from 'zod';
import type { PayrollAttendanceRequest } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { json, requestKey, id } from '../billing/billing.policy.js';
import { records } from './portal.store.js';
import type { OfficeProject } from './portal.types.js';
import { day, atDate, today } from './payroll.policy.js';
import { attendanceConfig, scope, access, allowed, ownEmployee, mutate, history, audit, rebuild, type Tx, type PayrollAuth } from './payroll.service.js';
import { officeDistance, dhakaClock, isDayOff, type AttendanceSettings } from './attendance.policy.js';
import { mapAttendance } from './attendance.service.js';

/**
 * When an employee's GPS does not match the office or an assigned site, they can send their
 * check-in/out for HR approval instead of being blocked. Only the distance to the nearest
 * check-in area is kept; coordinates are never stored.
 */
const location = z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), accuracy: z.number().finite().min(0).max(5000), captured_at: z.string().datetime(), mocked: z.boolean().optional() }).strict();
export const attendanceRequestSchema = z.object({ action: z.enum(['in', 'out']), reason: z.string().trim().min(3).max(500), location: location.optional(), request_key: requestKey }).strict();
export const attendanceRequestDecisionSchema = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).default(''), request_key: requestKey }).strict()
  .refine(b => b.decision === 'approve' || b.note.length >= 3, 'Give a reason for rejecting the request');

export function mapAttendanceRequest(r: PayrollAttendanceRequest & { employee?: { name: string } }) {
  return { id: r.id, employeeId: r.employeeId, name: r.employee?.name ?? '', date: day(r.date), action: r.action as 'in' | 'out', requestedAt: r.requestedAt.toISOString(), reason: r.reason,
    distanceM: r.distanceM, accuracyM: r.accuracyM, status: r.status as 'pending' | 'approved' | 'rejected', decisionNote: r.decisionNote, decidedAt: r.decidedAt?.toISOString() ?? null };
}
async function nearestZone(tx: Tx, a: PayrollAuth, employeeId: string, date: string, settings: AttendanceSettings, l?: z.infer<typeof location>) {
  if (!l || l.mocked || Math.abs(Date.now() - new Date(l.captured_at).getTime()) > 120000) return { distanceM: null, accuracyM: null };
  const sites = (await records<OfficeProject>(tx, a, 'office_project')).map(r => r.data).filter(p => p.status === 'active' && p.site === 'site' && p.startDate <= date && p.endDate >= date && p.team.some(t => t.employeeId === employeeId) && p.latitude !== null && p.longitude !== null);
  const zones = [...(settings.latitude !== null && settings.longitude !== null ? [{ latitude: settings.latitude, longitude: settings.longitude }] : []), ...sites.map(p => ({ latitude: p.latitude!, longitude: p.longitude! }))];
  const distances = zones.map(z => officeDistance(l.latitude, l.longitude, z.latitude, z.longitude));
  return { distanceM: distances.length ? Math.round(Math.min(...distances)) : null, accuracyM: Math.round(l.accuracy) };
}

export async function requestAttendance(a: PayrollAuth, b: z.infer<typeof attendanceRequestSchema>) {
  allowed(access(a).staff || access(a).member);
  return mutate(a, `attendance.request.${b.action}`, b, async tx => {
    const person = await ownEmployee(tx, a);
    if (!person || person.status === 'inactive') throw conflict('Link an active employee profile before checking in');
    const date = today(), settings = await attendanceConfig(tx, a);
    if (date < day(person.joiningDate)) throw conflict('You cannot check in before your joining date');
    if (isDayOff(date, settings)) throw conflict('Today is a weekend or holiday');
    if (await tx.payrollRun.findFirst({ where: { ...scope(a), month: date.slice(0, 7), status: 'paid' } })) throw conflict('This month’s payroll is already paid');
    if (await tx.payrollLeave.findFirst({ where: { ...scope(a), employeeId: person.id, status: 'approved', workingDates: { has: date } } })) throw conflict('You are on approved leave today');
    const record = await tx.payrollAttendance.findFirst({ where: { ...scope(a), employeeId: person.id, date: atDate(date) } });
    const open = await tx.payrollAttendanceRequest.findMany({ where: { ...scope(a), employeeId: person.id, date: atDate(date), status: { in: ['pending', 'approved'] } } });
    if (open.some(r => r.action === b.action && r.status === 'pending')) throw conflict(`Your check-${b.action} request is already waiting for approval`);
    if (b.action === 'in' && (record || open.some(r => r.action === 'in'))) throw conflict('Today’s check-in is already recorded or requested');
    if (b.action === 'out') {
      if (record?.checkOut || open.some(r => r.action === 'out')) throw conflict('Today’s check-out is already recorded or requested');
      if (!record?.checkIn && !open.some(r => r.action === 'in')) throw conflict('Check in or request a check-in first');
    }
    const zone = await nearestZone(tx, a, person.id, date, settings, b.location);
    const row = await tx.payrollAttendanceRequest.create({ data: { ...scope(a), employeeId: person.id, date: atDate(date), action: b.action, requestedAt: new Date(), reason: b.reason, ...zone, createdById: a.userId }, include: { employee: { select: { name: true } } } });
    await audit(tx, a, `attendance.requested_${b.action}`, 'payroll_attendance_request', row.id, { employeeId: person.id, distanceM: zone.distanceM });
    return mapAttendanceRequest(row);
  });
}

export async function decideAttendanceRequest(a: PayrollAuth, requestId: string, b: z.infer<typeof attendanceRequestDecisionSchema>) {
  allowed(access(a).manage || access(a).check, 'Only project managers and accountants can decide attendance requests');
  return mutate(a, `attendance.request:${requestId}`, b, async tx => {
    const req = await tx.payrollAttendanceRequest.findFirst({ where: { id: requestId, ...scope(a) }, include: { employee: { select: { name: true, userId: true } } } });
    if (!req) throw notFound('Attendance request not found');
    if (req.status !== 'pending') throw conflict('This request was already decided');
    if (req.employee.userId === a.userId) throw conflict('Ask another manager or accountant to decide your own request');
    const date = day(req.date);
    if (b.decision === 'approve') {
      if (await tx.payrollRun.findFirst({ where: { ...scope(a), month: date.slice(0, 7), status: 'paid' } })) throw conflict('That month’s payroll is already paid');
      const settings = await attendanceConfig(tx, a);
      const record = await tx.payrollAttendance.findFirst({ where: { ...scope(a), employeeId: req.employeeId, date: req.date } });
      const note = `Approved request · ${req.reason}${req.distanceM !== null ? ` · ${req.distanceM} m from the check-in area` : ''}`;
      if (req.action === 'in') {
        if (record) throw conflict('Attendance for that day is already recorded. Reject this request or correct the record instead.');
        const row = await tx.payrollAttendance.create({ data: { ...scope(a), employeeId: req.employeeId, date: req.date, checkIn: req.requestedAt, status: dhakaClock(req.requestedAt) > settings.lateAfter ? 'late' : 'present', source: 'request', officeVerified: false, history: json(await history(tx, a, 'Check-in approved', [], note)) } });
        await audit(tx, a, 'attendance.request_approved', 'payroll_attendance', row.id, { requestId, action: 'in' });
      } else {
        if (await tx.payrollAttendanceRequest.findFirst({ where: { ...scope(a), employeeId: req.employeeId, date: req.date, action: 'in', status: 'pending' } })) throw conflict('Decide the check-in request for that day first');
        if (!record?.checkIn) throw conflict('There is no check-in for that day. Reject this request or record the day instead.');
        if (record.checkOut) throw conflict('Check-out is already recorded for that day');
        if (req.requestedAt <= record.checkIn) throw badRequest('The requested check-out is before the check-in');
        await tx.payrollAttendance.update({ where: { id: record.id }, data: { checkOut: req.requestedAt, revision: { increment: 1 }, history: json(await history(tx, a, 'Check-out approved', record.history, note)) } });
        await audit(tx, a, 'attendance.request_approved', 'payroll_attendance', record.id, { requestId, action: 'out' });
      }
    }
    const row = await tx.payrollAttendanceRequest.update({ where: { id: req.id }, data: { status: b.decision === 'approve' ? 'approved' : 'rejected', decisionNote: b.note || null, decidedById: a.userId, decidedAt: new Date() }, include: { employee: { select: { name: true } } } });
    if (b.decision === 'approve') await rebuild(tx, a, 'Reprepared after an attendance request was approved');
    else await audit(tx, a, 'attendance.request_rejected', 'payroll_attendance_request', req.id, { note: b.note });
    return mapAttendanceRequest(row);
  });
}
export { mapAttendance };
