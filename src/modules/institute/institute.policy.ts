import { z } from 'zod';
import { ApiError } from '../../core/http/api-error.js';
export const enabled = () => process.env.INSTITUTE_ENABLED === 'true';
export const id = z.string().min(1).max(128);
export const money = z.number().int().positive().max(2147483647);
export const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(+d) && d.toISOString().slice(0, 10) === v; }, 'Invalid date');
export const date = (v: string) => new Date(`${v}T00:00:00Z`);
export const mobile = z.string().regex(/^\+[1-9]\d{6,14}$/);
export const settingsSchema = z.object({ subtype: z.enum(['school', 'coaching', 'training']), group_label: z.string().trim().min(1).max(64), academic_year: z.string().min(1).max(32), timezone: z.string().refine(v => { try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
    }
    catch {
        return false;
    } }, 'Invalid timezone'), week_off_days: z.array(z.number().int().min(0).max(6)).max(6), attendance_mode: z.enum(['daily', 'per_session']), attendance_reminder_after_min: z.number().int().min(1).max(1440), grading: z.enum(['bd_gpa5', 'bands']), show_position_default: z.boolean(), fee_due_day: z.number().int().min(1).max(28), family_can_pay_online: z.boolean() }).strict().refine(s => s.subtype !== 'training' || !s.show_position_default, 'Training never shows class positions');
export function settings(raw: unknown) { return settingsSchema.parse(raw ?? { subtype: 'school', group_label: 'Class', academic_year: new Date().getFullYear().toString(), timezone: 'Asia/Dhaka', week_off_days: [5, 6], attendance_mode: 'daily', attendance_reminder_after_min: 30, grading: 'bd_gpa5', show_position_default: false, fee_due_day: 10, family_can_pay_online: true }); }
export const portalSchema = z.enum(['office', 'accounts', 'teacher', 'guardian', 'student', 'auditor']);
export type Portal = z.infer<typeof portalSchema>;
export function portals(roles: readonly string[], guardian: boolean, student: boolean, teacher: boolean): Portal[] {
    const result: Portal[] = [];
    if (roles.some(r => ['owner', 'admin'].includes(r)))
        result.push('office');
    if (roles.some(r => ['accountant', 'cashier'].includes(r)))
        result.push('accounts');
    if (roles.includes('teacher') && teacher)
        result.push('teacher');
    if (guardian)
        result.push('guardian');
    if (student)
        result.push('student');
    if (roles.includes('auditor'))
        result.push('auditor');
    return result;
}
export const attendanceSchema = z.object({ group_id: id, date: day, session: z.number().int().min(1).max(24), revision: z.number().int().nonnegative(), notify_absent: z.boolean(), reason: z.string().trim().min(2).max(500).optional(), marks: z.array(z.object({ student_id: id, status: z.enum(['present', 'late', 'absent', 'leave']) }).strict()).max(5000) }).strict();
export const fail = (code: string, message: string, status = 422, fields?: unknown): never => { throw new ApiError(status, code, message, fields); };
export function validateAttendance(roster: string[], locked: Set<string>, marks: {
    student_id: string;
    status: string;
}[]) {
    const ids = new Set(marks.map(m => m.student_id));
    if (ids.size !== marks.length || ids.size !== roster.length || roster.some(v => !ids.has(v)))
        fail('ATTENDANCE_INCOMPLETE', 'Mark every active student exactly once.');
    for (const mark of marks)
        if ((locked.has(mark.student_id) && mark.status !== 'leave') || (!locked.has(mark.student_id) && mark.status === 'leave'))
            fail('ATTENDANCE_LEAVE_LOCKED', 'Approved leave rows are fixed.', 409);
}
export function gpa(percent: number) { for (const [min, grade, point] of [[80, 'A+', 5], [70, 'A', 4], [60, 'A-', 3.5], [50, 'B', 3], [40, 'C', 2], [33, 'D', 1], [0, 'F', 0]] as const)
    if (percent >= min)
        return { grade, point }; return { grade: 'F', point: 0 }; }
export function resultGrade(totals: number[], grading: string, absent: boolean[]) {
    const failed = totals.some((n, i) => absent[i] || n < (grading === 'bands' ? 40 : 33));
    if (grading === 'bands') {
        const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
        return { grade: failed ? 'Refer' : avg >= 80 ? 'Distinction' : avg >= 60 ? 'Merit' : 'Pass', passed: !failed };
    }
    const points = totals.map((n, i) => absent[i] ? 0 : gpa(n).point), value = failed ? 0 : Math.round(points.reduce((a, b) => a + b, 0) / points.length * 100) / 100;
    return { grade: failed ? 'F' : gpa(totals.reduce((a, b) => a + b, 0) / totals.length).grade, gpa: value, passed: !failed };
}
export function densePositions(rows: {
    student_id: string;
    gpa?: number;
    total: number;
    passed: boolean;
}[]) {
    const sorted = rows.filter(r => r.passed).sort((a, b) => (b.gpa ?? 0) - (a.gpa ?? 0) || b.total - a.total);
    let rank = 0, previous = '';
    return Object.fromEntries(sorted.map(r => { const key = `${r.gpa ?? 0}:${r.total}`; if (key !== previous) {
        rank++;
        previous = key;
    } return [r.student_id, rank]; }));
}
export const today = (timezone: string, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export function pushNotBefore(timezone: string, now = new Date()) { const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now)); if (hour >= 7 && hour < 21)
    return now; const next = new Date(now); for (let i = 0; i < 24 * 60; i++) {
    next.setUTCMinutes(next.getUTCMinutes() + 1, 0, 0);
    if (Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(next)) === 7)
        return next;
} return next; }

export function localDayStart(dayText: string, timezone: string) {
  const target = +date(dayText);
  let candidate = target;
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
    const represented = Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);
    const change = target-represented;
    candidate += change;
    if (!change) break;
  }
  return new Date(candidate);
}
export function monthBounds(month: string, timezone: string) {
  const first = date(`${month}-01`);
  const next = new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,1)).toISOString().slice(0,10);
  return { start: localDayStart(`${month}-01`,timezone), end: localDayStart(next,timezone) };
}
