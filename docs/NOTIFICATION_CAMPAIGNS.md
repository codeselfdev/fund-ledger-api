# Admin notification campaigns

Admins and owners can send project-scoped in-app notifications with optional FCM push and email. The mobile entry is **Profile → Send notification** for fund projects and **More → Send notification** for accounting, billing and construction projects.

## Deploy

1. Deploy the matching API and run `npx prisma migrate deploy` followed by `npx prisma generate` and `npm run build`.
2. Restart the API. The campaign worker starts automatically, polls every five seconds, and processes up to 100 pending deliveries per pass. Pending work persists across restarts.
3. Configure the existing `FCM_SERVICE_ACCOUNT_JSON` / `FIREBASE_SERVICE_ACCOUNT_JSON` and SMTP settings on the API. Missing provider configuration produces failed channel attempts, never successful delivery counts.
4. Ship the matching mobile build. Email links use the registered `fundledger://notification` app scheme; the app must be installed to open those links.

The additive migration is `20261014230000_notification_campaigns`. It creates campaigns and delivery rows and adds nullable `notifications.destination`. Do not run the new worker against an unmigrated database.

## API (all paths under `/v1/notifications/campaigns`)

All endpoints require an active project (`X-Project-Id`) and owner/admin access. Tenant, project and actor come from authenticated context, never from the request body.

- `GET /audiences`: project members, account/device/email eligibility and all/dues/staff counts. No raw email addresses or device tokens are returned.
- `POST /preview`: validates the draft and returns a personalized sample, actual reach, unreachable count and `preview_token`.
- `POST /`: `{ draft, request_id, preview_token }`; `request_id` is a UUID reused on network retries. Atomically creates one campaign and its delivery snapshots. Changed recipients, eligibility or balances require a fresh review.
- `GET /`: latest 100 campaigns with per-channel accepted, failed, pending and skipped totals.
- `POST /:id/retry`: queues only failed deliveries in the authenticated project. Successful channels are never retried.

Draft fields: `audience` (`all`, `due`, `staff`, `pick`), `recipient_ids` (opaque IDs from audiences, required for pick), `title` (3–65), `body` (3–500), `push`, `email`, `destination` (`none`, `dues`, `schedules`, `notices`, `pay`). In-app is always included for recipients with active project accounts. All/dues target active financial members; staff targets active owner/admin/accountant/approver/auditor/cashier memberships. Multiple roles are deduplicated. An empty pick never broadens to everyone. Explicit campaigns include the sending admin if selected.

Known tokens `{first_name}`, `{due_amount}`, `{project}` are replaced per recipient in both title and body. Amounts use the ledger's whole-taka units and account for waived principal.

## Delivery and navigation

The worker rechecks project and recipient access at delivery time. It creates inbox notifications idempotently, sends FCM data containing `tenant_id`, `project_id`, campaign entity ID and `destination`, and sends email links with project and destination. Inbox delivery is stored locally; push/email success means provider acceptance, not device display, inbox placement or read receipt. There is no email bounce webhook.

Push/email operations cannot be atomically committed with a database transaction. An attempt interrupted for ten minutes is marked failed with an unknown-outcome error, requiring an explicit retry; such retries may duplicate an already accepted message. Workers use conditional claims to avoid concurrent sends. Provider errors are logged without contact details or device tokens.

The app defers cold-start taps through hydration/sign-in, validates project membership, switches to the target project, then opens the requested page. Failed switches never fall through into the old project. In-app taps and email links use the same path as FCM. `none` still retains project context and opens the project home page.

## Checks

API: `npm run build` and `node --import tsx --test src/modules/notification-campaigns/campaign.*.test.ts`.
Mobile: `npm run typecheck` and `node --test tests/notification-campaigns.test.cjs tests/push-notifications.test.cjs`.
