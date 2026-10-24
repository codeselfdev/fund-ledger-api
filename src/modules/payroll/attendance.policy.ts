import { z } from 'zod';
import { dateSchema } from '../accounting/workflow.js';
import { requestKey, id } from '../billing/billing.policy.js';
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const attendanceSettingsSchema = z.object({
  shiftStart: clock, shiftEnd: clock, lateAfter: clock,
  gpsRequired: z.literal(true), officeName: z.string().trim().min(1).max(160),
  latitude: z.number().finite().min(-90).max(90).nullable(), longitude: z.number().finite().min(-180).max(180).nullable(),
  radiusM: z.number().int().min(25).max(5000),
  holidays: z.array(z.object({ date: dateSchema, name: z.string().trim().min(1).max(120) }).strict()).max(100),
  revision: z.number().int().nonnegative()
}).strict().refine(s => s.shiftStart < s.shiftEnd && s.lateAfter >= s.shiftStart && s.lateAfter < s.shiftEnd, 'Use a same-day shift with the late threshold between start and end')
.refine(s => (s.latitude === null) === (s.longitude === null), 'Set both office coordinates')
.refine(s => !s.gpsRequired || s.latitude !== null, 'Set the office location before requiring GPS')
.refine(s => new Set(s.holidays.map(h => h.date)).size === s.holidays.length, 'Choose each holiday date once');
export type AttendanceSettings = z.infer<typeof attendanceSettingsSchema>;
// GPS check-in remains unavailable until the owner configures an office.
export const DEFAULT_ATTENDANCE: AttendanceSettings = { shiftStart: '09:00', shiftEnd: '18:00', lateAfter: '09:15', gpsRequired: true, officeName: 'Office', latitude: null, longitude: null, radiusM: 150, holidays: [], revision: 0 };
export const attendanceStatusSchema = z.enum(['present', 'late', 'half_day', 'absent']);
export const attendanceMarkSchema = z.object({ employee_id: id, date: dateSchema, status: attendanceStatusSchema, reason: z.string().trim().min(3).max(1000), revision: z.number().int().nonnegative().nullable(), request_key: requestKey }).strict();
export const attendancePunchSchema = z.object({ action: z.enum(['in', 'out']), location: z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), accuracy: z.number().finite().min(0).max(5000), captured_at: z.string().datetime(), mocked: z.boolean().optional() }).strict().optional(), request_key: requestKey }).strict();
export function officeDistance(latitude: number, longitude: number, officeLat: number, officeLon: number) {
  const rad = (n: number) => n * Math.PI / 180;
  const a = Math.sin(rad(latitude - officeLat) / 2) ** 2 + Math.cos(rad(latitude)) * Math.cos(rad(officeLat)) * Math.sin(rad(longitude - officeLon) / 2) ** 2;
  return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a))));
}
export function dhakaClock(at = new Date()) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at); }
export function isDayOff(date: string, settings: Pick<AttendanceSettings, 'holidays'>) { return new Date(`${date}T00:00:00Z`).getUTCDay() === 5 || settings.holidays.some(h => h.date === date); }
/** Explicit records only. Leave wins, and a date is never charged twice. */
export function unpaidAttendance(month: string, joined: string, leaves: { type: string; status: string; workingDates: string[] }[], records: { date: Date; status: string }[], holidays: { date: string }[] = []) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const valid = (d: string) => d.startsWith(month + '-') && d >= joined && !isDayOff(d, { holidays: holidays.map(h => ({ ...h, name: '' })) });
  const approved = leaves.filter(l => l.status === 'approved');
  const leaveDates = new Set(approved.flatMap(l => l.workingDates));
  const unpaid = new Set(approved.filter(l => l.type === 'Unpaid').flatMap(l => l.workingDates).filter(valid));
  const attendance = new Map<string, number>();
  for (const r of records) { const date = day(r.date); if (valid(date) && !leaveDates.has(date)) attendance.set(date, r.status === 'absent' ? 1 : r.status === 'half_day' ? .5 : 0); }
  const attendanceDays = [...attendance.values()].reduce((a, b) => a + b, 0);
  return { leaveDays: unpaid.size, attendanceDays, total: unpaid.size + attendanceDays };
}
