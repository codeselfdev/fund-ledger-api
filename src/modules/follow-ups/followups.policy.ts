import type { CommitmentStatus } from "@prisma/client";
import { z } from "zod";
import { badRequest } from "../../core/http/api-error.js";

export const BREAK_PENALTY = 15;
export const MISSED_DEADLINE_PENALTY = 10;
export const RELIABLE_MIN_SCORE = 85;
export const WATCH_MIN_SCORE = 60;
export const MAX_PROMISE_DAYS = 90;

export const followupsQuerySchema = z.object({ tab: z.enum(["need", "upcoming", "settled"]).default("need") });
export const reliabilityQuerySchema = z.object({ tier: z.enum(["all", "reliable", "watch", "at_risk"]).default("all") });
export const timelineQuerySchema = z.object({ cursor: z.string().regex(/^\d+$/).optional() });
export const callLogSchema = z.object({
  outcome: z.enum(["committed", "no_answer", "claims_paid", "dispute"]),
  summary: z.string().trim().max(500).optional(),
  commitment: z.object({
    promised_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    amount: z.number().int().positive()
  }).strict().optional()
}).strict().superRefine((value, context) => {
  if (value.outcome === "committed" && !value.commitment) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["commitment"], message: "Commitment details are required" });
  }
  if (value.outcome !== "committed" && value.commitment) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["commitment"], message: "Commitment is only allowed for a new payment date" });
  }
  if (value.outcome !== "no_answer" && !value.summary?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["summary"], message: "Call summary is required" });
  }
});
export const resolveCommitmentSchema = z.object({
  status: z.enum(["kept", "kept_late", "cancelled"]),
  reason: z.string().trim().min(3).max(500)
}).strict();

function partsInDhaka(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function dateOnly(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw badRequest("Invalid calendar date", { promised_date: "Choose a valid date" });
  return date;
}

export function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function dhakaDateKey(now = new Date()) {
  return partsInDhaka(now);
}

export function dhakaToday(now = new Date()) {
  return dateOnly(dhakaDateKey(now));
}

export function compareDateOnly(left: Date | string, right: Date | string) {
  const a = typeof left === "string" ? left : dateKey(left);
  const b = typeof right === "string" ? right : dateKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDateDays(value: Date | string, days: number) {
  const date = typeof value === "string" ? dateOnly(value) : new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

export function assertPromiseDate(value: string, now = new Date()) {
  const today = dhakaToday(now);
  const promised = dateOnly(value);
  if (compareDateOnly(promised, today) < 0 || compareDateOnly(promised, addDateDays(today, MAX_PROMISE_DAYS)) > 0) {
    throw badRequest("Promised date must be today or within 90 days", { promised_date: "Choose a date from today through the next 90 days" });
  }
  return promised;
}

export function effectiveStatus(status: CommitmentStatus, promisedDate: Date, now = new Date()) {
  if (status !== "pending") return status;
  const comparison = compareDateOnly(promisedDate, dhakaToday(now));
  return comparison < 0 ? "broken" : comparison === 0 ? "due_today" : "pending";
}

export function scoreFor(breaks: number, missedDeadlines: number) {
  return Math.max(0, 100 - BREAK_PENALTY * breaks - MISSED_DEADLINE_PENALTY * missedDeadlines);
}

export function tierFor(score: number): "reliable" | "watch" | "at_risk" {
  return score >= RELIABLE_MIN_SCORE ? "reliable" : score >= WATCH_MIN_SCORE ? "watch" : "at_risk";
}

export function isReminderAvailable(outstanding: number, sentTodayAt?: Date | null) {
  return outstanding > 0 && !sentTodayAt;
}
