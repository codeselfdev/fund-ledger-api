# Recurring expenses

The shared expense module supports recurring bills for every project type. Apply `20261021120000_recurring_expense_bills`, regenerate Prisma, then deploy the API before releasing the matching mobile screens. The API startup registers the five-minute Asia/Dhaka worker; no additional scheduler is required.

## HTTP contract

All routes use the current authenticated tenant and `X-Project-Id`. Writes require owner/admin/accountant/cashier access. Reads use the existing expense-reader roles plus cashier. Membership, active-project and subscription authentication remains in the existing middleware.

- `GET /v1/expenses/recurring`: schedules excluding soft-deleted rows.
- `POST /v1/expenses/recurring`: `{ request_key: UUID, bill: BillInput }`. Request-key retries return the existing schedule; changed payloads conflict.
- `PUT /v1/expenses/recurring/:id`: `{ revision, bill: BillInput }`. Cannot move back into a handled period.
- `PATCH /v1/expenses/recurring/:id`: `{ revision, paused }`.
- `DELETE /v1/expenses/recurring/:id`: `{ revision }`. Soft-deletes the schedule and preserves expenses/periods.
- `POST /v1/expenses/recurring/:id/record`: `{ due_date, amount, expense_date, doc_file_id? }`. Creates one pending expense and advances the schedule atomically; same-payload retries return that expense.
- `POST /v1/expenses/recurring/:id/skip`: `{ due_date }`. Persists the skipped period and advances without posting an expense.
- Existing `POST /v1/expenses` accepts `repeat: monthly|quarterly|yearly` with a stable `request_key`, category and vendor. Initial expense, schedule and handled initial period commit together. Repeating expenses always enter pending approval, including owner/admin submissions. One-time behavior is unchanged.

`BillInput` contains `preset`, `name`, `vendor`, optional `vendor_id`, `category_def_id`, `account_id`, `kind: fixed|variable`, integer `amount`, `frequency: weekly|monthly|quarterly|yearly`, day 1–31 (`31` clamps to month-end), `next_due: YYYY-MM-DD`, `mode: auto|remind`, `remind_days: 0|1|3|7`, `reference`, nullable `end_date`, and `staff: [{ name, amount }]`. Payroll requires named positive salary rows equal to the total. Variable bills cannot auto-create.

Account, category, optional vendor and receipt references are verified in the current tenant/project. Revision conflicts and differently handled/changed periods return 409. SQL row locks serialize workers, records, skips, edits, pause and deletion. Unique period records and advisory locks on stable creation keys prevent duplicates across API instances and devices. Dates retain their original calendar anchor across short months and leap years.

## Worker and notifications

On startup and every five minutes, automatic fixed schedules create pending expenses for due periods. Each bill catches up at most 24 periods in one worker pass. Remind schedules create a single in-app reminder per due period. Paused, ended and deleted schedules do not run. Creator expense-writing membership, active project and subscription access are checked before automation. Resuming preserves missed periods.

No account is debited during recurrence processing. The existing approve/disburse routes handle balances and ledger entries. In-app notifications commit transactionally with the period or reminder marker; push is best effort through the existing FCM provider. Reminder payloads use `entity_type: recurring_expense` so mobile opens the shared recurring-bills screen after verifying project access.

## Verification

Run `npm run build`, then `node --test tests/expense-input.routes.test.mjs tests/migration-integrity.test.mjs` for the existing expense regressions. `RECURRING_EXPENSE_TEST_DATABASE_URL=... node --test tests/recurring-expenses.integration.test.mjs` runs real concurrent API/worker tests against a disposable PostgreSQL database with the updated schema. The suite creates synthetic fixtures and removes its tenant. Never point it at production.

The additive SQL migration was exercised against an isolated database prepared with the previous schema. Production deployment/migration and real device/FCM smoke tests remain release operations.
