# Reports and integrations

## Rollout

1. Install dependencies (`npm ci`), generate Prisma (`npx prisma generate`), and build (`npm run build`).
2. Back up the database and apply `npx prisma migrate deploy`. The additive `20261015000000_reports_integrations` migration creates schedules, exports, delivery logs, Telegram pairings/connections and integration post logs. No existing ledger tables are modified.
3. Keep `REPORTS_AUTOMATION_ENABLED=false` while reviewing the feature and configuring recipients. Background delivery starts only when this server setting is explicitly `true`, and requires an admin to save an enabled schedule or enable Telegram preferences.
4. Configure SMTP through existing `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. Without SMTP, email attempts fail visibly rather than being reported as delivered.
5. Configure the Telegram bot as described below. Set report recipients and destinations in the app. Enable server automation only after reviewing those selections.

This implementation does not change production configuration or run database migrations automatically.

## Telegram

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (without @), and a strong random `TELEGRAM_WEBHOOK_SECRET`. Register `https://<public-api>/v1/integrations/telegram/webhook` using Telegram's `setWebhook` API, supplying the same `secret_token` and `allowed_updates: ["message"]`. Keep the bot token and webhook secret on the server. Do not place them in mobile environment variables. See https://core.telegram.org/bots/api#setwebhook.

Admins initiate a pairing in the app, add the bot to a group and ask a group administrator to send the displayed `/connect FL-...` command. Slash commands are used so the bot can receive pairing messages with Telegram privacy mode enabled. Codes contain 64 random bits, are stored hashed, expire after ten minutes, are scoped to the initiating tenant/project/admin, and are atomically consumed after app confirmation. The first verified group wins. The webhook requires the secret header and verifies that the Telegram sender is a group administrator. Confirming also checks bot membership. Only one project may connect to a given group.

Group members can see every posted report and enabled member-dues reminder. Preferences persist on the connection. Notices and large expenses are processed after the connection/preferences were enabled; weekly dues run Monday after 09:00 Asia/Dhaka. Reports require both the connection's Daily report preference and the report schedule's Telegram destination. WhatsApp report file delivery is deliberately unavailable. Email and FCM continue to use server-level configuration; the hub shows configured status and registered device counts rather than claiming provider health.

## Reporting behavior

Routes live under `/v1/reports` and `/v1/integrations`. Configuration, export generation, sending and integration mutations require owner/admin project access. Reads include tenant and project predicates. A non-admin can read/download a specific report only if an inbox delivery for that report exists for that user. Report files are stored through the existing local/R2 storage adapter, never exposed as public URLs or generic uploads.

Exports use a repeatable-read ledger snapshot. Daily summary, member statements and account balances are as of generation time. Income/expense uses the selected local period; explicit date-only income entries retain their accounting dates. The bank/cash sheet includes both transfer sides, while income/expense excludes internal transfers. Member dues account for waivers and unpaid penalties. Untrusted names/descriptions are encoded as string cells, not formulas. The workbook generator limits transaction/member sheets to 100,000 rows and returns an explicit error above the limit. Previews contain the header and first twenty rows. Current member statements cover contribution dues; specialized billing/construction receivables remain in their existing reports.

Daily schedules use IANA zones and weekdays. A unique project/local-date slot prevents duplicate schedule runs across replicas or repeated DST hours. The worker catches up today's missed time after restart; saving settings after today's send time takes effect from the next selected day. It rechecks active project, subscription and the schedule author's admin access. It does not backfill prior days.

Deliveries have a unique export/channel/target key and an atomic pending/failed claim. Retry sends only failures, and skips successful destinations. Telegram attachments have separate delivery claims so a partial send does not resend successful files. Retrying an old Telegram delivery after the group changed is rejected. External providers do not support a common transactional idempotency key: an interrupted delivery becomes `unknown` after ten minutes so operators can verify the destination instead of causing an automatic duplicate. Failed/unknown sends and generation failures are shown in export history.

Exports and delivery logs are retained until their project is deleted; plan a retention policy appropriate to your organization. Failed storage writes can leave partial objects under that export's storage folder for operator cleanup. Existing generic activity/audit records track schedule edits, exports, sends and Telegram changes without credentials.

## Validation

`npm run build`

`node --test tests/reporting.test.mjs tests/migration-integrity.test.mjs`

These tests use mocked Prisma/provider calls and a local HTTP server. No live database migration, SMTP or Telegram delivery is exercised. For rollout validation use a non-production project, test inbox delivery, an authorized email recipient and a test Telegram group, then inspect per-destination logs. Native file-picker/share behavior must be verified on Android/iOS.
