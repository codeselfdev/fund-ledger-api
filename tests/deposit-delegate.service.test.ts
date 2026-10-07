import assert from "node:assert/strict";
import test from "node:test";
import {
  canUserPayOnBehalf,
  hasDelegatedPayerAccess,
  listDepositDelegatePermissions,
  upsertDepositDelegatePermission
} from "../src/core/security/deposit-delegate.service.js";

test("a member link permits only its beneficiary in the same project", () => {
  const saved = upsertDepositDelegatePermission({
    contact: {}, projectId: "project-a", userId: "member-9-user",
    beneficiaryMemberId: "member-8", actorUserId: "admin", isActive: true
  });
  assert.equal(canUserPayOnBehalf(saved.contact, "project-a", "member-9-user", "member-8"), true);
  assert.equal(canUserPayOnBehalf(saved.contact, "project-a", "member-9-user", "member-7"), false);
  assert.equal(canUserPayOnBehalf(saved.contact, "project-b", "member-9-user", "member-8"), false);
  assert.equal(hasDelegatedPayerAccess(saved.contact, "project-a", "member-9-user"), true);

  const disabled = upsertDepositDelegatePermission({
    contact: saved.contact, projectId: "project-a", userId: "member-9-user",
    beneficiaryMemberId: "member-8", actorUserId: "admin", isActive: false
  });
  assert.equal(disabled.permission.id, saved.permission.id);
  assert.equal(canUserPayOnBehalf(disabled.contact, "project-a", "member-9-user", "member-8"), false);
});

test("creating a specific link disables that payer's legacy project-wide grant", () => {
  const legacyContact = {
    member_deposit_delegate_permissions: [{
      id: "legacy", project_id: "project-a", user_id: "member-9-user", is_active: true,
      created_by_id: "admin", created_at: "2026-01-01", updated_at: "2026-01-01"
    }]
  };
  assert.equal(canUserPayOnBehalf(legacyContact, "project-a", "member-9-user", "member-7"), true);
  const saved = upsertDepositDelegatePermission({
    contact: legacyContact, projectId: "project-a", userId: "member-9-user",
    beneficiaryMemberId: "member-8", actorUserId: "admin", isActive: true
  });
  const permissions = listDepositDelegatePermissions(saved.contact, "project-a");
  assert.equal(permissions.find((permission) => permission.id === "legacy")?.is_active, false);
  assert.equal(canUserPayOnBehalf(saved.contact, "project-a", "member-9-user", "member-8"), true);
  assert.equal(canUserPayOnBehalf(saved.contact, "project-a", "member-9-user", "member-7"), false);
});

test("one payer can have separate links and disabling one preserves the other", () => {
  const first = upsertDepositDelegatePermission({
    contact: {}, projectId: "project-a", userId: "member-9-user",
    beneficiaryMemberId: "member-8", actorUserId: "admin", isActive: true
  });
  const second = upsertDepositDelegatePermission({
    contact: first.contact, projectId: "project-a", userId: "member-9-user",
    beneficiaryMemberId: "member-7", actorUserId: "admin", isActive: true
  });
  const disabled = upsertDepositDelegatePermission({
    contact: second.contact, projectId: "project-a", userId: "member-9-user",
    beneficiaryMemberId: "member-8", actorUserId: "admin", isActive: false
  });
  assert.equal(canUserPayOnBehalf(disabled.contact, "project-a", "member-9-user", "member-8"), false);
  assert.equal(canUserPayOnBehalf(disabled.contact, "project-a", "member-9-user", "member-7"), true);
});
