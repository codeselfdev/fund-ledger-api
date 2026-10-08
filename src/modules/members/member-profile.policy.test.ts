import assert from "node:assert/strict";
import { test } from "node:test";
import { assertProfileEditAllowed, profilePatchSchema } from "./member-profile.policy.js";
const self = { memberId: "member-1", roles: ["member"] };
const admin = { memberId: null, roles: ["admin"] };
test("members can edit own contact and nominee information", () => {
  const body = profilePatchSchema.parse({ address: "Dhaka", occupation: "Engineer", nominee_share_percent: 100 });
  assert.doesNotThrow(() => assertProfileEditAllowed(self, "member-1", body));
});
test("other-member edits and staff edits are rejected", () => {
  assert.throws(() => assertProfileEditAllowed(self, "member-2"));
  assert.throws(() => assertProfileEditAllowed({ memberId: null, roles: ["accountant"] }, "member-1"));
});
test("identity fields are restricted to admins", () => {
  for (const body of [{ name: "New name" }, { mobile: "01711000000" }, { nid: "1234" }, { date_of_birth: "1990-01-01" }]) {
    const parsed = profilePatchSchema.parse(body);
    assert.throws(() => assertProfileEditAllowed(self, "member-1", parsed));
    assert.doesNotThrow(() => assertProfileEditAllowed(admin, "member-1", parsed));
  }
});
test("profile cannot bypass membership controls or set a photo ID", () => {
  for (const field of ["shares", "status", "photo_file_id", "userId", "tenantId"]) assert.equal(profilePatchSchema.safeParse({ [field]: "value" }).success, false);
});
test("validates dates, percentages, and empty updates", () => {
  for (const date of ["2026-02-30", "3000-01-01", "wrong"]) assert.equal(profilePatchSchema.safeParse({ date_of_birth: date }).success, false);
  for (const share of [-1, 101]) assert.equal(profilePatchSchema.safeParse({ nominee_share_percent: share }).success, false);
  assert.equal(profilePatchSchema.safeParse({}).success, false);
  assert.equal(profilePatchSchema.parse({ email: "" }).email, null);
});
