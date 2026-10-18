# Separate posting assistant

The separate service is in `../fundnesta-ai`; its README documents tools, identity mapping, confirmation, current financial workflows, provider validation and deployment.

Set `AI_SERVICE_URL` and `AI_SERVICE_SHARED_SECRET` on this API. Set the same shared secret on the AI service; the AI service also needs its own encryption key, OpenAI credentials/model and the existing Meta webhook secrets. Do not expose these to Expo. Deploy one Node 24 service instance with persistent SQLite storage. Managed group bots require the additive WhatsApp provisioning and Telegram identity migrations described in [Managed group bots](MANAGED_GROUP_BOTS.md).

`/v1/ai-service/context` uses the existing live session middleware and active project memberships. Only owner/admin/accountant may access it. The shared-key `/v1/ai-service/whatsapp/resolve` checks the exact active WABA, phone-number ID and fixed group mapping, registered participant identity and active paid Business entitlement. It returns provider credentials only to the trusted service, which must still use the paired user's valid session for tools.

Posting uses the normal member/deposit/income/expense REST routes with the user's original session. Existing authorization, settlement, quotas, deposit allocation versions and approval flows remain authoritative. MCP tools prepare drafts; final posting requires a separate explicit user confirmation. The service does not approve every deposit automatically or implement a new two-person income workflow.

`/v1/assistant/status` advertises `action_service_enabled`. The mobile app uses the new adapter when configured and displays Review/Confirm/Cancel and WhatsApp session pairing. The old assistant routes now also deny non-accounting roles.

Validation:

```sh
npm run build
node --test tests/ai-service.routes.test.mjs tests/deposit-member-settlement.routes.test.mjs tests/expense-input.routes.test.mjs
```

The PostgreSQL assistant integration suite additionally requires a disposable `QUOTA_TEST_DATABASE_URL`. Tests use mocked external providers; real Meta group eligibility, sender/mention/image/reply payloads and delivery still need a test-group check before callback rollout. Meta callback for managed groups is `https://YOUR_API/v1/webhooks/whatsapp`. The API reconciles creation callbacks and forwards signed group messages to the AI inbox. Telegram callback remains `https://YOUR_API/v1/integrations/telegram/webhook`, and group mentions are forwarded to the same AI tools. See [Managed group bots](MANAGED_GROUP_BOTS.md) for customer and platform setup.

Source implementation does not deploy anything or post real money.
