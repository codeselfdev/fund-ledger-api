# Organization packages and Business assistant

Quotas apply to the whole organization, across all projects. Each active uploaded file (member document, proof, logo or photo) counts as one document. The file limit is **5,000,000 bytes**, inclusive; existing image optimization still reduces images below 2 MB.

| Package | BDT monthly / yearly | Projects | Users & members | Documents |
| --- | --- | ---: | ---: | ---: |
| Free Trial | Free for 1 calendar month | 2 | Unlimited | 100 |
| Starter | 1,000 / 10,000 | 6 | 20 | 1,000 |
| Business | 5,000 / 50,000 | 20 | 500 | 15,000 |
| Custom | Contact support | Negotiated | Negotiated | Negotiated |

Starter includes 3 logical feature requests. Business includes 12 custom feature requests, 24-hour support, **1,000 AI Chat replies and 1,000 WhatsApp Bot replies per UTC calendar month**. Reply allowances are separate and shared across projects. Pending requests reserve capacity; failed generation releases it. Uncertain bot delivery retains the slot and is not automatically resent.

## Quotas and upgrades

Database triggers serialize quota-affecting writes on a tenant row, covering concurrent creates, imports, bulk inserts, reactivation and direct API calls. Live counts release capacity after removal. Users with several roles, projects or linked share records occupy one seat; active unlinked members also occupy seats. Projects include inactive projects until actually removed. Existing data is preserved if above a new limit.

`GET /v1/subscription/quota` returns package, max document bytes, and `{used,limit}` for documents, users and projects. A null limit means unlimited. The admin profile displays these values and Business reply allowances, with refresh and upgrade controls. Errors: `DOCUMENT_TOO_LARGE` (413); `DOCUMENT_QUOTA_EXCEEDED`, `USER_QUOTA_EXCEEDED`, `PROJECT_QUOTA_EXCEEDED` (409).

The mobile project form offers the existing independently billed new-organization flow and, for admins/owners, creating within the current organization.

`POST /v1/subscription/upgrade` accepts only `{package: "starter"|"business", billing_cycle: "monthly"|"yearly"}`. The server determines price/currency. Matching pending selections reuse the invoice. The existing trusted payment approval API activates the selected package and adds one or twelve calendar months, preserving prepaid time. Approvals are idempotent, lock the tenant and recheck that usage fits the selected package. Pending/rejected payments grant no paid entitlement. Customers cannot approve themselves or reset trials.

Trusted platform invoice creation accepts optional `package` (`starter`, `business`, `custom`) and `billing_cycle`. Custom capacities currently default to unlimited and enrollment is operator-managed. Existing paid subscriptions without package metadata resolve to Starter and are excluded from free-trial cleanup. Package metadata is authoritative in `contact.subscription.package`; the existing tenant enum remains backward compatible.

## Removal and retention

`DELETE /v1/members/:id/documents/:documentId` validates tenant/project and write access (owner, admin, accountant, cashier or linked member). Read-only staff cannot remove documents. Soft deletion immediately hides the document and frees its slot. Content remains recoverable for three calendar months; a trusted operator can clear deletion dates to restore it, subject to the quota guard.

Free-trial files are retained **three calendar months after trial expiry**, then an hourly worker purges blobs and metadata if no paid upgrade occurred. Cleanup rechecks the tenant under the payment approval lock. Explicitly removed files are purged after their own recovery period. Storage failures keep metadata for retry, and cleanup is audited. This implements file retention; separate infrastructure backups are not provisioned.

## AI Chat

- `GET /v1/assistant/status`: entitlement, readiness, monthly used/limit, reset time.
- `GET /v1/assistant/messages`: caller's current-project history.
- `POST /v1/assistant/messages`: `{message, request_key: UUID}`, up to 2,000 characters.

Only active paid Business can generate replies. Retries of a request key reuse its answer; changed prompts with the same key are rejected. Rate limiting also applies. The assistant is read-only, with no mutation tools. Context is constructed on the server from current membership: finance roles receive project aggregate dues, balances and expense totals; other users receive only their linked member dues. No uploaded files, identity documents or account numbers are supplied as context.

Answers and history are bound to an authorization fingerprint. A role/member-link change prevents reuse or delivery of old answers. Questions and replies are retained for up to 90 days. Provider calls use the OpenAI Responses API with `store: false`; provider-specific retention terms still apply.

## WhatsApp Bot

Reuse the existing encrypted per-project WhatsApp Business connection. An active member sends a private text message from their registered mobile. The server resolves an exact active account/project membership. Unknown senders, ambiguous number routing, non-text and stale messages are ignored. No organization named in message text controls access.

Configure Meta's callback as `https://YOUR_API/v1/webhooks/whatsapp` and subscribe to message events. GET verifies the configured token. POST validates HMAC-SHA256 against the exact raw body using the Meta app secret. Signed inbound jobs are persisted before HTTP 200; a worker generates and delivers replies afterward. Meta message IDs prevent duplicate replies/charges. The worker revalidates Business access and the authorization fingerprint before delivery.

Uncertain outbound delivery is recorded as `delivery_unknown` (or `sending` if a worker stops at that boundary). Inspect Meta delivery state before any manual resend. Bot replies are only sent in response to inbound messages less than 23 hours old.

## Configuration and rollout

Deploy the backend before the app. Apply both additive migrations, regenerate the standard Prisma client and build:

```sh
npx prisma migrate deploy
npm run prisma:generate
npm run build
```

Backend settings (never include secrets in the mobile app):

```dotenv
AI_CHAT_ENABLED=true
OPENAI_API_KEY=<secret>
OPENAI_CHAT_MODEL=<supported Responses API text model>
BUSINESS_AI_REPLIES_PER_MONTH=1000
BUSINESS_WHATSAPP_REPLIES_PER_MONTH=1000
WHATSAPP_ENABLED=true
WHATSAPP_APP_SECRET=<Meta app secret>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<random verification token>
WHATSAPP_CREDENTIALS_KEY=<stable encryption secret>
```

The deployment owner supplies AI credentials, a supported model, Meta app registration/business approval, webhook subscription and the WhatsApp Business connection. No production deployment, migration, payment or real provider/message call is performed by the coding task.

Validation includes mobile TypeScript/tests, backend build, affected route regressions, disposable PostgreSQL quota/concurrency/retention/assistant/webhook tests, Expo web export, and phone-sized pricing/profile visual checks. AI and Meta calls in tests are mocked. To run integration tests, apply migrations to a disposable PostgreSQL database and set `QUOTA_TEST_DATABASE_URL` before `node --test tests/package-quotas.integration.test.mjs tests/assistant.integration.test.mjs`.

References: [OpenAI text generation](https://developers.openai.com/api/docs/guides/text), [Meta webhook signature sample](https://github.com/fbsamples/whatsapp-api-examples/tree/main/signature-validation-with-webhooks-payloads).
