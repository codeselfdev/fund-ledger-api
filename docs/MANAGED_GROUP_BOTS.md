# Fund Nesta managed group bots

Customers use Fund Nesta's shared bot accounts. The app never asks for a WhatsApp business account ID, phone-number ID, API version, access token, or webhook configuration.

## Customer flow

**WhatsApp:** Integrations → WhatsApp Bot → enter a group name → Create WhatsApp group. Creation is asynchronous. The app waits for WhatsApp's signed creation callback before showing Join group and Share invitation (Copy invitation link on web). Joining pairs the signed-in user's registered mobile with the existing AI service. Other admins/accountants enable their own session from AI Chat → Connect my WhatsApp session. Sessions expire and must be reconnected.

The initial version creates a new API-managed WhatsApp group; it does not accept an existing group's link or ID. The shared Fund Nesta business number must qualify for Groups API access. The current provider limit is eight participants per group.

**Telegram:** Integrations → Telegram Bot → create a group in Telegram, add Fund Nesta's bot, and make it an admin so it receives mentions → verify with the provided connection command (or the automatic `startgroup` command) → confirm the displayed group and your Telegram identity. Telegram's Bot API cannot create the group itself. The account and token are managed once by Fund Nesta.

In the connected Telegram group's detail, tap Enable my bot replies. The group setup already verifies the connecting admin's Telegram identity. Other admins/accountants can connect through AI Chat → Connect my Telegram session: send their short-lived command from their Telegram account in the project's group, then confirm the displayed identity in the app. No phone-number matching or user-supplied Telegram ID grants access. Telegram group migration to a different chat ID requires reconnecting the group.

Mention the configured bot username in group text or a photo caption. `/ask@YourBot question` is also accepted in Telegram. The existing AI Chat service handles account/member summaries, clarification, and supported posting drafts. A task is not an arbitrary background job: it must be one of the assistant's supported operations. Financial changes require the same linked user to review the exact draft and send a second explicit `CONFIRM <proposal-id> <digest> VERIFIED` message mentioning the bot. `CANCEL <proposal-id>` cancels a draft.

Replies and financial information are visible to everyone in the group. Invite only authorized committee members. Business access and current project roles are checked before queries, tasks, confirmations and delivery. Telegram replies share the organization's AI Chat allowance; WhatsApp uses its separate bot allowance.

## Platform rollout

Deploy the matching `fund-ledger` and `fundnesta-ai` source, then reload/rebuild the mobile app. Apply additive backend migrations `20261019010000_managed_whatsapp_groups` and `20261019020000_telegram_assistant`, regenerate Prisma, and build the backend. The AI service requires Node 24 or newer; its SQLite inbox upgrade is additive at startup. Run one service process per SQLite database file.

Backend settings (server only):

```dotenv
AI_SERVICE_URL=http://127.0.0.1:4010
AI_SERVICE_SHARED_SECRET=<at least 32 random characters; same on API and AI service>
WHATSAPP_ENABLED=true
WHATSAPP_GROUPS_ENABLED=true
WHATSAPP_WABA_ID=<Fund Nesta shared account ID>
WHATSAPP_PHONE_NUMBER_ID=<Fund Nesta shared phone-number ID>
WHATSAPP_ACCESS_TOKEN=<shared permanent access token>
WHATSAPP_GRAPH_API_VERSION=v23.0
WHATSAPP_CREDENTIALS_KEY=<stable encryption secret>
WHATSAPP_APP_SECRET=<Meta app secret; same on AI service>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<verification token; same on AI service>
WHATSAPP_BOT_ALIAS=@fundnesta
TELEGRAM_BOT_TOKEN=<Fund Nesta shared bot token>
TELEGRAM_BOT_USERNAME=<shared bot username without @>
TELEGRAM_WEBHOOK_SECRET=<random Telegram webhook secret>
```

The AI service also needs its existing OpenAI/model settings, stable session encryption key, API URL and database path. Set `TELEGRAM_BOT_USERNAME` and `WHATSAPP_BOT_ALIAS` identically on both services. No Telegram token is stored in the mobile app or configured independently on the AI service.

Set Meta's callback to `https://YOUR_API/v1/webhooks/whatsapp`, not directly to the AI service. Subscribe to message and Groups API lifecycle/participant/settings/status events. The API validates Meta's signature, durably reconciles group creation, and forwards signed group messages to the AI service's durable inbox. Private legacy message processing remains separate and explicitly ignores group messages. Verify account eligibility and actual provider callbacks with an eligible test number before enabling customer creation.

Set Telegram's callback to `https://YOUR_API/v1/integrations/telegram/webhook`, with `secret_token` matching `TELEGRAM_WEBHOOK_SECRET`, and allow `message` updates. The API handles group/identity linking and forwards only explicit bot mentions to the AI inbox using a body HMAC signed with the shared service key. The AI endpoint is an internal bridge, not Telegram's direct callback. Making the bot a group admin ensures mention and photo-caption delivery; the worker ignores ordinary group messages.

A missing platform configuration shows a customer-facing unavailable state. It never falls back to a credentials form. Existing per-project WhatsApp connections are preserved and require operator migration to the shared bot; the new screen does not silently replace their group.

## Operations and verification

One durable creation claim per project prevents duplicate groups from repeated taps. Uncertain creation outcomes are not retried automatically. If a creation times out before its provider request ID is saved, an operator must reconcile it with Meta and the signed creation-event inbox before allowing another attempt. The callback inbox also handles a callback arriving before the creation response. If the callback contains only a group ID, the API retrieves the invitation using Meta's read-only invitation endpoint. Refresh status can retry that lookup safely.

Managed WhatsApp credentials are encrypted per project for the existing delivery adapters. When rotating the shared token, operators must refresh the encrypted token snapshots on managed connections using the same encryption key; do not reconnect or create another group. Managed-group disconnection is operator-managed to preserve reconciliation state.

Webhook/event IDs deduplicate deliveries. A worker which may have sent a message or committed a posting records an uncertain outcome and does not automatically resend it. Reconcile provider/ledger state before a manual retry. AI payload retention remains 90 days. Creation callback records contain group IDs/invitation links and should be restricted to operators and purged under the platform retention policy once reconciliation is complete.

Validation uses invented data and mocked providers:

- Mobile: `npm run typecheck`; `node --test tests/managed-bots.test.cjs tests/assistant-posting.test.cjs tests/reporting.test.cjs`; Expo web export.
- Backend: `npm run build`; `node --test tests/managed-whatsapp.test.mjs tests/telegram-assistant.test.mjs tests/ai-service.routes.test.mjs tests/reporting.test.mjs tests/migration-integrity.test.mjs`.
- AI service with Node 24+: `node --test tests/*.test.mjs`.

No production migration, deployment, provider request, real group creation, message or financial posting is performed by these source changes. Static visual fixtures render the actual sheet components using invented data; native device behavior and live provider delivery still need deployment-side verification.

References: [Meta OpenAPI](https://github.com/facebook/openapi/blob/main/business-messaging-api_v23.0.yaml), [Groups API requirements](https://docs.360dialog.com/docs/messaging/groups), [Telegram deep links](https://core.telegram.org/bots/features#deep-linking), [Telegram privacy](https://core.telegram.org/bots/features#privacy-mode).
