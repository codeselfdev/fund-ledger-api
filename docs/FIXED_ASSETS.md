# Fixed assets API

An authenticated project module available to owner/admin/accountant, with read-only register and export access for auditors. It is available for every project type. Existing authentication, active subscription and project membership checks apply. Members, cashiers and approvers are denied. Invoice viewing also requires finance access, including through the generic uploads endpoint.

## Install

```sh
npm run prisma:generate
npx prisma migrate deploy
npm run build
```

Apply migration `20261015090000_fixed_assets` before starting the new API. It only creates new tables/indexes/constraints. No opening balance imports, balance rewrites or live migration execution are included in this change. Projects with asset records cannot be hard deleted, preserving financial history.

## Endpoints

All paths begin with `/v1/fixed-assets`; send bearer auth and `X-Project-Id`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/overview` | Register, category totals, net book value, alerts and last 12 monthly posted/forecast depreciation values |
| GET | `/categories` | Suggested lives, residual percentages, code prefixes and colors |
| POST | `/assets` | Single/bulk purchase; atomic account debit, journals, history and completed-month depreciation |
| GET | `/assets/:id` | Current asset value, metadata and lifecycle history |
| PATCH | `/assets/:id` | Serial, warranty expiry and next service date |
| GET | `/assets/:id/invoice` | Authorized invoice file as `{ filename, mime_type, base64 }`, including after a project transfer |
| POST | `/assets/:id/maintenance` | Service record, optional cash payment and next service date |
| POST | `/assets/:id/transfer` | Location, custodian or same-tenant project transfer |
| POST | `/assets/:id/dispose` | Sale or write-off, automatic gain/loss and optional cash credit |
| POST | `/depreciation/post` | Retry posting all completed months; body `{}` |
| GET | `/journals` | Accountant journal lines, latest 1,000 records; admin permitted for administration |
| GET | `/reports/export?format=xlsx` | Excel workbook (register and monthly depreciation sheets) |
| GET | `/reports/export?format=pdf` | PDF register and monthly depreciation |

Exports return `{ filename, mime_type, base64 }` in the existing JSON envelope. Monetary amounts are integer base-currency units, matching accounts/account transactions. Preview monthly rates can be fractional; actual monthly journal amounts use differences of rounded cumulative depreciation so the total equals cost less residual.

Purchase example:

```json
{
  "name": "Dell Latitude laptop",
  "category": "computers",
  "cost": 115000,
  "residual": 9200,
  "life_months": 60,
  "purchase_date": "2026-10-15",
  "in_use_date": "2026-10-15",
  "supplier": "Computer supplier",
  "invoice": "INV-052",
  "account_id": "project-cash-account",
  "quantity": 1,
  "units": [{ "location": "Office", "assigned_to": "Rina", "serial": "SN-001" }],
  "request_key": "23b72b93-f030-4439-9e53-66116f1d1a76"
}
```

Optional `invoice_upload_id` must reference a file uploaded within the current project, with purpose `fixed_asset_invoice`. Optional `warranty_until` is a calendar date. Bulk purchases use the same body with `quantity` from 1–100 and exactly one unit entry per asset. Serial numbers are unique within a tenant when nonempty.

Maintenance body: `{ service_date, description, provider?, cost, account_id?, next_service_date?, request_key }`. A positive cost requires an account. Next service must follow the service date.

Transfer body: `{ kind: "location"|"person"|"project", target, condition: "Good"|"Fair"|"Needs repair", note?, request_key }`. `target` is a project ID for project transfers, otherwise the new location or custodian name (`Nobody` unassigns). Destination membership must be an active owner/admin/accountant role. Finance records remain scoped to their historical project while the current register and invoice access follow the asset.

Disposal body: `{ kind: "sell"|"scrap"|"lost", date, proceeds?, buyer?, reason?, account_id?, request_key }`. Sales require positive proceeds, buyer and receiving account. Write-offs require a reason, zero proceeds and no receiving account. The server computes book value and gain/loss; supplied client valuations are rejected by strict schemas.

Metadata body: `{ serial, warranty_until: "YYYY-MM-DD"|null, next_service_date: "YYYY-MM-DD"|null }`.

## Accounting

- Purchase: debit fixed assets; credit project cash. Bulk units have separate asset journals and one invoice cash movement.
- Completed-month depreciation: debit depreciation expense; credit accumulated depreciation. Begins in the in-use month. The disposal month and later months are excluded; residual is the floor.
- Maintenance: debit maintenance expense; credit cash. Capital value is unchanged.
- Transfer: move gross cost and accumulated depreciation through inter-project clearing. The sender retains transfer-month depreciation expense; receiving accumulated depreciation is adjusted through clearing in that month. The recipient bears expense from the next month, preserving the original useful life and residual.
- Sale/write-off: clear cost and accumulated depreciation, credit cash for any proceeds, recognize the resulting gain or loss. Final in the mobile UI; reversals would require a separate accounting workflow.

The startup/daily worker (00:15 Asia/Dhaka) catches up missed completed months one asset per serializable transaction. Unique asset/kind/period/project journals prevent duplicate postings. Purchases, paid service, transfers and disposals persist operation receipts keyed by project and UUID. Changed payloads with the same key conflict; retries roll back cash, asset updates, journals and audits together on error. Financial transactions retry serialization and uniqueness conflicts up to three times.

Disposal is restricted to the current month and must be on/after purchase. Use a separate reviewed adjustment process for historical corrections. Useful life/cost/residual are immutable after registration; this release does not include asset revaluation, tax-specific depreciation or reversal screens.

## Tests

`npm run build && node --test tests/fixed-assets.routes.test.mjs` covers role/tenant isolation, serial uniqueness, atomic rollback, insufficient funds, retry collisions, bulk purchase, cumulative rounding, service expenses, project transfers including transfer-month expense attribution, disposal cutoff, competing sales and actual Excel/PDF signatures. The test adapter is isolated and does not use a live database. Apply the migration and run a staging smoke test before production rollout.
