# Business setup: custom fields, import and tax

Open **More → Business setup** in Accounting, Billing or Construction. Inventory also has a Business setup action. Owners and admins manage the settings; staff use the shared business directory with their existing write permissions. Dealers use the existing vendor/supplier records, so expenses, purchases and Construction continue to reference the same identities.

## Mobile experience

- **Custom fields:** Customers / Dealers / Items tabs, protected built-in fields, ten value types, required fields, search matching, filters and list visibility. Fields can be edited, archived and restored. Existing keys/types cannot change; choice options can be extended. This protects previously saved values. New properties with non-Latin labels receive a valid generated key that the admin can customize before saving.
- **Search & filters:** Name is always searched. Admins choose other built-in and custom search fields, contains/exact/prefix matching, typed filters, and the order of custom fields. Lists use server-side search and pages of 50 records. Staff can view additional details without write permission.
- **Excel / CSV import:** Choose a file, match columns, review rows, then import. Recognized headers match built-in or existing custom fields. Extra columns propose new fields; the admin can rename, skip, remap, change types and enable search before saving. Choices derive from distinct cell values. Validation blocks import until errors are fixed; invalid cells are never silently discarded.
- **Tax & VAT:** Named percentage rates, additive or withholding, per-document defaults, prices including/excluding tax, one rate per document or per line, business registration number, PDF breakdown and staff override controls. The setup starts without any assumed statutory rates.

The screens follow the supplied mobile reference: navy summary panels, teal actions, white rounded cards, segmented entity tabs and fixed primary actions. Existing app typography, keyboard handling and safe-area behavior are retained. Verified at 320 px and 390 px widths using synthetic data.

## Data design

The matching backend is `../fund-ledger`.

| Storage | Responsibility |
| --- | --- |
| `business_fields` | Scoped field definitions, immutable keys/types, ordering, validation/search/display flags and archival |
| `customers.attributes`, `vendors.attributes`, `inventory_items.attributes` | Typed JSONB values keyed by the stable field key; GIN indexes and object constraints |
| `business_configurations` | Project field/search revision, built-in search choices, separately versioned tax configuration |
| `business_imports` | Expiring immutable previews and durable commit results |
| `tax_snapshot` on business documents, billing invoices, purchases and sales | Historical rates, selections, registration number, taxable bases, grouped amounts and payable totals |
| `business_tax_entries` | Input/output tax and withholding entries; unique source/rate/reversal keys prevent duplicate posting |

This avoids a schema migration per business property and avoids EAV joins when rendering profiles. Definitions are separate from record values so validation, search and import use the same contract. Business data stays scoped by both tenant and project. Query identifiers and operators use allowlists; user values are bound parameters. Equality and choice filters use JSONB containment; numeric/date ranges use typed comparisons. Broad keyword searches use the project's configured fields, with bounded pagination. Larger deployments can add measured expression indexes for heavily searched keys without exposing arbitrary SQL or allowing business users to issue DDL.

Schema writes, record validation and imports serialize on the project row. Optimistic revisions reject stale settings and previews. Existing customer/vendor/item API write paths also validate additional attributes. Archiving hides a definition while preserving saved values; form serializers omit archived values instead of clearing them.

## API contract

All endpoints use bearer authentication and `X-Project-Id`. The shared setup root is `/v1/business-setup`.

| Method and path | Purpose |
| --- | --- |
| `GET /entities/:entity/schema` | Built-in search settings, field definitions and revision |
| `POST /entities/:entity/fields` | Admin creates `{ revision, field }` |
| `PATCH /entities/:entity/fields/:id` | Admin edits/archives/restores `{ revision, field }` |
| `PUT /entities/:entity/search` | Admin saves built-in keys and per-field search/filter/display settings |
| `POST /entities/:entity/query` | Typed `{ search, filters, offset, limit }`; returns entries and next offset |
| `POST /entities/:entity/records` | Create basic fields and `attributes` |
| `PATCH /entities/:entity/records/:id` | Update supplied basic fields and merge supplied `attributes` |
| `POST /imports/preview` | Admin validates rows, mappings, types, duplicate policy and schema revision |
| `POST /imports/:id/commit` | Admin atomically commits the reviewed preview; retries return its stored result |
| `GET /tax`, `PUT /tax` | Read or admin-save tax configuration with its own revision |

`:entity` is `customer`, `dealer` or `item`. Filters use configured field keys with `eq`, `contains`, `gte`, `lte` or `in`, restricted by value type. `in` matches any selected choice. Item queries can also specify `categoryId` and `lowStock`.

Document creation accepts `tax_selection: { revision, rateId, withholdingId, inclusive, lineRateIds }`. The server resolves defaults, enforces staff restrictions and computes every amount. Omitting selections still applies configured defaults. Current setup changes require review when a client submits an outdated revision. Existing drafts retain their snapshot; explicitly applying current setup uses the latest revision. Legacy drafts with fixed tax retain that amount until the user chooses to replace it.

Accounting PDFs use `GET /v1/accounting/documents/:id/document.pdf`; Billing invoices use `GET /v1/billing/invoices/:id/invoice.pdf`. Both render the saved tax snapshot. Existing issued documents and quotation conversions keep historical tax even after rates change or are deactivated.

## Import and financial rules

- Files: CSV, XLSX and XLS, first visible worksheet, headers in row 1; up to 5 MB, 2,000 data rows and 100 columns. The API accepts at most 8 MB of serialized preview data. Source row numbers survive blank rows. Formulas are never evaluated; missing cached results and Excel errors block import. Excel date cells become ISO dates. Text phone numbers, IDs and SKUs retain leading zeroes during parsing.
- Match existing customers by mobile, dealers by phone, items by SKU. Phone matching follows existing contact-entry normalization, including Bangladesh local/international prefixes. Ambiguous saved identities and duplicate file identities require correction. Rows without an identity are new records; dealer names must also be unique. The default duplicate policy skips existing records; admins can choose updates.
- Previews save no master records or definitions. Commit checks schema and identity changes again, creates fields and records in one serializable transaction, records an audit event and stores an idempotent result. Successful commits erase the raw file payload. Uncommitted previews expire after 30 minutes; a 15-minute retention task erases expired payloads, with an additional cleanup during preview creation.
- Updates never replace existing stock. Opening stock creates a movement; later quantities use stock adjustments, purchases or sales. Existing attributes outside mapped columns remain unchanged. An explicit blank mapped cell clears an optional field; required blanks block import.
- Financial postings use the application's existing **whole taka integer** unit. Tax percentages use basis points (15% = 1500); discount allocation preserves the exact input amount; tax rounds per line. Custom money properties support two decimals, but item prices and posted financial amounts remain whole taka. No fractional ledger-unit migration is introduced.
- Tax uses each discounted line base, without compounding rates. Withholding reduces the amount collectible/payable and is recorded separately. Quotations and drafts do not post. Sales post on issue, purchases on receipt, and cancellations reverse original entries. Construction's purchase-linked supplier receipt uses the same input tax posting. Recurring Billing invoices apply server defaults too.

## Rollout and verification

1. Apply backend migration `20261020000000_business_setup` with the normal reviewed deployment process.
2. Regenerate Prisma and build/deploy the matching backend before releasing this mobile version.
3. Configure real business fields and applicable rates as an owner/admin, then release the mobile app.

No production schema, business settings, tax rates, imports, invoices or accounts were changed during development. Migration validation and API integration tests used a new disposable PostgreSQL database with synthetic data.

Validation commands:

```sh
# Mobile
npm run typecheck
node --test tests/business-setup.test.cjs tests/accounting-ui.test.cjs tests/billing-management.test.cjs tests/billing.test.cjs tests/construction.test.cjs tests/construction-api.test.cjs
EXPO_OFFLINE=1 npx expo export --platform android --output-dir /tmp/business-mobile-android

# Backend
npm run prisma:generate
npm run build
# This test deliberately accepts only the isolated local test database URL.
BUSINESS_SETUP_TEST_DATABASE_URL=postgresql://postgres:synthetic-business-test@127.0.0.1:55439/business_setup_test node --test tests/business-setup.integration.test.mjs
```

The shared wire/domain contract is mirrored in `src/domain/businessSetup.ts` (mobile) and `src/modules/business-setup/contract.ts` (backend). Change them together. Tests cover typed validation, workbook parsing, search/filter SQL, permission and project isolation, archival, stale revisions, concurrent import retries, opening stock, historical/mixed tax rates, recurring invoices, PDFs, posting/reversal, legacy draft preservation and preview retention.
