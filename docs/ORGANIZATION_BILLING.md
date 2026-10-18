# Independently owned organizations and manual subscription billing

Any authenticated user can create an independently billed organization and its first project using `POST /v1/projects/owned-organization`. The body requires `organization_name`, `name`, `total_shares`, and optionally `project_type`, `address`, `owner_is_member` (default false). This never adds a project or elevates the actor's role in the previous organization. The server creates a separate tenant and organization-local user, an owner membership, default Cash account and completed/skipped optional onboarding. Fund/Share owners can configure accountant roles later; admin-direct approval applies when no accountant exists. The response includes `tenant_id`, `project_id`, roles and optional member link.

A nullable `users.identity_root_id` explicitly links accounts created through this authenticated operation. Existing identities are never merged using email or mobile matching. Existing organization-scoped JWT/session validation and operational membership filters remain unchanged. `GET /v1/projects` and `/v1/auth/me` expose only active projects granted to accounts within the explicit identity group. Memberships include `tenant_id`. Discovery and creation remain available after subscription expiry or loss of the previous project role.

`POST /v1/auth/switch-project` accepts `project_id`. Same-organization switching retains the existing token. Cross-organization switching verifies the explicit identity link and active target membership, then returns a new organization-scoped login payload with `token`, `user`, `tenant`, `identity_root_id`. Mobile must hydrate `/auth/me` using that new token and validate the identity root, target project, user, organization and membership before persisting. Role and member linkage come only from the target project's memberships. Switching back restores the original organization role. Clients must not send the old token to target operational APIs.

New organizations receive three calendar months free (month-end dates are clamped), not a fixed 90-day approximation. Existing trial and paid-period records are retained. Expiry blocks operational APIs with 402. Billing, payment submission, discovery and switching remain available. No unpaid invoice is generated automatically: the operator issues one if a renewal payment is needed, choosing the yearly amount and instructions. Amounts are positive whole currency units; no hardcoded price.

## Owner payment flow

- `GET /v1/subscription` returns access status, trial end, paid period end and `can_manage_billing`.
- `GET /v1/subscription/invoices` is restricted to organization management.
- `POST /v1/subscription/invoices/:id/payment` requires `multipart/form-data`: `payment_reference` (3–200 characters), `payment_amount` (positive whole currency units matching the invoice), `request_key` (a UUID generated once per submission), and one `receipt` file (JPG/PNG/WebP/PDF, 1 byte–5 MB). A reference alone is rejected. Submit proof only after paying; this endpoint never restores access.
- Exact retries with the same request key and evidence return the existing submission without duplicate receipts, audit entries or alerts. A different payload using that key is rejected.
- Billing receipts use separate private storage and do not consume the normal document quota. Submission remains available after subscription expiry or at a full document quota. `GET /v1/subscription/invoices/:invoiceId/receipts/:receiptId` requires organization management and exact tenant/invoice scope.
- Rejected submissions show the operator's reason and can be resubmitted. Already submitted payments cannot be overwritten while being reviewed.
- The previous customer `/subscription/renew` and `/subscription/trial` routes return 403. Tenant contact updates reject reserved subscription/billing fields.

## Trusted billing operator

These endpoints require the existing server-side provisioning API key, not a customer JWT. Never store this key in mobile:

- `GET /v1/platform/billing/:tenantId/invoices`
- `POST /v1/platform/billing/:tenantId/invoices` with `{ "amount": 2500, "currency": "BDT", "instructions": "Your manual payment instructions" }` (example amount only).
- `GET /v1/platform/billing/:tenantId/invoices/:invoiceId/receipts/:receiptId` serves private evidence to the authenticated admin proxy.
- `POST /v1/platform/billing/:tenantId/invoices/:invoiceId/review` with `{ "decision": "approve", "expected_payment_request_key": "uuid-from-reviewed-invoice" }` after verifying the receipt, amount and bank record; or `{ "decision": "reject", "reason": "Payment not found", "expected_payment_request_key": "uuid-from-reviewed-invoice" }`. A changed submission is rejected until the operator reloads and reviews it. Legacy submissions without complete proof must be rejected and resubmitted before approval.

Alternatively, on the trusted backend host use `npm run billing -- list ORG`, `npm run billing -- issue ORG AMOUNT "INSTRUCTIONS"`, `npm run billing -- approve ORG INVOICE`, or `npm run billing -- reject ORG INVOICE "REASON"`. Production equivalents use `billing:prod` after compilation. CLI actions require backend/database access and perform real writes.

Approval atomically records the invoice and activates the invoiced package for its monthly or yearly cycle, extending from the later of now or its existing trial/paid end (legacy renewal invoices default to yearly). Retrying approval never grants another year. Rejection does not renew access. Optimistic concurrency on tenant `updatedAt` prevents competing billing approvals, and contact writers include the same precondition to avoid undoing a concurrent approval. Every billing mutation is audited in its transaction. Invoices remain in tenant contact JSON. Private receipt metadata is stored in `subscription_payment_receipts`. Receipt, invoice state, audit and the payment alert commit in one database transaction; failed writes remove newly staged file data.

## Billing request inbox

The admin portal’s **Billing requests** menu lists current `open` (awaiting payment) and `submitted` (awaiting approval) invoices across organizations. `GET /v1/internal/billing-requests` accepts `offset`, optional `status` (`open` or `submitted`) and optional `search` (organization name/slug, invoice ID or transaction reference). Results prioritize submitted proofs and paginate by 30. `GET /v1/internal/billing-requests/counts` returns global `pending`, `awaiting_approval` and `awaiting_payment` counts, independently of filtering, pagination, notification delivery and read state. Both reads require the internal API key. Invoice review and receipt access retain their provisioning-key authorization. Reading the queue never changes billing state.

Counts use current invoices rather than duplicated upgrade/payment events. Approved/rejected invoices and organizations whose cleanup has started are excluded. The portal refreshes badges and active lists every 30 seconds and after review. Deploy the matching backend and local portal code; the inbox needs no new schema migration beyond the receipt flow above.

## Superadmin notifications

New upgrade requests and submitted payment proofs create durable `billing_upgrade` / `billing_payment` entries in the same `PlatformAlert` queue used by signup and support. They appear unread in **Activity & alerts**, with a link into the organization’s Billing tab. Approving payment from that tab activates the requested plan; requesting an upgrade alone never changes access.

The existing production `PLATFORM_ALERT_TELEGRAM_CHAT_ID`, `TELEGRAM_BOT_TOKEN`, `PLATFORM_ALERT_EMAILS` and SMTP configuration are reused. No new Telegram group, bot, webhook, email settings or per-organization integration is needed when signup/support alerts already work. Email/Telegram text includes the requested package, cycle, invoice amount, paid amount, reference and receipt filename. Evidence is opened through the authenticated portal rather than a public attachment URL.

`ADMIN_WEB_URL` controls review links only. While the portal runs locally against the production API, notifications still deliver without it; open the local portal and review **Activity & alerts**. An HTTPS portal URL enables a Telegram review button. Do not expose a localhost URL as a publicly reachable portal. The inbox shows missing configuration separately from exhausted retries and allows retrying failed channels without resending successfully delivered channels.

## Rollout and validation

Deploy the backend migration `20261019000000_subscription_payment_proofs`, regenerate Prisma, build and restart the API, then use the matching mobile and admin portal releases. Existing production alert destinations should be preserved. This task does not modify production environment values or deploy the API. The migration adds the receipt table and backfills alerts for outstanding upgrade/payment requests; it never approves them. Old reference-only submissions remain reviewable but require rejection/resubmission with complete proof. Older app versions cannot submit reference-only payments after this rollout.

For the local portal, retain its production `FUND_NESTA_API_URL`, `INTERNAL_API_KEY` and `PROVISIONING_API_KEY`; restart it after updating the code. Confirm a new upgrade/payment request appears in the local inbox, then inspect the email and Telegram delivery markers. Manual approval must follow receipt and bank verification.

Automated validation covers real HTTP multipart submission against disposable PostgreSQL, migration/backfill idempotency, tenant-scoped receipt access, unchanged-proof approval, duplicate requests, rollback, and independent mocked email/Telegram retries. Mobile and portal component tests cover mandatory receipt/amount, rendering, proxy access and confirmation guards. No test contacts real providers or the production database.


Additive migration `20261011100000_linked_organization_identity` adds the nullable identity link, index and foreign key. It does not relink, delete or migrate existing financial data. Apply only after normal database backup and migration review; this task does not deploy or run live database migrations. Generate Prisma client and build the backend before deploying a matching app. Older servers return 404 for the new organization creation endpoint instead of accidentally creating a project in the previous organization.

Regression tests mock persistence and run real auth, projects, tenant, subscription and billing routers. They verify all seven starting roles, identity spoofing, foreign/revoked membership rejection, scoped token isolation, returning to member access, optional financial links, trial boundaries, manual approval and idempotent/concurrent renewal.
