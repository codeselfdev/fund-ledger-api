import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFutureNoticeExpiry, noticeCreateSchema, noticeUpdateSchema, noticeStatus } from "./notices.policy.js";
test("notice expiry is required and at least one minute in the future", () => {
  const fields = { title: "Project update", body: "Details" };
  assert.equal(noticeCreateSchema.safeParse(fields).success, false);
  assert.equal(noticeCreateSchema.safeParse({ ...fields, expires_at: "invalid" }).success, false);
  const now = Date.parse("2026-10-09T00:00:00Z");
  assert.throws(() => assertFutureNoticeExpiry(new Date(now + 60_000).toISOString(), now));
  assert.doesNotThrow(() => assertFutureNoticeExpiry(new Date(now + 60_001).toISOString(), now));
});
test("expired and deleted notices are excluded from active state at the boundary", () => {
  const now = Date.parse("2026-10-09T00:00:00Z");
  assert.equal(noticeStatus({ deletedAt: null, expiresAt: new Date(now + 1) }, now), "active");
  assert.equal(noticeStatus({ deletedAt: null, expiresAt: new Date(now) }, now), "expired");
  assert.equal(noticeStatus({ deletedAt: new Date(), expiresAt: new Date(now + 10_000) }, now), "deleted");
});
test("edits can remove the image or preserve an older expiry without a broadcast", () => {
  assert.deepEqual(noticeUpdateSchema.parse({ image_file_id: null }), { image_file_id: null });
  assert.deepEqual(noticeUpdateSchema.parse({ body: "Updated details" }), { body: "Updated details" });
  for (const body of [{}, { send_whatsapp: true }, { tenantId: "other" }, { deletedAt: null }]) assert.equal(noticeUpdateSchema.safeParse(body).success, false);
});
