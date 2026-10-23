# Platform promotions, AI usage and support replies

Changes span `FundLedgerMobile`, `../fund-ledger` (API) and `../fund-nesta-admin-web` (platform admin).

## Admin workflow

Send notification reaches active accounts with registered push devices across all organizations and plans. Shared device tokens receive one push, with a separate private inbox copy for each eligible account. The signed preview includes the message, poster, action and recipients; changing any of them requires another review. Retries retain idempotency and avoid resending accepted deliveries.

Add a promotional poster by uploading a static JPG, PNG or WebP below 1 MB, at most 1,600 pixels per side, or by pasting a public HTTPS image URL. Uploads require existing R2 storage with a public HTTPS `R2_PUBLIC_URL`. Poster assets are public marketing content. They are stored under random `platform/promotions/` keys and uploads are audited. Uploaded assets persist for notification history, including uploads removed from drafts.

Push payloads carry the image for compatible OS notifications. The app inbox shows the poster; tapping opens the poster with the message and an optional action button. Image-load failures retain the text and action. iOS system notification images additionally require a native Notification Service Extension; this change does not add one. Posters remain available in the app on iOS.

HTTPS actions open in the browser. Supported app actions include:

- `fundnesta://open?screen=home` opens the app workspace.
- `fundnesta://open?screen=support` opens the signed-in customer's support inbox.
- `fundnesta://open?screen=billing` opens current organization billing for owners/admins.
- `fundnesta://notification?project_id=PROJECT&tenant_id=TENANT&destination=notices` opens an existing project destination after checking access. Other destinations: `none`, `dues`, `schedules`, `pay`.
- `fundnesta://support?ticket_id=TICKET&tenant_id=TENANT` opens a specific private support thread after checking organization access. Ticket ownership is checked by the API.

The existing `fundledger://` scheme is also accepted. Broadcasts should normally use generic actions; a specific project or ticket link only works for customers with access to that record. Cold-start actions wait for sign-in. No links open merely because a push arrives.

## Organization AI usage

Organizations now shows AI credits used in the current allowance period and all time. Organization details adds AI chat and WhatsApp AI counts with separate limits, period start and reset date. Reporting uses batched queries and exactly the quota reservation rule: count non-cancelled admitted questions, including queued and failed attempts; request replays reuse the same row. Allowance start follows the UTC month and any package quota reset. All-time totals include previous allowance periods.

## Support reply notifications

The existing API team-reply transaction queues a requester-only inbox notification plus independent push/email deliveries. Provider failures retry without rolling back the reply or resending successful channels. Attachment-only replies have a fallback message. Push data identifies the organization and ticket; mobile opens the customer's private conversation and acknowledges read status. Consumed support push taps now clear Expo's retained response so ordinary subsequent launches do not reopen the old reply.

## Rollout and validation

1. Apply API migration `20261023100000_promotional_posters`, regenerate Prisma, and deploy the API. Existing support delivery tables also require `20261017010000_support_reply_notifications` if not already applied.
2. Keep the existing Firebase server credentials and support delivery worker enabled. Configure public R2 for file uploads or use public HTTPS image URLs.
3. Deploy the updated platform admin and release the mobile update. Older mobile versions do not show posters or generic app actions.
4. Verify an actual installed-device push using a synthetic customer before customer-wide announcements. No production notifications or database changes are performed by the local regression tests.

Local checks: mobile `npm run typecheck` plus notification/support tests; API `npm run prisma:generate`, `npm run build` plus platform-broadcast, poster-upload, admin-AI-usage, support-reply and assistant-credit tests; admin production build, lint and UI tests. Push and storage transports in the API regression tests are mocked; live FCM delivery and production migration execution require deployment validation.
