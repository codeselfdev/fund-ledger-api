import { z } from 'zod';
export const sheetKeys = ['summary', 'members', 'banks', 'ie'] as const;
export const timezoneSchema = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Choose a valid IANA timezone');
const exportFields = z.object({
  sheets: z.array(z.enum(sheetKeys)).min(1).max(4).transform(v => [...new Set(v)]),
  period: z.enum(['today', 'month', 'last', 'custom']).default('month'),
  from: z.string().optional(), to: z.string().optional(),
  layout: z.enum(['one', 'sep']).default('one'),
  timezone: timezoneSchema.default('Asia/Dhaka'),
}).strict();
const validDate = (value?: string): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
export const exportSchema = exportFields.superRefine((value, ctx) => {
  if (value.period !== 'custom') return;
  if (!validDate(value.from)) ctx.addIssue({code:'custom',path:['from'],message:'Choose a valid From date'});
  if (!validDate(value.to)) ctx.addIssue({code:'custom',path:['to'],message:'Choose a valid To date'});
  if (validDate(value.from) && validDate(value.to) && value.from > value.to) ctx.addIssue({code:'custom',path:['to'],message:'To date must be on or after From date'});
});
export const destinationsSchema = z.object({
  recipient_ids: z.array(z.string().min(1).max(100)).max(100).transform(v => [...new Set(v)]),
  email: z.boolean(), inbox: z.boolean(), telegram: z.boolean(),
}).strict();
export const scheduleSchema = z.object({
  enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: timezoneSchema,
  days: z.array(z.number().int().min(0).max(6)).max(7).transform(v => [...new Set(v)]),
  sheets: exportFields.shape.sheets,
  ...destinationsSchema.shape,
}).strict().superRefine((v, ctx) => {
  if (!v.enabled) return;
  if (!v.days.length) ctx.addIssue({ code: 'custom', path: ['days'], message: 'Choose at least one day' });
  if (!v.email && !v.inbox && !v.telegram) ctx.addIssue({ code: 'custom', path: ['email'], message: 'Choose a destination' });
  if ((v.email || v.inbox) && !v.recipient_ids.length) ctx.addIssue({ code: 'custom', path: ['recipient_ids'], message: 'Choose staff recipients' });
});
export type ExportConfig = z.infer<typeof exportSchema>;
export type Destinations = z.infer<typeof destinationsSchema>;
export type Scope = { tenantId: string; projectId: string; userId: string };
export function localParts(now: Date, timezone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(v => [v.type, v.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${p.hour}:${p.minute}`, day: new Date(`${date}T00:00:00Z`).getUTCDay() };
}
/** Convert a local midnight to UTC, including DST zones. */
export function localMidnight(date: string, timezone: string) {
  const nominal = Date.parse(`${date}T00:00:00Z`);
  let candidate = nominal;
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(candidate), timezone);
    const represented = Date.parse(`${p.date}T${p.time}:00Z`);
    const correction = nominal - represented;
    candidate += correction;
    if (!correction) break;
  }
  return new Date(candidate);
}
export function reportRange(now: Date, timezone: string, period: ExportConfig['period'], custom: Pick<ExportConfig, 'from' | 'to'> = {}) {
  const today = localParts(now, timezone).date;
  if (period === 'custom') {
    if (!validDate(custom.from) || !validDate(custom.to) || custom.from > custom.to) throw new Error('Choose a valid custom date range');
    // The UI's To date is inclusive; database upper bounds are the next local midnight, exclusive.
    const until = new Date(Date.parse(`${custom.to}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
    return { today, from: custom.from, until, start: localMidnight(custom.from, timezone), end: localMidnight(until, timezone), dayStart: localMidnight(today, timezone) };
  }
  const date = new Date(`${today}T00:00:00Z`);
  const next = new Date(date.getTime() + 86400000).toISOString().slice(0,10);
  const month = `${today.slice(0,7)}-01`;
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)).toISOString().slice(0,10);
  const from = period === 'last' ? previous : period === 'month' ? month : today;
  const until = period === 'last' ? month : next;
  return { today, from, until, start: localMidnight(from, timezone), end: period === 'last' ? localMidnight(until, timezone) : now, dayStart: localMidnight(today, timezone) };
}
export function dueRemaining(d: { amount: number; waivedAmount: number; paidAmount: number; penaltyDue: number; penaltyPaid: number }) {
  return Math.max(0, d.amount - d.waivedAmount - d.paidAmount) + Math.max(0, d.penaltyDue - d.penaltyPaid);
}
