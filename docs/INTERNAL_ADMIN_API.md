# Fund Nesta support and internal administration

## Deployment

Apply migration `20261016140000_platform_support`, regenerate Prisma Client and deploy the API before distributing the matching mobile build. The migration adds support conversations/messages/screenshots, app-use observations, manual organization payments, operator audit and cleanup jobs. It also adds a tenant deletion marker and changes assistant allowance periods from DATE to TIMESTAMP(3), preserving old dates at midnight so more than one reset per day works.

Configure `INTERNAL_API_KEY` in the **backend** environment using a random secret of at least 32 characters. Missing or short configuration disables internal APIs with 503. There is no default key. SMTP credentials and `APP_DOWNLOAD_URL` are required for normal invitation delivery; the member-profile invitation uses the Android Play Store URL if no download URL is configured. Storage uses the existing R2/local configuration. No production migration, payments, invitations or deletions are run by this source change.

The internal web application's authenticated **server/proxy** calls these APIs. Never put the key into browser JavaScript, an Expo public variable, a public URL or a mobile build. Authenticate operators in that web app and supply their stable operator identifier as `X-Internal-Actor` for every write and export. This identifier is asserted by the trusted internal app; the API key itself authenticates the service. Use HTTPS and keep the proxy restricted to authorized operators.

Headers:

```http
X-Internal-Api-Key: <server-side INTERNAL_API_KEY>
X-Internal-Actor: <authenticated operator identifier>
Content-Type: application/json
```

Base path: `/v1/internal`. Ordinary app JWTs and provisioning API keys do not grant access. The key is accepted only in its header, never query parameters. Responses use the existing `{ ok: true, data: ... }` envelope; validation errors use 400, denied keys 401, stale/conflicting operations 409. XLSX/images return binary responses. Internal responses are not cacheable.

## Monitoring

| Method | Path | Result |
| --- | --- | --- |
| GET | `/summary` | Global organization count, usage counts, notification delivery counts by channel/status, active upload bytes |
| GET | `/tenants?offset=0&search=...` | Up to 50 organizations with all summary fields and `next_offset` |
| GET | `/tenants/:id` | One organization's summary, current capacity quotas and AI/WhatsApp allowances |
| GET | `/tenants/:id/payments?offset=0` | Up to 50 manual subscription-payment records and `next_offset` |

Counts include projects, financial member/share rows, organization user rows, expense rows, manual-income rows, fixed assets, deposits, notices, polls, votes, events, notification campaigns, inbox notifications, bank/cash accounts, receipts, active uploads, retained deleted uploads, payment-proof attachments, member profile photos, logos, other uploads, support requests/screenshots, generated report records, native app observations and web observations. Repeated member/share rows count separately; users are account rows, not a global count of unique humans. `sent_notifications` contains successful campaign deliveries by channel. Inbox records/campaigns are separate measures and must not be added as unique recipients.

`documents` is the active `Upload` count used for plan capacity; deleted uploads awaiting retention cleanup and support screenshots are separate counts. `report_exports` counts report records, not the number of XLSX files or storage orphans. Stored objects outside Upload (for example generated reports) are nevertheless included in full tenant cleanup. Monitoring does not scan every R2 object. Document groups classify `payment_proof`, `member_photo:*`, `project_logo` and all remaining/null purposes. Bytes report active Upload sizes; screenshots are excluded from paid document quotas so support remains available after expiry.

Dates include `created_at`, `last_payment_at`, `trial_expires_at`, `paid_period_expires_at`, `first_app_seen_at` and `last_app_seen_at`. Legacy payments use the invoice approval date because a separate bank payment timestamp was not stored. Manual payments use their supplied `paid_at`. `install_date` is null: the backend cannot determine the device's real installation time. New mobile builds record the first authenticated native app visit separately from web use. No observation does not prove the app is uninstalled.

## Manual payment and plan activation

`POST /tenants/:id/payments`:

```json
{
  "request_key": "04869f0b-0d99-4dbf-89f4-0e8bd1061ef8",
  "package": "business",
  "billing_cycle": "monthly",
  "amount": 5000,
  "currency": "BDT",
  "method": "bank",
  "reference": "BANK-TRANSACTION-REFERENCE",
  "paid_at": "2026-10-16T19:00:00+06:00",
  "notes": "Payment checked by the operator"
}
```

Package: `starter`, `business` or `custom`; cycle: `monthly` or `yearly`; method: `cash`, `bank`, `bkash`, `nagad`, `card` or `other`. Amounts are positive whole currency units, at most 2,147,483,647, not minor units. Currency must match the organization. Future payment dates are rejected. Notes are optional.

The transaction stores the payment, activates the chosen package immediately, preserves remaining prepaid time when extending expiry, and resets both implemented monthly allowances (AI replies and WhatsApp bot replies) immediately. Existing projects, users, documents and financial records remain counted and unchanged. The returned `quota` contains actual current usage and the new limits; a downgrade over capacity prevents new capacity-consuming actions until usage fits. This records subscription revenue for the platform; it does not create income in the customer's project ledger.

Reuse the same request key and payload after a timeout. A replay returns `replayed: true` without extending coverage, charging another payment or resetting usage again. Changed content under the same key returns 409. A tenant already frozen for cleanup cannot accept a payment. Existing customer-submitted invoices are not automatically matched or approved by this endpoint; review those through the existing billing workflow to avoid approving the same payment twice.

## Organization financial workbook

`GET /tenants/:id/export.xlsx` exports all projects. Add `?project_id=...` for one project; a foreign project's ID returns 404. Requires `X-Internal-Actor` and creates an export audit entry.

The workbook has Summary, Projects, Member summary, Member dues, Bank and cash summary, Ledger, Expenses, Income, Deposits, Fixed assets, Accounting documents, Billing invoices and Billing payments tabs. All financial queries share a repeatable-read snapshot. Member summary includes principal paid, penalty paid, waived amounts, outstanding dues and confirmed deposits net of refunds. Imported historical paid amounts remain in due paid balances and are not invented as cash receipts. Do not add paid-against-dues to confirmed deposits: they measure different parts of the same financial activity. Income contains manual income entries; Ledger includes all bank/cash movements. Identity/account number values and untrusted text remain string cells, never executable formulas.

Large requests fail with 413 rather than silently truncating rows: 100,000 rows per source table and 300,000 total source rows. Export by project if needed. This is a summaries/reporting export, not a restorable database or R2 backup.

## Team replies to support

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/support/tickets?offset=0&status=open&tenant_id=...` | List up to 30 requests across organizations, optionally filtered |
| GET | `/support/tickets/:id?offset=0` | Ticket plus latest 30 messages, returned oldest-to-newest within that page |
| POST | `/support/tickets/:id/messages` | Reply as Fund Nesta team |
| PATCH | `/support/tickets/:id/status` | `{ "status": "resolved" }` or `open` |
| GET | `/support/attachments/:id` | Authenticated screenshot bytes |

Message POSTs accept multipart fields `request_key` (UUID), `body` (up to 10,000 characters), and up to three `files` parts. Text or at least one file is required. Files must have JPG/PNG/WebP content signatures and be at most 5 MB each. Use `FormData`; let the HTTP client set its multipart boundary. JSON works for text-only replies. Reuse the request key and exact message/files after a failed request; different content under the same key returns 409. A message reopens a resolved conversation. Attachments and team replies are stored privately. Team replies appear in the app on refresh or while the conversation is open (20-second polling in the foreground); this feature does not send support emails or push notifications.

## Permanent organization cleanup

Eligibility is **three calendar months after the paid subscription expiry**, and no paid subscription or trial may still be active. Trial-only organizations without a paid expiry are excluded from full deletion. Existing trial-document retention behavior remains separate.

1. `POST /tenants/:id/cleanup` with `{}` or `{ "dry_run": true }` returns eligibility, all tenant-scoped table counts, an exact `confirmation` string and a signed `preview_token`. It deletes nothing.
2. After the operator reviews the result, call the same endpoint with `{ "dry_run": false, "confirm": true, "preview_token": "...", "confirmation": "DELETE exact-slug" }`. The token expires in 15 minutes; changed organization/payment state requires another preview.
3. The start transaction checks foreign references/shared organization login identities and legacy storage paths before freezing the organization, deactivating its accounts/projects, revoking sessions and stopping scheduled reports/recurring schedules/queued notifications. It creates a durable job without erasing records yet.
4. `POST /cleanup-jobs/:jobId/run` performs a bounded batch. There is a five-minute settling period after freezing to allow in-flight requests to finish; the response includes `run_after_at` while waiting. Thereafter, each call purges at most 25 objects under the exact organization storage prefix, including orphan objects. Repeat until `status` is `completed`; do not retry concurrently. `GET /cleanup-jobs/:jobId` reports progress.
5. Only after storage is empty does a transaction remove tenant-scoped PostgreSQL rows in FK dependency order and delete the organization. Storage failures retain the DB rows and a retryable job. Shared-identity/foreign-reference conflicts require relinking before a fresh start; cleanup never follows another tenant's references or deletes its object prefix.

This is an explicit API operation, not an automatically scheduled bulk purge. It is irreversible after object deletion starts. Full tenant data, uploads, reports and support screenshots are removed. Minimal operator audit entries and the completed job (IDs, action, timestamps and count; no customer contacts or file contents) are retained outside the organization. Global, short-lived OTP records are not tenant-scoped and are excluded to preserve other organizations using the same phone. R2 bucket-wide deletion is never used. Local storage symbolic links stop cleanup rather than following them.

## Mobile endpoints

User support endpoints use `/v1/support` and the normal Bearer token, without an active project or subscription requirement. Users can list/read/reply only to their own conversations, including screenshots. `POST /tickets` accepts the same multipart message fields plus a 3–160-character `subject`; `POST /tickets/:id/messages` replies; GET/list/status/attachment paths match the team API. `POST /tickets/:id/read` acknowledges replies. `POST /installations` accepts `installation_id` UUID, `platform` (`android`, `ios`, `web`) and optional `app_version`, preserving the first observation on retries.

Member profile: `GET /v1/members/:id/invitation` returns saved email, first native app observation and the last invitation status. `POST` accepts `{ "request_key": "UUID" }`. Owner/admin and active project membership are required; ordinary members/accountants cannot send. The member must be active and have a saved valid email. The linked account and member role are ensured before emailing. A replay does not send twice; resending requires a new key and at least one minute between requests. `sent` means accepted by the configured mail transport, not confirmed inbox delivery or installation. `sending` after an interrupted server request needs an operator check before a new send, because SMTP cannot provide an atomic exactly-once guarantee.

## Verification

TypeScript builds, focused regression tests and `platform-admin.test.mjs` use synthetic fixtures. `platform-support.integration.test.mjs` is opt-in (`RUN_PLATFORM_INTEGRATION=true`) and refuses every database except localhost database `fundnesta_verify`. It verifies actual PostgreSQL transactions/constraints, quota triggers, late-added email invitation (mocked SMTP), support ownership/screenshots/replies, same-day repeated quota resets, export scoping, cleanup eligibility/stale tokens/shared identities and removal of every tenant-scoped model while preserving another tenant and its files. It never targets the deployment database. Production SMTP and R2 network delivery still require environment verification.
