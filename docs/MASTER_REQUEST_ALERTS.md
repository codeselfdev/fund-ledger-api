# Automatic master-admin request alerts

Customer support messages (`support_message`), subscription plan requests (`billing_upgrade`) and payment-proof submissions (`billing_payment`) automatically queue email and device push for the configured master admin. Team support replies do not notify the master again. Signup and account-deletion alert routing is unchanged.

## Rollout

1. Apply additive migration `20261025130000_master_request_alerts` through the normal deployment migration process, after the existing platform-support, alert, billing-proof and impersonation migrations.
2. Run `npm run prisma:generate`, build and deploy/restart the API. `startMasterAdminAlerts` runs immediately and every 15 seconds; shutdown stops its timer.
3. Reuse `MASTER_USER_EMAIL` (or `Master_user_email`), optional `MASTER_USER_ID`, `MASTER_WEB_ORIGIN`, existing SMTP and Firebase Admin configuration. No new secret is required and no secret belongs in Expo public variables. The master code remains required by private administration but is not needed to deliver generic background alerts.
4. Sign into the native app as the pinned master account and allow notifications so its FCM device registration is saved. Without a user-ID pin, matching active accounts must have a recorded Google/email-verified normal session. A current profile email alone does not prove master identity. Receiving alerts does not require a current/fresh web session or paid subscription.
5. Release the matching mobile and web changes. Native taps open `https://fundnesta.appnesta.com/support/admin` with request-routing parameters. The browser still requires a recent verified master login and the security code. Custom staging/local web origins work for emails but are deliberately not accepted as production native admin-push destinations.

The migration adds `master_alert_deliveries` and a nested `PlatformAlert` insert trigger. Existing support-message triggers and billing upserts already run inside their source transactions, so both master channels commit with the request, roll back with it, and deduplicate retries. It does not backfill historical requests or change existing customer records.

## Delivery and recovery

Email and push use separate rows, leases, attempts and sent markers. Successful channels are never deliberately resent during another channel's retry. Provider failures remain pending indefinitely with exponential backoff capped at one hour. Missing master identity, SMTP, Firebase or registered devices waits without consuming attempts and is retried after configuration/registration is fixed. Email continues when push is unavailable.

Push looks up active master accounts by current configured email and optional exact ID, excluding organizations undergoing cleanup. Without the ID pin, normal verified-email session provenance is mandatory; impersonation sessions cannot qualify. Shared device tokens are deduplicated. Accepted devices are checkpointed by SHA-256 hash; raw tokens are not stored in this outbox. A failed device retries independently of accepted devices. Invalid registrations are cleared only from matched master accounts. Master identity is rechecked before subsequent device sends if configuration rotates.

Push text contains a generic request notice. Email includes the organization name and request reference. Both link to the private admin page; no request body, screenshot, payment receipt, master code, grant or bearer token is embedded. Email is delivered to the configured master address independently of the optional `PLATFORM_ALERT_EMAILS` list. For new requests with dedicated master rows, the legacy worker removes that address from its recipient list to prevent duplicates; remaining operational recipients and Telegram retain their existing behavior. Legacy `emailSentAt` can mean delegation when the master is the only legacy email recipient; use `delivery.master_email` and `delivery.master_push` for actual master-channel status. Internal alerts include per-channel retry/error metadata. Historical alerts without the new rows retain their original routing.

Requests in organizations undergoing cleanup are skipped, and the outbox follows its parent alert's cascade/deletion order. A worker crash after provider acceptance but before its checkpoint can still cause an at-least-once duplicate. Provider acceptance is not a confirmed read or guaranteed device display. Native notification permission and a valid device registration are required for push.

The protected invoice GET `/v1/support/admin/billing/:tenantId/invoices/:invoiceId` supports notification links even when the invoice is outside the first queue page or has already been reviewed. It uses the same master-session/grant checks and private audit as the other admin routes. Source links and metadata cannot bypass those checks or switch a master into the customer's account.

## Verification

```sh
npm run prisma:generate
npm run build
node --test tests/master-alerts.test.mjs tests/billing-alerts.test.mjs tests/billing-payment-proofs.test.mjs tests/migration-integrity.test.mjs
SMTP_USER='' SMTP_PASS='' NODE_ENV=test node --test tests/impersonation.routes.test.mjs tests/platform-admin.test.mjs
```

`tests/master-alerts.integration.test.mjs` requires `MASTER_ALERT_TEST_DATABASE_URL` and refuses everything except localhost database `fundnesta_master_alerts_test`. It creates and removes its own isolated schema, applies the actual prior alert/support trigger and new migration, verifies source retries, rollback, no historical backfill, and persisted delivery against mocked providers. It sends no external email or push. Leave this variable unset in normal production environments.

Verification during implementation passed against a disposable PostgreSQL 17 container. No production migration, configuration change or live delivery was performed.
