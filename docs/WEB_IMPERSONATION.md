# Web support impersonation

The private URL is **https://fundnesta.appnesta.com/support/impersonate**. There is
no public navigation item. Native iOS/Android use the original session provider;
the support page, directory client and banner are web-only modules.

This is view-only support access. A hidden URL is not authorization: the API
requires a recent, verified master login, the configured web origin and a separate
master code before it issues a support session.

## Enable on the API server

Set these **backend-only** environment values. Keep the code out of this repository,
chat, browser storage, URLs, logs, and every `EXPO_PUBLIC_*` variable.

```env
MASTER_USER_EMAIL=your-verified-master-account@example.com
MASTER_USER_ID=the-existing-master-account-database-id
MASTER_IMPERSONATION_CODE=a-high-entropy-secret-of-at-least-32-bytes
MASTER_WEB_ORIGIN=https://fundnesta.appnesta.com
```

Generate a code privately with `openssl rand -hex 32`. `MASTER_USER_ID` is optional
but recommended to pin one exact account when an email has several organization
accounts. `Master_user_email` is accepted as an email variable alias; the uppercase
name takes precedence. The feature fails closed when the email, code or origin is
missing/invalid. A short PIN is not accepted. The code is compared using hashes and
a constant-time comparison; it is never returned to the browser.

For local testing, set `MASTER_WEB_ORIGIN` to the exact local web origin, including
its port. HTTP is accepted only for localhost/127.0.0.1 outside production.

1. In `fund-ledger`, review and apply the additive Prisma migration
   `20261024010000_web_impersonation` using the normal release migration process.
   It adds nullable session provenance fields and an index; it does not enable
   access or change existing users or their session expiry dates.
2. Generate Prisma types and deploy the matching API source. The migration must
   be applied before the new API queries session fields.
3. Configure the backend variables and deploy the Expo web export. The normal
   web origin must also remain permitted by the API's existing CORS configuration.
   No master secret or special environment setting is needed on the static host.
4. Sign out and sign in with the configured account using Google or an email
   verification code. Old sessions, phone-only logins and unverified profile
   emails cannot authorize support access. This fresh login is required even if
   an existing browser session otherwise still works.
5. Open the private URL directly, search by name/email/organization, choose the
   explicit account/project, enter the support reason and master code, then select
   **Start view-only session**. The master login must be less than 30 minutes old.

## Session boundaries

- Every support session has its own signed token and database record. Both expire
  after at most 15 minutes, bounded by the master session's expiry and its
  30-minute fresh-login window. Target users' real sessions are never replaced.
- The support token is kept in this tab's `sessionStorage` record. The normal
  `fundledger.session.v1` login in local storage is not overwritten. Existing tabs
  retain their master login. Browsers can copy sessionStorage into a newly opened
  tab with an opener; a copied support session still shows the banner and shares
  the same revocation and expiry rules.
- Start, stop and expiry perform a full page reload to discard the previous
  account's in-memory state. Late session writes cannot resurrect a stopped
  support record. An expired/corrupt record on refresh returns to the support
  page instead of silently opening the master workspace.
- The banner identifies the target email, says **View only**, displays expiry and
  provides **Stop impersonating**. Stop revokes the support family and restores
  the original browser login; it does not mint or return a master credential.
  An offline stop clears local access immediately; server revocation still needs
  a working connection, and the existing server expiry continues to apply.
- Reads require the live, active master parent session on every authenticated
  request. Logging out/revoking the parent, disabling the master account, changing
  its email, or rotating the configured master policy invalidates support access.
  A 20-second status check and 401 handling also clear revoked access in the UI.
- The target's live project roles and subscription checks still apply. Support
  cannot traverse linked identities or switch into another account/organization.
  Project switches rotate the support token, revoke the previous one and preserve
  its original actor and expiry. They cannot mint ordinary user credentials.

## Read-only enforcement and audit

The backend rejects mutations before business handlers run. The only permitted
POST operations are scoped project switching, logout and stopping impersonation.
This blocks changes, uploads, AI actions, reminders, invitations, account deletion,
credential operations and nested impersonation. Some preview/calculation screens
that use POST are intentionally unavailable. Existing UI action buttons may remain
visible, but their API calls fail with the explicit view-only message.

Support reads do not update the target's login/activity timestamps, backfill
opening-balance transactions, repair missing financial member links, initialize
inventory locations, or reconcile WhatsApp setup. Inventory screens that require
a missing default store stay unavailable until a normal authorized user creates
it. The master actor, target account, parent session,
reason, expiry, project changes, reads, blocked writes and stop events are audited.
Master codes, access tokens and directory search strings are not included in these
audit records. Failure to record a start audit rolls its session creation back;
failure to record a read attempt prevents the requested data from being returned.
Support audit records are excluded from customer activity feeds to protect the
master's contact details and internal access reasons; they remain in the database
audit trail for authorized operational review.
Configure proxy/access-log redaction for directory search query parameters too;
the audit policy does not control upstream HTTP logs.

Five invalid code attempts lock further attempts for 15 minutes across logins and
API replicas. A PostgreSQL advisory lock and shared audit counter enforce this;
the ordinary per-IP request limiter is an additional bound. Start/switch/stop
transactions coordinate session-family changes. Only one child per master login
remains active. Secrets/configuration are read on the server, so policy rotation
invalidates existing children through their stored policy fingerprint.

The private web route is omitted from the sitemap, uses noindex/no-store headers,
and rejects framing on Vercel. The origin/platform check narrows browser use but
is not device attestation: raw clients can forge those headers. Authorization
still depends on verified master identity, a live parent session and the secret.
Like the application's existing bearer-token architecture, sessionStorage is
readable by JavaScript; preventing XSS remains necessary. No feature can make a
stolen master login plus master code harmless. Use a protected, dedicated master
account, strong Google/email account security and restricted secret access.

The approach follows OWASP guidance on
[session rotation and expiry](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and [reauthentication and throttling](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

## Validation

```sh
npm run typecheck
node --test tests/impersonation-storage.test.cjs tests/project-session.test.cjs tests/google-oauth.test.cjs tests/web-workspace.test.cjs tests/web-seo.test.cjs
npm run build:web
```

Backend tests use mock users, sessions and a local HTTP server. Disable SMTP and
set the OAuth redirect fixture explicitly when running login regression tests:

```sh
npm run build
SMTP_USER='' SMTP_PASS='' NODE_ENV=test GOOGLE_APP_REDIRECT_ALLOWLIST='fundnesta://auth' GOOGLE_OAUTH_CLIENT_SECRET='isolated-google-secret' node --test tests/impersonation.routes.test.mjs tests/organization-billing.routes.test.mjs tests/google-onboarding.routes.test.mjs tests/managed-whatsapp.test.mjs tests/account-bank-setup.test.mjs
```

Review the migration and exercise a dedicated staging master/test account before
production enablement. The migration, real master configuration, production
impersonation and deployment are not performed by this source change.
