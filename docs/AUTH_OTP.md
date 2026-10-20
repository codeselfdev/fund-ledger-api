# Email and mobile OTP authentication

Both Sign in and Create account offer an Email / Mobile selector. Email codes use the existing SMTP configuration. Mobile codes use the existing Firebase SMS service and reCAPTCHA flow, including the daily SMS limit and safe email fallback for existing accounts.

- `POST /v1/auth/otp/request` accepts exactly one of `email` or `mobile`. Unknown contacts can request a code. `signup: true` rejects a mobile already registered to any account before attempting delivery.
- `POST /v1/auth/login` accepts `email` + `otp`, `mobile` + `otp` for the existing email fallback, or the Firebase `id_token` returned after SMS verification. Existing identities receive their session or organization picker.
- A newly verified email or mobile receives a signed `signup_token`, valid for 15 minutes. This opens the organization page of onboarding without granting an authenticated session or creating an empty organization. Submitting organization details to `/v1/onboarding/signup` creates the account using that verified identity. A mobile verification token cannot be used with a different mobile; email verification determines the saved email, regardless of an email supplied in the request body.
- `POST /v1/auth/signup/check-mobile` checks availability before the organization page can advance. All signup paths, including Google, reject reused mobiles. Local Bangladesh and international forms are matched consistently; different country codes do not match merely because they share a suffix.
- Provisioning checks contact availability again inside a transaction with PostgreSQL advisory locks. This prevents simultaneous signup requests from creating separate identities with the same contact. Existing linked organization identities and historical duplicates are preserved.

Email OTPs expire after five minutes. Resending invalidates previous codes, successful verification consumes a code atomically, and request/login endpoints are rate limited. Missing codes never authenticate, including in development. Production responses do not expose development codes.

No new environment variables or database migration are required. SMTP and Firebase must already be configured to deliver real codes. Tests mock delivery and persistence; they do not send real messages or modify the application database.
