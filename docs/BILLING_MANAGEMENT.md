# Billing Management API and mobile integration

Project type `billing` has dedicated customer billing APIs under `/v1/billing`. This is separate from organization subscription renewal (`/v1/subscription` and `/v1/platform/billing`), Fund / Shares dues, and Accounting commerce documents. Requests use the existing bearer session, active subscription and `X-Project-Id`. Every financial query is scoped to the current tenant and project.

## Menus and permissions

`GET /v1/billing/configuration` returns billing settings, category examples, and ordered menus with `key`, `label`, `api` and `can_write`. Billing project list/detail/create responses also return `billing_menus`. Default accountant shortcuts are Customers, Invoices, Collections, Outstanding and Reports; managers can configure any billing shortcut through existing portal settings. Shortcut visibility never grants API permissions.

Menus: Billing Overview; Customers; Units & Connections; Subscriptions & Assignments; Billing Plans; Invoices; Payment Collections; Outstanding Dues; Adjustments; Billing Approvals; Meter Readings; Customer Ledger; Billing Reports; Reminders & Receipts. The mobile workspace includes shared Other Income, Expenses, Cash & Bank Accounts, Account Ledger and management-only Project Roles.

- Owner/admin/accountant manage customer billing, plans, assignments, readings, invoice generation and adjustment requests.
- Cashier can read billing and collect payments, but cannot issue invoices or request adjustments.
- Owner/admin/approver decide adjustments. The request creator cannot approve or reject their own request.
- Auditor reads billing. Members have no customer billing access; their shared finance menus remain available.
- Only owner/admin change billing configuration. Customer self-service remains a later phase.

Categories: `apartment_community`, `isp_subscription`, `rental_property`, `general_business`. A category is a persisted project default and a plan classification; free-form service lines allow maintenance, security, parking, utilities, internet installations, subscriptions, rent, deposits, fees and contracts.

## Endpoints

All JSON responses use `{ok,data}`. Dates are valid `YYYY-MM-DD`. Billing periods use the first day of a month. Amounts follow existing whole-currency integer conventions, up to 2,147,483,647 per persisted amount. Rates are whole-currency amounts; invoice quantities support three decimal places. Payment dates and fee/reminder `as_of` cannot be in the future. Customer invoice dates can be future dates.

| Method and path under /v1/billing | Behavior |
| --- | --- |
| GET /configuration | Settings, categories, role-aware menus |
| PUT /configuration | `{category,automatic_advance}`; manager only |
| GET/POST /customers | Shared customer profiles (name, optional mobile/email/address, active flag) |
| PATCH /customers/:id | Replace editable profile fields, optional `is_active` |
| GET /customers/:id/ledger | Invoice/payment/adjustment history, optional `from,to` |
| GET /customers/:id/statement.pdf | Printable statement, optional `from,to` |
| POST /customers/:id/apply-advance | Allocate unused customer credit to oldest outstanding invoices |
| GET/POST /units | Flat, shop, connection, property or service units |
| PATCH /units/:id | Full unit fields: name, kind, optional note, is_active |
| GET/POST /plans | Billing plan configuration |
| PATCH /plans/:id | Full plan fields; issued invoices retain their policy snapshots |
| GET/POST /assignments | Customer/plan/unit subscriptions; GET paginated |
| PATCH /assignments/:id | `{status,end_date?}`; active/suspended/disconnected/ended |
| POST /assignments/:id/invoice | `{period_start}`; idempotent by assignment/cycle |
| GET/POST /meter-readings | Read / record whole-unit consumption |
| GET/POST /invoices | List / immediately issue a one-time invoice |
| GET /invoices/:id | Detail with allocations and adjustments |
| POST /invoice-runs | Queue up to 5,000 assignments for a billing month; returns 202 |
| GET /invoice-runs/:id | Persisted progress and per-assignment result/error |
| GET/POST /payments | List collections / record payment with invoice allocations |
| GET /payments/:id/receipt.pdf | Printable receipt and allocation summary |
| GET/POST /adjustments | List / request adjustment; GET accepts `status` |
| POST /adjustments/:id/decision | `{decision:approve\|reject}`; independent reviewer |
| POST /late-fees/apply | `{as_of?}`; apply each eligible invoice's fee once |
| POST /reminders | `{as_of?}`; queue due/overdue customer emails |
| GET /messages | Email outbox and delivery status |
| GET /overview | `month=YYYY-MM`, defaults to current Dhaka month |
| GET /reports | Optional `from,to` collection and invoice date range |

Assignments/payments/invoices accept `limit` (1–200, default 50), `offset` and optional `customer_id`. Invoices additionally accept `outstanding=true`, return `{entries,total,next_offset}`, and filter derived balances before pagination. Assignments/payments return arrays. Messages accept limit/offset. Meter readings optionally filter `assignment_id`.

## Plans, subscriptions and readings

```json
{
  "name": "Monthly service charge",
  "category": "apartment_community",
  "mode": "fixed",
  "amount": 3000,
  "interval_months": 1,
  "due_days": 10,
  "grace_days": 5,
  "late_fee_type": "percentage",
  "late_fee_value": 200,
  "escalation_bps": 0,
  "escalation_months": 12,
  "is_active": true
}
```

Modes: fixed recurring, metered usage, one_time, installment. `interval_months` is 1–12, covering monthly, quarterly and yearly billing. Percentages use basis points: 200 = 2%; 10000 = 100%. Installment plans require `installment_count`: `amount` is the whole contract, distributed across installments with any integer remainder in the last one. Plans must cover at least one whole currency unit per installment. Only fixed recurring plans support escalation. Escalation compounds at `escalation_months` intervals from the subscription's starting month.

Assignment body: `{customer_id,plan_id,unit_id?,label,start_date,end_date?}`. Multiple charges may be assigned to one customer/unit. Billing cycles are anchored to the starting month. A mid-month start bills the complete charge and uses that start date for its first invoice; later cycles use month start. There is no implicit proration. One-time assignments generate only in the start month; installments stop after their configured count. Paused, disconnected, ended, inactive-plan/unit/customer and out-of-cycle assignments do not generate. Duplicate generation returns the existing invoice even if cancelled; use a new one-time corrective invoice when necessary.

Changing an assigned plan's mode, interval, installment count or installment contract total is rejected. Create a new plan and end/reassign the subscription for those changes. Changes to rates and fee settings affect subsequent invoices only; existing invoice values remain intact. Bulk runs snapshot assignment IDs; plan/customer/assignment eligibility is checked when each item is processed.

Meter body: `{assignment_id,period_start,previous,current}`. The first reading provides a baseline. Later readings must be chronological and begin at the previous recorded current value. Readings cannot be changed after billing. Charge = consumption × plan rate. Zero-consumption cycles generate a zero invoice. Meter resets need a new assignment/baseline.

## Invoices, payments and advances

Invoice body: `{customer_id,invoice_date,due_date,lines,discount?,tax?,note?,request_key}`. Lines: `{description,quantity,unit_price}`. Totals are server-calculated. `request_key` is a UUID; reuse it only with the same payload when retrying. The server stores an exact payload fingerprint for invoices, payments, runs and adjustments, returning 409 for changed payloads.

Bulk body: `{period_start,assignment_ids?,request_key}`. Omit IDs to select active assignments, with a hard limit of 5,000. A persistent worker processes 100 items per selected run every 10 seconds; progress survives restarts and multiple workers deduplicate through serializable transactions. Validation errors appear in `results`; infrastructure errors retry the same item. A new run can retry missing-meter items after fixing them. Processing pauses while project access, the creator's active management/accountant role, or the organization subscription is unavailable. Timing depends on database load; no 5,000-invoice performance guarantee is asserted without staging measurements.

Payment body:

```json
{
  "customer_id": "customer-id",
  "account_id": "cash-or-bank-id",
  "amount": 5000,
  "method": "bkash",
  "payment_date": "2026-10-14",
  "allocations": [
    {"invoice_id": "invoice-1", "amount": 3000},
    {"invoice_id": "invoice-2", "amount": 1500}
  ],
  "request_key": "f0572e73-7717-4321-a28c-ebfe1344c282"
}
```

Methods: cash, bank, bkash, nagad, card, cheque. These are manual collection records, with no payment gateway/card credential integration. Payment posts cash once. Explicit allocations settle selected invoices; omitted allocations settle oldest outstanding invoices. `allocations:[]` stores the entire payment as advance. Amounts not allocated remain customer credit. One payment can allocate to at most 5,000 invoices. Cross-customer, cancelled, duplicate and excessive invoice allocations are rejected atomically.

By default a new invoice consumes available customer credit, allocating existing payments without adding another account transaction. This can be disabled through configuration. Explicit Apply Advance is safe to repeat. One-time invoicing creates receivables only, not cash. Invoice paid/outstanding/overdue status is derived, with due dates evaluated using the Dhaka calendar.

## Adjustments and reconciliation

Request body: `{customer_id,kind,invoice_id?,payment_id?,amount?,reason,request_key}`. Kinds: credit_note, debit_note, waiver, write_off, cancel, refund. Refunds require payment_id; all others require invoice_id. Cancellation omits amount because the server calculates it.

Requests are pending until approved by a different admin/owner/approver. Repeated identical decisions are idempotent. Credit/waiver/write-off cannot exceed unpaid invoice balance. Debit notes increase receivables. Cancellation releases all invoice allocations into the original payments' advance balances, preserving the cash already received. Refunds consume that unused credit, debit the original account and create a `billing_refund` account transaction. Insufficient credit/cash prevents approval. Changed invoices require a new cancellation request.

Collections create account transaction reference type `billing_payment`. Outside income (`income`) remains separate and does not settle billing invoices. Carry-forward reports reference unpaid original invoices rather than creating duplicate new charges. For current data, customer ledger closing balance reconciles to outstanding invoices minus unallocated advances, including cancellations/refunds/credit/debit notes/late fees. Historical statement entries honor date filters; current outstanding/advance fields are explicitly separate.

Late fees apply once after due date plus grace days, based on remaining unpaid balance and the invoice's saved fixed/percentage policy. Fee/credit/debit actions never create cash movements. Repeated financial actions are protected by serializable transactions, request-key/cycle uniqueness and database amount constraints; audit, payments, allocations, account updates and receipt outbox creation commit together.

## Dashboard, PDFs and reminders

Total billed and collected respect the requested invoice/payment date range. Net billed additionally reflects current credit/debit/fee adjustments on those invoices; cancelled invoices are excluded. Refunds use approval dates. Outstanding, advance, aging and carry-forward reflect current state, not a historical aging reconstruction. Collection progress measures the requested period's invoices settled using any allocated payment; cash collected is a separate period metric. Overdue accounts count unique customers.

Statements include a chronological running ledger and current outstanding/credit. Receipts show payment method, reference, allocations, unallocated credit and refunds. PDFs paginate long statements. Customer email invoice notifications and payment receipt notices queue transactionally. Reminder requests deduplicate by invoice/date. The existing SMTP transport handles delivery, with five attempts and status/error reporting in Messages. Email delivery is at least once: SMTP acceptance followed by a process crash can cause a duplicate on retry. Customers without email have no email delivery. SMS/WhatsApp/customer portal are not enabled by this module.

## Rollout and validation

Apply migration `20261014100000_billing_management` using the normal deployment process (`prisma migrate deploy`), regenerate Prisma and deploy this backend before shipping the mobile client. The worker requires the new tables. No existing business/member data is converted. No live database migration is performed during implementation.

If a new billing project shows `Route GET /v1/billing/plans not found`, the API instance serving the mobile app does not expose the billing routes. Creating a project does not install API modules. Rebuild and redeploy the backend with `src/routes.ts` mounting `billingRouter` at `/v1/billing`. For Coolify, redeploy the API service from the current backend commit; the repository Dockerfile generates Prisma, builds the server and runs `prisma migrate deploy` before starting it. Restarting an older container will keep the older routes.

Check that the deployment succeeded, rather than only that the application is marked Running. A failed migration makes the new container unhealthy and Coolify rolls back to the previous API. The original construction migration in commit `2465c6b` duplicated its foreign-key block, causing PostgreSQL error 42710 and Prisma P3018. Subsequent attempts report P3009 until its failed migration record is resolved. See [construction migration recovery](CONSTRUCTION_MIGRATION_RECOVERY.md) before retrying that release.

For a deployment outside Docker, run `npm ci`, `npx prisma generate`, `npm run build`, and `npx prisma migrate deploy` in the backend release directory, then restart the API process with `npm start`. Verify with an authenticated `GET /v1/billing/plans` using the billing project's `X-Project-Id` header: a new project returns HTTP 200 with an empty data array. An unauthenticated 401 alone does not confirm route availability because authentication runs before route matching. Do not recreate the project to resolve a missing API route.

Build, Prisma validation, isolated billing route tests and the backend regression suite pass. Tests include permissions, tenant/project isolation, complete-payload idempotency, serialization retry, partial/multiple invoice payments, credit allocation, rollback, monthly/quarterly/installment cycles, meters, bulk restart/error handling, fees, approvals, cancellation/refunds and reconciliation. Real PostgreSQL concurrency, SMTP and 5,000-invoice throughput still require staging verification. The mobile client uses this dedicated API contract instead of Accounting document endpoints.
