import type { ProjectEvent } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";

export const POLL_REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const EVENT_ONE_HOUR_MS = 60 * 60 * 1000;
export const EVENT_TEN_MINUTES_MS = 10 * 60 * 1000;

export function isPollReminderDue(lastReminderAt: Date | null, createdAt: Date, now: Date) {
  const lastSentAt = lastReminderAt ?? createdAt;
  return now.getTime() - lastSentAt.getTime() >= POLL_REMINDER_INTERVAL_MS;
}

export type EventReminderKind = "one_hour" | "ten_minutes";

export function dueEventReminder(
  event: Pick<ProjectEvent, "startsAt" | "reminderOneHourSentAt" | "reminderTenMinSentAt">,
  now: Date,
): EventReminderKind | null {
  const remaining = event.startsAt.getTime() - now.getTime();
  if (remaining <= 0) return null;
  if (remaining <= EVENT_TEN_MINUTES_MS && !event.reminderTenMinSentAt) return "ten_minutes";
  if (
    remaining > EVENT_TEN_MINUTES_MS
    && remaining <= EVENT_ONE_HOUR_MS
    && !event.reminderOneHourSentAt
  ) return "one_hour";
  return null;
}

function eventTime(date: Date) {
  return new Intl.DateTimeFormat("en-BD", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Dhaka",
  }).format(date);
}

async function sendPollReminders(now: Date) {
  const threshold = new Date(now.getTime() - POLL_REMINDER_INTERVAL_MS);
  const polls = await prisma.poll.findMany({
    where: {
      closedAt: null,
      expiresAt: { gt: now },
      OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: threshold } }],
    },
    orderBy: { createdAt: "asc" },
  });

  for (const poll of polls) {
    if (!isPollReminderDue(poll.lastReminderAt, poll.createdAt, now)) continue;
    const claimed = await prisma.poll.updateMany({
      where: {
        id: poll.id,
        closedAt: null,
        expiresAt: { gt: now },
        OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: threshold } }],
      },
      data: { lastReminderAt: now },
    });
    if (claimed.count === 0) continue;

    const [memberships, votes] = await Promise.all([
      prisma.projectMembership.findMany({
        where: {
          tenantId: poll.tenantId,
          projectId: poll.projectId,
          isActive: true,
          user: { isActive: true },
        },
        select: { userId: true },
        distinct: ["userId"],
      }),
      prisma.pollVote.findMany({ where: { pollId: poll.id }, select: { userId: true } }),
    ]);
    const voted = new Set(votes.map((vote) => vote.userId));
    const userIds = memberships.map((membership) => membership.userId).filter((userId) => !voted.has(userId));
    if (userIds.length === 0) continue;

    await notifyProjectMembers({
      tenantId: poll.tenantId,
      projectId: poll.projectId,
      type: "poll.vote_reminder",
      title: "Your vote is still needed",
      body: `${poll.title} closes soon. Please open the app and cast your vote.`,
      entityType: "poll",
      entityId: poll.id,
      userIds,
    });
  }
}

async function sendEventReminders(now: Date) {
  const events = await prisma.projectEvent.findMany({
    where: {
      cancelledAt: null,
      startsAt: { gt: now, lte: new Date(now.getTime() + EVENT_ONE_HOUR_MS) },
      OR: [{ reminderOneHourSentAt: null }, { reminderTenMinSentAt: null }],
    },
    orderBy: { startsAt: "asc" },
  });

  for (const event of events) {
    const kind = dueEventReminder(event, now);
    if (!kind) continue;
    const claimWhere = kind === "ten_minutes"
      ? { id: event.id, cancelledAt: null, startsAt: { gt: now }, reminderTenMinSentAt: null }
      : { id: event.id, cancelledAt: null, startsAt: { gt: now }, reminderOneHourSentAt: null };
    const claimed = await prisma.projectEvent.updateMany({
      where: claimWhere,
      data: kind === "ten_minutes" ? { reminderTenMinSentAt: now } : { reminderOneHourSentAt: now },
    });
    if (claimed.count === 0) continue;

    const timing = kind === "ten_minutes" ? "in 10 minutes" : "in 1 hour";
    await notifyProjectMembers({
      tenantId: event.tenantId,
      projectId: event.projectId,
      type: `event.reminder_${kind}`,
      title: `Event starts ${timing}`,
      body: `${event.title} at ${event.place} · ${eventTime(event.startsAt)}`,
      entityType: "event",
      entityId: event.id,
    });
  }
}

let running = false;
let warnedMissingTables = false;

export async function runCommunityReminders(now = new Date()) {
  if (running) return;
  running = true;
  try {
    await sendPollReminders(now);
    await sendEventReminders(now);
    warnedMissingTables = false;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2021") {
      if (!warnedMissingTables) {
        warnedMissingTables = true;
        console.warn("[community-reminders] tables missing; run prisma migrations to enable polls and events");
      }
      return;
    }
    console.error("[community-reminders] reminder run failed", error);
  } finally {
    running = false;
  }
}
