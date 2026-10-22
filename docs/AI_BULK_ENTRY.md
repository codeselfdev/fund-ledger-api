# Nesta AI bulk entry

All four project types (`fund_shares`, `accounting`, `billing`, `construction`) support five private-chat/MCP tools: `bulk_customers`, `bulk_dealers`, `bulk_items`, `bulk_expenses`, `bulk_incomes`. Dealers use existing vendor records. There is no new dealer table or database migration.

Each tool accepts `{rows: [...]}` with 1–50 rows of one entity. Users can paste a list, dictate it, or attach existing supported images. Spreadsheet file ingestion remains in Business setup. The extractor preserves source rows, names and amounts and asks for missing data. More than 50 rows and mixed entity types need separate requests. Existing duplicates are rejected, never overwritten. Required custom attributes use current project schemas. Opening stock requires stock management to be enabled.

## Review and execution

The API provides authenticated `/v1/ai-service/bulk/catalog`, `/preview` and `/actions` endpoints under existing Business subscription and AI role gates. Preview is read-only. The proposal binds every normalized row, resolved project reference, balance projection, current schema revision and approval policy into the signed AI review. The mobile card displays every row, total and resulting status; the final confirmation includes the entire batch.

Confirmation revalidates targets. One serializable API transaction creates all records, stock movements, ledger entries and audit rows, or rolls them all back. Successful request keys return the same result, while altered payloads are rejected. Interrupted AI posting attempts remain `outcome_unknown` and never auto-replay.

Income batches credit accounts according to the configured income role rule. Expense batches use existing role behavior: owner/admin posts paid expenses with account debits; accountant creates approved expenses awaiting admin disbursement, without debiting funds. Amounts and item prices use whole BDT; posting dates cannot be future dates. Source images for financial batches are retained as scoped uploads, with the first image shared as the expense document and all source IDs included in batch audit results. Images do not establish settlement.

Bulk confirmations are restricted to private app chat or MCP because group replies cannot reliably display large row reviews. No new outbound notification or message sending is introduced by these tools.

## Rollout and validation

Deploy the API before the AI service, then ship/reload the mobile client. No schema migration or new environment secret is required. The standalone AI service still requires Node 24+.

- API: `npm run build`, then `node --test tests/bulk-assistant.test.mjs tests/business-assistant.test.mjs tests/ai-service.routes.test.mjs`.
- AI service: `npm test` (PostgreSQL integration needs its separately configured test database).
- Mobile: `npm run typecheck`, then `node --test tests/assistant-*.test.cjs tests/voice-input.test.cjs`.

Test with synthetic rows in each project type before production use; no live ledger writes are performed by the automated suites.
