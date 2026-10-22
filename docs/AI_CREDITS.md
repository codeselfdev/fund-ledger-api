# AI credit limits and cost controls

Free Trial: **10 AI Chat credits per UTC calendar month**. Starter: **100**. Business retains the configured `BUSINESS_AI_REPLIES_PER_MONTH` (default 1,000). Usage is shared across organization users/projects, the legacy read-only endpoint, action chat and Telegram. WhatsApp remains Business only with its existing separate allowance. Expired subscriptions and unprivileged roles remain blocked; Custom is operator-managed.

One admitted request consumes one credit, even if the provider fails. Failed records therefore count toward usage. The tenant-row lock and count/insert transaction prevent concurrent over-allocation. Request keys are bound to the user, project and input hash; completed/failed retries do not start new provider attempts. `GET /v1/assistant/status` includes `upgrade_plan`, and quota errors suggest Starter, Business or Custom as appropriate. Upgrading still requires approved billing/payment.

Both chat endpoints enforce at most three static JPG/PNG/WebP attachments, each strictly below 1,000,000 bytes and at most 1,600 pixels per side. Signature/dimension checks and bounded multipart parsing happen before forwarding. The updated mobile client performs resizing and JPEG re-encoding with its own optimizer. Unoptimized direct/older clients are rejected.

Chat and usage routes allow 12 requests per minute per organization. The AI service additionally serializes active organization chats and stores request claims/failures so retries do not repeat extraction. These in-memory throughput guards assume the service's existing single-worker deployment; monthly credit enforcement is transactional in PostgreSQL across API instances.

Deploy this API with the matching `fundnesta-ai` service before distributing the updated mobile client. No new database migration or provider credential is needed for this feature. This changes failed-attempt accounting and the attachment contract for older clients. Existing prior failed records in the current allowance period now count.

Validation: build the API, run `node --test tests/assistant-credits.test.mjs tests/ai-service.routes.test.mjs tests/assistant.integration.test.mjs`. The DB integration suite requires a disposable `QUOTA_TEST_DATABASE_URL` with existing migrations applied; without it those tests skip. Mocked regression tests make no live provider or messaging calls.
