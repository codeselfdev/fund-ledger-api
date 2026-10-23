# Focused Nesta AI summaries and document search

Expense summaries previously called the same full performance report used for sales/profit analysis, then the generic widget displayed its fields recursively. The expense query now returns only expense aggregates. Saved legacy expense responses also render with a strict display allowlist, so sales products, customer revenue and profit/COGS notes disappear after the mobile update.

## Summary cards

- Expense: approved/paid expense total, expense count, category totals, paid and awaiting-payment amounts. Draft, pending and rejected expenses are excluded. No individual transaction rows are returned.
- Income: recorded manual/outside-income total, entry count, category/source and receiving-account totals. Uncategorized entries use their income source when available. Deposits, transfers and sales collections do not count as manual income.
- Quotation: active quoted value and counts/value by status. Expired, rejected and cancelled values are excluded from the headline.
- Sales order: open value and counts/value by status. Completed/cancelled values are excluded from the open headline.
- Sales invoice: issued value, collected and outstanding totals, plus counts/value by status. Draft/cancelled invoice amounts do not count as issued revenue.

Without a specified reporting period, summaries use the current month through today in Asia/Dhaka. Custom categories retain their names; larger financial breakdowns combine lower-value groups under Other. Quotation/order/invoice summary cards show no product or customer detail.

## Search and email drafts

Search quotations, sales orders and sales invoices by any combination of partial customer name, small spelling differences, document number, date/date range, exact amount or minimum/maximum amount. Search does not require an exact customer identity. All provided filters are combined; omitted dates search all dates. Results show number, customer, date, status and total, with five matches per page and the total match count. Each View button opens that document's normal project page, with fresh server authorization. Orders open orders; invoices open invoices.

A quotation email request produces a selectable subject/body, optional known customer email and a View quotation button. Multiple matching quotations produce choices; no document is selected silently. This capability does not send email, attach a PDF automatically or change quotation status.

Examples:

- “Show this month's expense summary.”
- “Give me an income summary for October.”
- “Quotation summary this month.”
- “Sales order summary” / “Sales invoice summary.”
- “Find quotations for Petra Green between October 1 and 23, amount 5,000.”
- “Find invoices for Petra with amounts between 4,000 and 6,000.”
- “Draft an email for quotation QT-0001.”

## Deployment and validation

Deploy the matching `fund-ledger` API and `fundnesta-ai` service, then release the mobile update for the focused cards and View controls. No database migration is required. Financial aggregate reads are available to existing eligible staff across supported project types. Sales document searches, document summaries and email drafting remain Accounting-only. All reads retain current user/project/role checks.

Validation covers API aggregate filters, authorization and amount reconciliation; AI query selection schemas, search/date/amount filtering, pagination and draft-only email behavior; mobile report allowlists and document View references. Tests use synthetic records and mock external services. Verify natural-language requests against the deployed AI provider before rollout; no live customer email or financial transaction is sent by these tests.
