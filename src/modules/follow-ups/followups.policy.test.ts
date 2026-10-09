import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPromiseDate, dhakaDateKey, effectiveStatus, isReminderAvailable, scoreFor, tierFor } from "./followups.policy.js";

test("Dhaka day boundaries drive effective commitment status", () => {
  const promised = new Date("2026-10-09T00:00:00.000Z");
  assert.equal(dhakaDateKey(new Date("2026-10-08T17:59:00.000Z")), "2026-10-08");
  assert.equal(effectiveStatus("pending", promised, new Date("2026-10-08T18:01:00.000Z")), "due_today");
  assert.equal(effectiveStatus("pending", promised, new Date("2026-10-09T18:01:00.000Z")), "broken");
});

test("score and tiers use the documented edges", () => {
  assert.equal(scoreFor(1, 0), 85);
  assert.equal(tierFor(85), "reliable");
  assert.equal(tierFor(84), "watch");
  assert.equal(tierFor(60), "watch");
  assert.equal(tierFor(59), "at_risk");
  assert.equal(scoreFor(20, 20), 0);
});

test("reminder availability and promise window are server driven", () => {
  assert.equal(isReminderAvailable(1, null), true);
  assert.equal(isReminderAvailable(0, null), false);
  assert.equal(isReminderAvailable(1, new Date()), false);
  const now = new Date("2026-10-09T06:00:00.000Z");
  assert.doesNotThrow(() => assertPromiseDate("2026-10-09", now));
  assert.doesNotThrow(() => assertPromiseDate("2027-01-07", now));
  assert.throws(() => assertPromiseDate("2026-10-08", now));
  assert.throws(() => assertPromiseDate("2027-01-08", now));
});
