# Global users, tenant memberships and subscription records

The database has one authoritative location for each responsibility:

| Table | Responsibility |
| --- | --- |
| `users` | Global identity, canonical unique email and canonical unique mobile; global suspension |
| `tenant_users` | Unique `(tenant_id, user_id)` organization membership, organization activation, device and organization profile/activity |
| `project_memberships` | Per-project roles and financial-member linkage |
| `tenant_subscriptions` | One current entitlement per organization, billing cycle, trial/paid dates, quota reset and revision |
| `subscription_invoices` | Typed invoices, original agreed prices, proof submission state and approval dates |
| `subscription_history` | Immutable entitlement revisions with before/after snapshots, event and invoice/payment/actor references |

`tenants.plan` and `contact.subscription` are retired. Invoice arrays are removed from `contact.billing`; unrelated billing settings and other contact data are preserved. Policy inputs are assembled with `subscriptionContext(tenant)` from the subscription relation. They never read entitlements from persisted contact JSON.

## Identity and API compatibility

Existing `users` IDs become `tenant_users` IDs. All financial-member, project-role, audit, notification and session references keep these organization account IDs. The `users` table now holds one global identity. Existing explicit identity roots retain their IDs as global user IDs. Fresh global IDs and organization account IDs may differ.

The organization-scoped API continues returning the organization account ID in `user.id` and accepting it in existing `user_id` fields. `identity_root_id` is a compatibility response name for the global user ID. Neither value grants access without an active organization membership and project role. `tenantAccounts(db)` is the explicit repository for an organization account projected with its global identity; `db.user` accesses the global identity itself. New code must not query global users using `tenantId`.

Email is trimmed/lowercased and unique when present. Mobile is canonical international format and unique when present. Bangladesh national forms normalize to `+880…`. Email-only users persist NULL mobile; legacy Google/email placeholders are removed. At least one contact is required. Organization-specific member contact edits do not replace login contacts. A user's self-profile may change their global display name. Login-contact replacement requires a separate verification flow and is rejected by the organization account repository.

Organization suspension affects only `tenant_users.is_active`. Global suspension also blocks every session and organization. Removing an organization membership preserves another organization's membership; account deletion removes the global identity only when its last organization account is removed.

## Migration and rollout

1. Back up the database and run `node scripts/audit-user-identities.mjs` using the intended **pre-migration** backend environment. It is read-only and outputs account IDs and conflict types, without contact values or credentials. Exit 2 means conflicts need resolution. Invalid links, duplicate memberships within an organization, conflicting linked credentials/contacts and duplicate contacts across unlinked roots block migration.
2. Resolve each conflict using verified ownership. The migration only consolidates existing explicit identity links. It never decides that two unrelated accounts are one person because their email/mobile matches. Re-run preflight until `ready` is true.
3. Pause API/worker writes and apply all migrations, including `20261030010000_normalize_subscriptions` then `20261030020000_global_users_and_tenant_memberships`. These migrations are transactional; malformed subscription/invoice values and identity conflicts roll back their respective migration. Missing subscriptions become inaccessible expired records, without granting a fresh trial.
4. Regenerate Prisma, build, and start this backend and workers together. Old backend binaries cannot run against the renamed tables. The existing mobile API shape is retained. Update operator/demo scripts with the deployment.
5. Verify organization switching, an existing paid organization, quota enforcement, owner-only billing history, invoice review and reminders. Reopening an approved payment is idempotent and never extends dates twice.

Subscription history begins with a `migrated` baseline for existing state. It does not invent previous subscription changes that were never recorded. New trials, approved invoices and manual payments write a new revision in the same transaction as the entitlement. A rejected invoice does not change entitlement; invoice decisions continue to be audited as activity events. Direct database subscription edits also advance the revision and append a fallback history event at commit. Ordinary history updates/deletes are rejected by PostgreSQL; organization deletion may cascade its history.

`GET /v1/subscription/history?limit=50&cursor=<revision>` returns owner-only history for the current organization, newest first, with a `next_cursor`. Invoice list and submission APIs retain their existing response shape and use relational rows.

## Validation

Use a disposable local PostgreSQL database, apply every migration, then run:

```sh
npm run build
node --test tests/user-identity-preflight.test.mjs tests/migration-integrity.test.mjs
NORMALIZATION_TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:55439/fundledger_test \
  node --test tests/normalization.integration.test.mjs tests/normalization-migrations.integration.test.mjs
```

The integration suites refuse non-local URLs or database names without `_test`. They cover global contact uniqueness, email-only identities, concurrent membership/invoice writes, organization switching, suspension boundaries, cross-tenant references, receipt approval, history rollback/immutability, renewal idempotency and populated legacy backfills. Provider calls are not required. Migration tests create and drop their own child databases.

No production migration or deployment is performed by this code change.
