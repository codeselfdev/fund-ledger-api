# Master-session web administration

The Expo web app exposes `/support/admin` alongside `/support/impersonate`. Its API is `/v1/support/admin`.

This reuses the existing master configuration (`MASTER_USER_EMAIL`, optional `MASTER_USER_ID`, `MASTER_IMPERSONATION_CODE`, `MASTER_WEB_ORIGIN`) and `requireMasterSession` policy. No internal or provisioning API key is accepted as a substitute. The recent Google/email-verified master session and exact web origin are required on every operation. View-only impersonation sessions cannot use these endpoints.

`POST /unlock` accepts only `{code}`. It shares impersonation's transaction advisory lock and five-failures-in-15-minutes account counter. A successful unlock returns `{grant, expires_at}`. The browser keeps the grant in memory and sends it in `X-Master-Grant` alongside its normal Bearer token. The domain-separated HMAC binds the exact parent session, current policy fingerprint and expiry, at most 15 minutes and within the 30-minute fresh-login window. Revoked/expired sessions, inactive accounts, changed email/identity policy and code/origin rotation invalidate access immediately. Local locking discards the memory grant; a copied grant remains valid only within those server constraints.

`GET /status` checks the master session without returning operational data. All endpoints below also require a valid unlock grant:

| Method | Path after `/v1/support/admin` | Purpose |
| --- | --- | --- |
| GET | `/support/tickets`, `/support/tickets/:id` | Global open/resolved support queue and paginated private messages |
| POST | `/support/tickets/:id/messages` | Existing idempotent team reply with requester notification outbox |
| PATCH | `/support/tickets/:id/status` | Resolve/reopen |
| GET | `/support/attachments/:id` | Private screenshot bytes |
| GET | `/billing-requests`, `/billing-requests/counts` | Pending subscription invoices |
| GET | `/billing/:tenantId/invoices/:invoiceId/receipts/:receiptId` | Private receipt bytes |
| POST | `/billing/:tenantId/invoices/:invoiceId/review` | Existing approval/rejection; requires expected payment request UUID |
| GET | `/notifications/users?search=...` | Bounded search for test accounts with registered devices |
| POST | `/notifications/preview` | Signed message/audience review, no delivery |
| POST | `/notifications` | Idempotent enqueue using the signed preview and request UUID |
| GET | `/notifications` | Paginated broadcast history |
| POST | `/notifications/:id/retry` | Failed devices only |

The router derives `master:<database user id>` as operator identity and overwrites any supplied internal actor header. Unlock and every operational request require a durable internal audit before proceeding. Billing decisions also record a private review-request audit before the existing billing transaction. Existing support and broadcast actions retain their transactional operator audits. Codes, grants and bearer tokens are never included in audit metadata. Infrastructure header/body logging must apply equivalent secret redaction.

Master broadcast instances opt into including inbox-only active accounts, including expired subscriptions, while excluding organizations being deleted. Registered devices still deduplicate by token hash. Normal internal broadcasts retain their existing audience behavior. Test selection always requires one available registered-device account; a missing/revoked target fails without falling back to all accounts. Signed previews bind inbox-only users too. No-device audiences can enqueue inbox copies without Firebase; an audience with push devices requires Firebase configuration. Existing platform workers deliver the shared queue.

This is a deliberately limited router, not a proxy for `/v1/internal`. It offers no cleanup, exports, account deletion, payment entry or arbitrary internal operations. Register it before customer support and project/subscription middleware. Responses are no-store/noindex/no-referrer.

Deploy this API and the matching Expo web export together. No new schema migration is needed beyond the existing support, billing proof, impersonation, broadcast/poster/link migrations. No new production master settings are introduced. Do not expose any server secret through `EXPO_PUBLIC_*`.

```sh
npm run build
SMTP_USER='' SMTP_PASS='' NODE_ENV=test node --test tests/impersonation.routes.test.mjs tests/platform-broadcasts.test.mjs tests/organization-billing.routes.test.mjs
```

Tests mock database/provider operations and use local HTTP servers; they do not send production messages or change live subscriptions. The web workflow and rollout notes are in `FundLedgerMobile/docs/WEB_MASTER_ADMIN.md`.
