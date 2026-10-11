# Accounting workflow and outside income

Accounting projects have a separate customer document workflow. Existing Fund / Shares dues, member deposits and POS sales remain separate. Income is available across Fund / Shares, Accounting and Billing projects, with optional dynamic categories and customer tags.

## Project workflow

Default: quotations and orders enabled, skipped steps allowed. Admin/owner can disable either step or require the full enabled flow in **Accounting → Overview → Configure workflow**.

- Quotation: draft → sent → accepted / rejected / expired. Accepted quotations convert to an order or (when skipping is allowed / orders are disabled) a sale.
- Order: draft → confirmed → in progress → completed when converted to a sale.
- Sale invoice: draft → issued. Issuing creates a receivable, not cash income. Payments derive unpaid / partial / paid / overdue status.
- Flexible projects allow direct orders or sales. Strict projects require the preceding enabled step.
- Each document saves its workflow, customer snapshot, item prices and status history. Later settings changes do not rewrite earlier documents. A source converts once, and links to its resulting document.
- Drafts can be edited; sent quotations, confirmed orders and issued invoices preserve their values. An unpaid invoice may be cancelled, restoring its linked inventory. Paid invoices cannot be cancelled in this version; refunds/credit notes are future work.
- Free-form service/product lines support quantity to three decimals and whole-currency unit prices. Inventory lines require whole quantities. Stock is deducted on invoice issue, never quotation/order creation. Split fulfillment/invoicing and stock reservations are not included in this version.

## API

All operations use the existing bearer token, `X-Project-Id`, `{ok,data}` envelope, active membership and subscription gates. `/v1/accounting` is limited to Accounting projects.

| Endpoint | Use |
| --- | --- |
| GET/POST /v1/accounting/customers | List / add customers |
| PATCH /v1/accounting/customers/:id | Edit name, optional mobile/email/address, active flag |
| GET /v1/accounting/overview | Workflow, receivables, collected, overdue and latest documents |
| PUT /v1/accounting/workflow | `{quotations,orders,allow_skip}`; admin/owner only |
| GET /v1/accounting/documents | Optional `kind=quotation/order/sale`, `receivable=true` |
| POST /v1/accounting/documents | Create draft: kind, customer_id, document_date, optional due_date, lines, discount/tax amounts, optional note, UUID request_key |
| GET/PATCH /v1/accounting/documents/:id | Detail / edit draft values (PATCH omits kind/request_key) |
| POST /v1/accounting/documents/:id/status | `{action:send/accept/reject/expire/confirm/fulfill/issue/cancel}` |
| POST /v1/accounting/documents/:id/convert | `{kind,document_date,due_date?,request_key}` |
| POST /v1/accounting/documents/:id/payments | `{account_id,amount,payment_date,reference?,request_key}` |
| GET/POST/PATCH /v1/customers[/\:id] | Customers usable as income tags in any project; staff only, members cannot browse customer contacts |
| GET/POST/PATCH /v1/incomes/categories[/\:id] | Dynamic category names; rename/archive/restore, preserves historical tagging |
| GET /v1/incomes/report | total_amount, entry_count, by_category and by_customer totals |
| GET /v1/incomes | All project types; entries, next_offset, can_record. Optional offset pagination |
| POST /v1/incomes | Existing account_id/amount/note, optional source, income_date, UUID request_key, category_id, customer_id |

Income list/report accept `category_id`, `customer_id`, `from`, `to` filters. Use `none` for untagged entries. Dates filter the income date, falling back to the recorded date for legacy entries. No category or customer is required. Category/customer names and optional IDs are returned with income entries. Categories can be archived/restored without removing past reports; customer contacts remain restricted to staff. Reports exclude member deposits and invoice payments.

Line shape: `{description,quantity,unit_price,item_id?}`. Dates: `YYYY-MM-DD`; payment/income dates cannot be in the future. The server calculates totals. Mobile always supplies request keys; legacy income clients may omit them for compatibility.

Admin/owner, accountant and cashier write customer documents / receivable payments. Approver and auditor can read documents. Members do not access customer identities or write financial data. Outside income is readable by all active project roles; recording follows the existing income verification setting (admin/owner always allowed). Member portal actions remain read-only.

Payments credit exactly one account belonging to the current tenant/project. Partial payments cannot exceed the remaining balance. Request keys, serializable transactions/retries and unique source links protect against duplicate credits/conversions. Account balance, invoice paid amount, payment, account transaction and audit are committed together. Ledger payment reference type is `receivable_payment`. Outside income remains `income` and does not pay member dues or customer invoices. Legacy income/opening balance transactions remain visible.

## Rollout

Apply the additive `20261011150000_accounting_workflow` migration using the backend's normal deployment process (`prisma migrate deploy`), regenerate Prisma and deploy the matching API before distributing the updated app. Apply any earlier pending migrations, including organization identity, first. No live database migration is run by this implementation task.

Tests exercise real routers/auth/role gates against isolated mocked persistence, including transaction rollback and simultaneous request cases. Production PostgreSQL transaction behavior still requires staging verification after migration. Do not use real customer payments for staging checks.
