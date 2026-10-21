# Billing home API

The mobile billing home follows the supplied Billing Home Mobile HTML design. Existing Billing Management APIs remain available.

- `GET /v1/billing/home?month=YYYY-MM`: project-scoped financial summary, today receipts (Asia/Dhaka), unpaid customer previews, pending adjustments, open complaints, active subscription count and email reminder delivery counts. The summary is computed in a serializable snapshot from the full ledger; preview limits never truncate totals. Monthly receipt totals and settlement of current-period invoices are distinct fields.
- `POST /v1/billing/subscribers`: atomically create a customer, unit, active fixed monthly subscription and optional current-month invoice. Body: `{customer:{name,mobile?,email?,address?,attributes?},unit_name,plan_id,start:"this_month"|"next_month",request_key}`. Customer fields honor configured validation. Existing units must be assigned through the normal subscriptions API. Request keys persist via a scoped audit marker; payload changes using the same key are rejected. Only owner/admin/accountant may write.
- `GET /v1/billing/complaints?status=open|progress|resolved&limit=50&offset=0`: bounded entries, total and next_offset. Status is optional.
- `POST /v1/billing/complaints`: `{customer_id,category,description,urgent,request_key}`. Owner/admin/accountant/cashier may log. The request is idempotent and verifies customer scope.
- `PATCH /v1/billing/complaints/:id`: `{status,assigned_to?}`. Owner/admin/accountant may assign, resolve and reopen; reopening clears resolved_at. Assignment is descriptive text. Mutation and audit records commit together.

Apply `20261021120000_billing_complaints`, regenerate Prisma and deploy the API before releasing the mobile UI. The migration adds one table and does not alter current billing balances. This work has not deployed or migrated a live server. Email reminders retain the existing dedupe/delivery mechanism. No SMS delivery or unattended monthly billing is introduced.

## Demo loader

The free Fund Nesta Review Demo organization is at its two-project limit. The user chose to prepare the sample loader and keep that organization unchanged. There is no live billing demo project or live fixture insertion from this change.

The guarded loader is in the sibling mobile repository: `FundLedgerMobile/scripts/seed-billing-demo.cjs`. It expects a future empty billing project named **Green View Tower · Billing Demo** in that organization, the supplied reviewer login, administrator access and a zero-balance cash account. It does not create organizations/projects, upgrade plans, delete data or send reminders. Sample contacts have reserved test numbers and no email; invoice/receipt mail hooks queue no messages. It creates actual recurring invoices using assignment/month uniqueness, not detached mock totals. Fixtures reconcile 10 customers/units/subscriptions, 15 invoices, five payments, five complaints and two pending adjustments. It refuses unrelated activity and changed fixture financial records.

## Verification

`npm run build` and `node --test tests/billing.routes.test.mjs` cover access, invalid requests, totals beyond one page, customer grouping, project isolation, idempotency, complaint lifecycle and audit rollback.

`tests/billing-home.integration.test.mjs` runs only when `BILLING_TEST_DATABASE_URL` points at a disposable migrated database and `BILLING_MOBILE_ROOT` points at the mobile checkout. It creates a synthetic demo organization inside that database and exercises the real router and loader, checks invoice/payment/account reconciliation and no outgoing message rows, repeats the fixture, verifies invoice-cycle uniqueness and atomic subscriber creation/retries, then exercises complaint resolution with persisted audit records. All migrations and these integration tests passed with local disposable PostgreSQL.
