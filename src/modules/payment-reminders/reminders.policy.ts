import { z } from "zod";
import { bangladeshHoliday } from "./holidays.js";

/** Pure rules for automatic payment reminders. Dates are "YYYY-MM-DD" in Asia/Dhaka. */
export const MAX_SENDS_PER_DUE = 10;
export const MESSAGE_MAX = 240;
export const REMINDER_KINDS = ["before", "due", "after"] as const;
export type ReminderKind = typeof REMINDER_KINDS[number];
export type OffDayRule = "before" | "after" | "skip";
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 10:00");

export interface ReminderSettings { enabled: boolean; preferredTime: string; sendingDays: number[]; offDayRule: OffDayRule; treatHolidays: boolean; pauseForPromises: boolean }
export interface ReminderRule { id?: string; kind: ReminderKind; days: number; ownTime: string | null; repeatEvery: number | null; repeatCount: number | null; message: string; enabled: boolean }

export const DEFAULT_MESSAGES: Record<ReminderKind, string> = {
  before: "Hi {name}, your {amount} for {schedule} is due on {due_date}. Please pay on time.",
  due: "Hi {name}, your {amount} for {schedule} is due today ({due_date}). Please pay today.",
  after: "Hi {name}, your {amount} for {schedule} was due on {due_date} and is now {days} late. Please pay as soon as you can.",
};
/** The starting set a project gets the first time an admin opens Payment reminders. */
export const DEFAULT_RULES: ReminderRule[] = [
  { kind: "before", days: 7, ownTime: null, repeatEvery: null, repeatCount: null, message: DEFAULT_MESSAGES.before, enabled: true },
  { kind: "before", days: 3, ownTime: null, repeatEvery: null, repeatCount: null, message: DEFAULT_MESSAGES.before, enabled: true },
  { kind: "before", days: 1, ownTime: "18:00", repeatEvery: null, repeatCount: null, message: DEFAULT_MESSAGES.before, enabled: true },
  { kind: "due", days: 0, ownTime: null, repeatEvery: null, repeatCount: null, message: DEFAULT_MESSAGES.due, enabled: true },
  { kind: "after", days: 1, ownTime: null, repeatEvery: null, repeatCount: null, message: DEFAULT_MESSAGES.after, enabled: true },
  { kind: "after", days: 3, ownTime: null, repeatEvery: 3, repeatCount: 5, message: DEFAULT_MESSAGES.after, enabled: true },
];
export const DEFAULT_SETTINGS: ReminderSettings = { enabled: false, preferredTime: "10:00", sendingDays: [6, 0, 1, 2, 3, 4], offDayRule: "before", treatHolidays: true, pauseForPromises: true };

export const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  preferred_time: clock.optional(),
  sending_days: z.array(z.number().int().min(0).max(6)).min(1, "Choose at least one sending day").max(7).optional(),
  off_day_rule: z.enum(["before", "after", "skip"]).optional(),
  treat_holidays: z.boolean().optional(),
  pause_for_promises: z.boolean().optional(),
}).strict();
export const ruleSchema = z.object({
  kind: z.enum(REMINDER_KINDS),
  days: z.number().int().min(0).max(60),
  own_time: clock.nullable().default(null),
  repeat_every: z.number().int().min(1).max(30).nullable().default(null),
  repeat_count: z.number().int().min(2).max(10).nullable().default(null),
  message: z.string().trim().min(1, "Write a message").max(MESSAGE_MAX, `Keep the message to ${MESSAGE_MAX} characters`),
  enabled: z.boolean().default(true),
}).strict().superRefine((rule, ctx) => {
  if (rule.kind === "due" && rule.days !== 0) ctx.addIssue({ code: "custom", path: ["days"], message: "A due-date reminder has no day offset" });
  if (rule.kind !== "due" && rule.days < 1) ctx.addIssue({ code: "custom", path: ["days"], message: "Choose 1 to 60 days" });
  const repeating = rule.repeat_every !== null || rule.repeat_count !== null;
  if (repeating && rule.kind !== "after") ctx.addIssue({ code: "custom", path: ["repeat_every"], message: "Only overdue reminders can repeat" });
  if (repeating && (rule.repeat_every === null || rule.repeat_count === null)) ctx.addIssue({ code: "custom", path: ["repeat_count"], message: "Choose how often and how many sends" });
  const unknown = [...rule.message.matchAll(/\{([^}]*)\}/g)].map(match => match[1]).filter(name => !["name", "amount", "schedule", "due_date", "days"].includes(name));
  if (unknown.length) ctx.addIssue({ code: "custom", path: ["message"], message: `Unknown placeholder {${unknown[0]}}` });
});
export type RuleInput = z.infer<typeof ruleSchema>;
export const fromInput = (input: RuleInput): ReminderRule => ({ kind: input.kind, days: input.kind === "due" ? 0 : input.days, ownTime: input.own_time, repeatEvery: input.repeat_every, repeatCount: input.repeat_count, message: input.message, enabled: input.enabled });

export const sendsFor = (rule: Pick<ReminderRule, "repeatCount" | "enabled">) => rule.enabled ? rule.repeatCount ?? 1 : 0;
export const totalSends = (rules: ReminderRule[]) => rules.reduce((sum, rule) => sum + sendsFor(rule), 0);
export const timeFor = (rule: Pick<ReminderRule, "ownTime">, settings: Pick<ReminderSettings, "preferredTime">) => rule.ownTime ?? settings.preferredTime;
/** Signed day offset from the deadline: before = negative. */
export const offsetOf = (rule: Pick<ReminderRule, "kind" | "days">) => rule.kind === "before" ? -rule.days : rule.kind === "after" ? rule.days : 0;

// ---- dates ----
export const addDays = (key: string, days: number) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export const weekday = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();
export const dhakaNow = (now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};
export const keyOf = (value: Date) => value.toISOString().slice(0, 10);
export function offDayReason(key: string, settings: Pick<ReminderSettings, "sendingDays" | "treatHolidays">): string | null {
  if (!settings.sendingDays.includes(weekday(key))) return "off day";
  if (settings.treatHolidays) return bangladeshHoliday(key);
  return null;
}
const isOff = (key: string, settings: Pick<ReminderSettings, "sendingDays" | "treatHolidays">) => offDayReason(key, settings) !== null;
function step(key: string, direction: -1 | 1, settings: Pick<ReminderSettings, "sendingDays" | "treatHolidays">) {
  let current = key;
  for (let i = 0; i < 31; i++) { current = addDays(current, direction); if (!isOff(current, settings)) return current; }
  return null;
}
export interface PlannedSend { date: string; movedFrom: string | null; sendNo: number }
/**
 * The exact days one rule sends for one deadline, after off days and holidays. Before-deadline and
 * due-date reminders never move past the deadline: "next sending day" falls back to the day before.
 */
export function planRule(rule: ReminderRule, dueDate: string, settings: Pick<ReminderSettings, "sendingDays" | "treatHolidays" | "offDayRule">): PlannedSend[] {
  const base = addDays(dueDate, offsetOf(rule));
  const count = rule.kind === "after" && rule.repeatEvery && rule.repeatCount ? rule.repeatCount : 1;
  const sends: PlannedSend[] = [], used = new Set<string>();
  for (let i = 0; i < count; i++) {
    const original = addDays(base, i * (rule.repeatEvery ?? 0));
    let date: string | null = original;
    if (isOff(original, settings)) {
      if (settings.offDayRule === "skip") date = null;
      else if (settings.offDayRule === "after") {
        date = step(original, 1, settings);
        if (rule.kind !== "after" && date && date > dueDate) date = step(original, -1, settings);
      } else date = step(original, -1, settings);
      // An overdue reminder never moves back to or before the deadline.
      if (rule.kind === "after" && date && date <= dueDate) date = step(original, 1, settings);
    }
    if (!date || used.has(date)) continue;
    used.add(date);
    sends.push({ date, movedFrom: date === original ? null : original, sendNo: i + 1 });
  }
  return sends;
}

// ---- messages ----
export const money = (amount: number) => `৳${Math.round(amount).toLocaleString("en-IN")}`;
export const shortDate = (key: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`)).replace(",", "");
export function renderMessage(template: string, values: { name: string; amount: number; schedule: string; dueDate: string; sendDate: string }) {
  const late = Math.max(0, Math.round((Date.parse(`${values.sendDate}T00:00:00Z`) - Date.parse(`${values.dueDate}T00:00:00Z`)) / 86400000));
  const early = Math.max(0, Math.round((Date.parse(`${values.dueDate}T00:00:00Z`) - Date.parse(`${values.sendDate}T00:00:00Z`)) / 86400000));
  const days = late || early;
  const firstName = values.name.trim().split(/\s+/)[0] || values.name;
  return template
    .replaceAll("{name}", firstName)
    .replaceAll("{amount}", money(values.amount))
    .replaceAll("{schedule}", values.schedule)
    .replaceAll("{due_date}", shortDate(values.dueDate))
    .replaceAll("{days}", `${days} ${days === 1 ? "day" : "days"}`);
}
export function ruleLabel(rule: Pick<ReminderRule, "kind" | "days">) {
  if (rule.kind === "due") return "On the due date";
  return `${rule.days} ${rule.days === 1 ? "day" : "days"} ${rule.kind === "before" ? "before" : "after"}`;
}
/** "7 days before", "due today", "9 days late" for a specific send date. */
export function relativeLabel(dueDate: string, sendDate: string) {
  const diff = Math.round((Date.parse(`${sendDate}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86400000);
  if (diff === 0) return "due today";
  return diff < 0 ? `${-diff} ${diff === -1 ? "day" : "days"} before` : `${diff} ${diff === 1 ? "day" : "days"} late`;
}
