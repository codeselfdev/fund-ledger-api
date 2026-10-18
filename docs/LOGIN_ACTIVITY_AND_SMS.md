# Login activity and daily OTP SMS allowance

Apply `20261018090000_login_activity_sms_limit`, regenerate Prisma Client and deploy the API before releasing the updated mobile and administration apps.

The `users` table gains nullable `last_login_at`, `last_login_platform` (`android`, `ios`, `web`, `unknown`) and `last_active_at`. Successful OTP, Google, account-selection and self-signup sessions record login metadata. Provisioning a customer or rotating a session while switching projects does not count as a login. Authenticated requests refresh activity at most once per minute per user, with a conditional database write so concurrent requests cannot move the value backwards. Historical users remain null until their next login/activity; timestamps are stored in UTC. The mobile client includes `X-Client-Platform` on JSON and upload requests; older clients use a user-agent best effort.

`POST /v1/auth/otp/request` accepts `{ mobile, recaptcha_token?, signup? }`, where mobile includes its country code. The API asks for reCAPTCHA only when an SMS allowance remains, then makes Firebase's `accounts:sendVerificationCode` request itself. Configure `FIREBASE_WEB_API_KEY` with a key for the same Firebase project as the mobile app; its application restrictions must permit this server-side call. SMTP configuration is required for email delivery. Without a Firebase key, the existing email path is used.

The allowance is **two SMS attempts per tenant per Asia/Dhaka calendar day**, shared by all of its users. Atomic PostgreSQL upserts reserve slots before provider calls, including concurrent calls on different API instances. Provider failures/timeouts consume the slot because a send may already have been accepted; configured email is attempted after an SMS failure. Slots survive restarts and are not consumed by reCAPTCHA preflight, Google login or email delivery. For a number shared by several organizations, one send reserves a slot in every matching organization; if any is exhausted, delivery falls back to email. Before signup creates a tenant, retries are limited to two per day under a hashed phone scope.

After the allowance is used, codes go only to the account's existing email. The response identifies `delivery: "email"`, `masked_email` and `sms_limit_reached`. A missing email returns HTTP 429 with `SMS_DAILY_LIMIT`; SMTP failure returns 503 instead of claiming delivery. Email OTPs cannot cross between different identities sharing a mobile number; those users must continue with Google. Production responses never contain a development code. Successful SMS responses return `delivery: "sms"` and a Firebase `verification_id`; the mobile app confirms the code with Firebase and submits its ID token through the existing login flow.

The cap covers API-mediated sends. **Older released clients that call Firebase directly bypass this API quota.** Upgrade/retire those clients during rollout. Firebase's public phone-auth endpoint itself cannot enforce an application tenant's quota; a provider-level blocking policy is needed if a strict cap must also cover legacy or independently constructed direct Firebase calls.

Organization summaries include `owner` (name, optional email/mobile, login time/platform) and `last_active_at`. The owner is the earliest active owner account, including owners without a financial Member record. Google placeholder mobiles are omitted. Organization last active is the latest authenticated activity across all of its users, including web sessions. The internal operator authentication remains unchanged.

Validation:

```sh
npm run build
node --test tests/login-activity-sms.test.mjs tests/migration-integrity.test.mjs
# Apply migrations to a disposable test database first. Never point this at production.
SMS_TEST_DATABASE_URL=postgresql://.../quota_test node --test tests/login-activity-sms.integration.test.mjs
```

The PostgreSQL tests cover 20 simultaneous reservations (exactly two accepted), all-or-nothing shared scopes, persistence across connections, date reset and stored login/activity metadata. SMS/email providers are mocked in the service tests. No live OTP is sent by these checks.

Firebase contracts: [sendVerificationCode](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/sendVerificationCode), [PhoneAuthProvider](https://firebase.google.com/docs/reference/js/auth.phoneauthprovider).
