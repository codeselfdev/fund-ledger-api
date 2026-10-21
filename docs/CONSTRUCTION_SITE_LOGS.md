# Construction site logs, wastage and demo preload

Mobile rollout uses `20261021090000_construction_site_logs`. Run Prisma generate and the API build after applying migrations, then release the matching FundLedgerMobile build.

The construction router retains its tenant/project/type and staff gates. Accountants/admins write daily drafts, submit logs and record material loss. Approvers/admins review independently; the submitting user cannot approve their own log or wages. Auditors/cashiers can read. Only administrators set allowances.

- `GET /v1/construction/site-logs?from=YYYY-MM-DD&to=YYYY-MM-DD`: up to a 90-day range. Optional `include_pending=true` adds all pending logs for the inbox. Returned logs include summaries of linked project expenses for review.
- `PUT /v1/construction/site-logs`: `{work_date,version,content:{labor:[{cost_head_id,role,workers,rate}],materials:[{item_id,boq_id?,quantity}],expense_ids,photo_ids,note}}`. First save uses version 0; subsequent saves use the returned version. Drafts do not post costs or stock. Expenses must belong to the same project/date. Photos must be project image uploads.
- `POST /v1/construction/site-logs/:id/submit`: `{version}`. Serializable and retry safe. Creates pending wage entries and consumes site materials in one transaction. Stock shortage/audit failure rolls back everything. Submitted logs are locked. A retry returns the saved result.
- `POST /v1/construction/site-logs/:id/decision`: `{decision:"approve"|"reject"}`. Reviews all linked wages atomically. Pending linked wages cannot be approved separately. Rejected logs retain physical stock consumption; use existing source-linked stock returns for real returns. Expenses have independent approvals.
- `GET /v1/construction/wastage`: material totals, recorded values, per-item allowances, loss beyond allowance, pending contractor recovery and recent entries. Percent is wasted / net consumed. Unconfigured limits remain null.
- `PUT /v1/construction/wastage/allowance`: `{item_id,allowance_bps}`.
- Existing material POST accepts optional `charge_contract_id` for waste. Unit valuation is captured on entry. Stock is updated without duplicate purchase expense.
- Existing running-bill POST accepts optional `waste_entry_ids`. It reserves the specified unassigned waste records of that contract and deducts their recorded value. Rejection releases them. Approval recognizes the recovery as lower actual cost. The original retention/certification/advance rules and independent approval remain in effect. Database checks include the deduction in the payable equation. Omitting the new optional field preserves old request hashes on HTTP retries.

## Demo account

The authorized review demo account now has a new construction project, **Sunrise Heights · Demo**, ID `cmvhto53o00624ap04qo8vt7p`. Its live site settings were initialized through the ordinary authenticated API. This task did not deploy the API or apply live schema changes, and the full financial fixture has only been run in disposable PostgreSQL.

After deployment, preview with:

```sh
node scripts/seed-construction-demo.mjs --mobile +16505550174 --project-id cmvhto53o00624ap04qo8vt7p
```

Add `--apply` to insert the sample history. Optional `--date YYYY-MM-DD` sets the daily draft date; default is the supplied reference date, October 21, 2026. It verifies the exact demo project name/type, demo/review organization and administrator membership of the supplied phone. It refuses pre-existing financial activity/balances and never clears or overwrites data. An audit marker makes subsequent runs no-ops. It sends no notifications and needs no OTP or logged-in session stored in the source.

The sample totals reconcile to budget 58,000,000; actual cost 34,200,000; commitments 12,600,000; forecast remaining cost 21,900,000; cash 2,650,000; liabilities 1,840,000. Historical expenses and running-bill payments have account transaction history. Five materials have opening stock, physical usage, waste and allowances. Rod uses kg for whole stock quantities. Historical imports and fictional review requests are labelled; they do not represent real approvals or payments. The daily draft includes 34 workers, 27,900 labor and 6,200 separately drafted expenses, correcting the prototype's inconsistent text totals.

## Validation

`npm run build`; `node --test tests/construction.routes.test.mjs` (25 tests). Full 48-migration chain succeeds on disposable PostgreSQL. Run `CONSTRUCTION_TEST_DATABASE_URL=... node --test tests/construction-site.integration.test.mjs` only on a disposable database: it creates isolated test organizations and tests seed preview/reconciliation/idempotency, simultaneous submission, competing optimistic edits, and concurrent recovery reservations. It makes no external calls or notifications.
