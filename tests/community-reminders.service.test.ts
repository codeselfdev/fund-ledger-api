import assert from "node:assert/strict";
import test from "node:test";
import {
  dueEventReminder,
  isPollReminderDue,
  POLL_REMINDER_INTERVAL_MS,
} from "../src/modules/community/community-reminders.service.js";

test("poll reminders become due every two hours", () => {
  const createdAt = new Date("2026-10-07T08:00:00.000Z");
  assert.equal(
    isPollReminderDue(null, createdAt, new Date(createdAt.getTime() + POLL_REMINDER_INTERVAL_MS - 1)),
    false,
  );
  assert.equal(
    isPollReminderDue(null, createdAt, new Date(createdAt.getTime() + POLL_REMINDER_INTERVAL_MS)),
    true,
  );

  const lastReminderAt = new Date("2026-10-07T12:00:00.000Z");
  assert.equal(
    isPollReminderDue(lastReminderAt, createdAt, new Date(lastReminderAt.getTime() + POLL_REMINDER_INTERVAL_MS)),
    true,
  );
});

test("event reminders use the one-hour and ten-minute windows once each", () => {
  const now = new Date("2026-10-07T08:00:00.000Z");
  const event = {
    startsAt: new Date("2026-10-07T09:00:00.000Z"),
    reminderOneHourSentAt: null,
    reminderTenMinSentAt: null,
  };

  assert.equal(dueEventReminder(event, now), "one_hour");
  assert.equal(
    dueEventReminder({ ...event, startsAt: new Date("2026-10-07T08:10:00.000Z") }, now),
    "ten_minutes",
  );
  assert.equal(
    dueEventReminder({ ...event, reminderOneHourSentAt: now }, now),
    null,
  );
  assert.equal(
    dueEventReminder({ ...event, startsAt: now }, now),
    null,
  );
});

