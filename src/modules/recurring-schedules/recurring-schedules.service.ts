import { DepositStatus, Prisma, RecurringFrequency } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { evaluateSubscription } from "../../core/subscription/subscription.service.js";
import { createScheduleWithUnitAmount } from "../schedules/schedule-creation.service.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const MAX_ITERATIONS = 1000;

export function startOfDay(input: Date) {
  const date = new Date(input);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(input: Date, days: number) {
  const date = new Date(input);
  date.setDate(date.getDate() + days);
  return date;
}

function addMonthsWithAnchor(input: Date, months: number, anchorDay: number) {
  const date = new Date(input);
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(anchorDay, lastDay));
  return date;
}

function addYearsWithAnchor(input: Date, years: number, anchorMonth: number, anchorDay: number) {
  const date = new Date(input);
  date.setDate(1);
  date.setFullYear(date.getFullYear() + years, anchorMonth, 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(anchorDay, lastDay));
  return date;
}

export function computeNextRunAt(currentRunAt: Date, frequency: RecurringFrequency, startsOn: Date) {
  const anchorDay = startsOn.getDate();
  const anchorMonth = startsOn.getMonth();
  const current = startOfDay(currentRunAt);
  switch (frequency) {
    case "weekly":
      return startOfDay(addDays(current, 7));
    case "biweekly":
      return startOfDay(addDays(current, 14));
    case "monthly":
      return startOfDay(addMonthsWithAnchor(current, 1, anchorDay));
    case "bimonthly":
      return startOfDay(addMonthsWithAnchor(current, 2, anchorDay));
    case "quarterly":
      return startOfDay(addMonthsWithAnchor(current, 3, anchorDay));
    case "yearly":
      return startOfDay(addYearsWithAnchor(current, 1, anchorMonth, anchorDay));
    default:
      return startOfDay(addMonthsWithAnchor(current, 1, anchorDay));
  }
}

export function resolveInitialNextRunAt(startsOn: Date, frequency: RecurringFrequency, now = new Date()) {
  let nextRunAt = startOfDay(startsOn);
  const today = startOfDay(now);
  let iterations = 0;

  while (nextRunAt.getTime() < today.getTime() && iterations < MAX_ITERATIONS) {
    nextRunAt = computeNextRunAt(nextRunAt, frequency, startsOn);
    iterations += 1;
  }

  return nextRunAt;
}

const MONTH_SHORT = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

function twoDigitYear(input: Date) {
  return String(input.getFullYear()).slice(-2);
}

function quarterOfYear(input: Date) {
  return Math.floor(input.getMonth() / 3) + 1;
}

function scheduleNameForOccurrence(frequency: RecurringFrequency, runAt: Date) {
  const month = MONTH_SHORT[runAt.getMonth()];
  const year = twoDigitYear(runAt);

  switch (frequency) {
    case "weekly":
      return `1W ${month} ${year}`;
    case "biweekly":
      return `2W ${month} ${year}`;
    case "monthly":
      return `${month} ${year}`;
    case "bimonthly":
      return `2M ${month} ${year}`;
    case "quarterly":
      return `Q${quarterOfYear(runAt)} ${year}`;
    case "yearly":
      return `YR ${year}`;
    default:
      return `${month} ${year}`;
  }
}

type RunResult = "created" | "skipped_subscription" | "duplicate" | "failed";

async function processRecurringSchedule(config: {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  unitAmount: number;
  frequency: RecurringFrequency;
  startsOn: Date;
  nextRunAt: Date;
  penaltyPolicy: Prisma.JsonValue | null;
  createdById: string;
}, now = new Date()) {
  const runDate = startOfDay(config.nextRunAt);
  const nextRunAt = computeNextRunAt(runDate, config.frequency, config.startsOn);

  let runResult: RunResult = "failed";
  let runMessage: string | null = null;

  const tenant = await prisma.tenant.findUnique({
    where: { id: config.tenantId },
    select: { contact: true }
  });
  if (!tenant) {
    runResult = "failed";
    runMessage = "Tenant not found";
  } else {
    const subscription = evaluateSubscription(tenant.contact, now);
    if (!subscription.has_access) {
      runResult = "skipped_subscription";
      runMessage = "Subscription inactive on run date";
    } else {
      try {
        const created = await createScheduleWithUnitAmount({
          tenantId: config.tenantId,
          projectId: config.projectId,
          name: scheduleNameForOccurrence(config.frequency, runDate),
          unitAmount: config.unitAmount,
          dueDate: runDate,
          status: "active",
          penaltyPolicy: config.penaltyPolicy,
          createdById: config.createdById,
          recurringScheduleId: config.id
        });

        await writeAudit({
          tenantId: config.tenantId,
          projectId: config.projectId,
          actorUserId: config.createdById,
          action: "recurring_schedule.fired",
          entityType: "recurring_schedule",
          entityId: config.id,
          after: {
            recurring_schedule_id: config.id,
            generated_schedule_id: created.schedule.id,
            run_at: runDate.toISOString(),
            dues_created: created.duesCreated,
            auto_applied_total: created.autoAppliedTotal
          }
        });

        runResult = "created";
        runMessage = `Generated schedule ${created.schedule.id}`;
      } catch (error) {
        const maybeCode = (error as { code?: string }).code;
        if (maybeCode === "P2002") {
          runResult = "duplicate";
          runMessage = "Schedule already exists for this recurring occurrence";
        } else if ((error as { statusCode?: number }).statusCode === 400 && (error as { message?: string }).message?.includes("active member")) {
          runResult = "failed";
          runMessage = "No active members available";
        } else {
          runResult = "failed";
          runMessage = error instanceof Error ? error.message : "Unknown recurring schedule failure";
        }
      }
    }
  }

  await prisma.recurringSchedule.update({
    where: { id: config.id },
    data: {
      nextRunAt,
      lastRunAt: now,
      lastRunStatus: runResult,
      lastRunMessage: runMessage
    }
  });
}

let running = false;
let warnedMissingRecurringTable = false;

export async function runRecurringSchedules(now = new Date()) {
  if (running) return;
  running = true;
  try {
    let due;
    try {
      due = await prisma.recurringSchedule.findMany({
        where: {
          isActive: true,
          nextRunAt: { lte: now }
        },
        orderBy: { nextRunAt: "asc" }
      });
      warnedMissingRecurringTable = false;
    } catch (error) {
      const maybeCode = (error as { code?: string }).code;
      const maybeTable = (error as { meta?: { table?: string } }).meta?.table;
      if (maybeCode === "P2021" && maybeTable === "public.recurring_schedules") {
        if (!warnedMissingRecurringTable) {
          warnedMissingRecurringTable = true;
          console.warn("[recurring-schedules] table missing; run prisma migrations to enable recurring schedules");
        }
        return;
      }
      throw error;
    }

    for (const config of due) {
      await processRecurringSchedule(config, now);
    }
  } finally {
    running = false;
  }
}
