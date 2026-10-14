# Google sign-in and organization creation

A verified Google email without an active user returns a signup-needed response, not a session. The mobile Sign in entry point keeps the verified identity and opens the Organization/Project wizard. Organization creation returns a real token, user and tenant before session sign-in.

Both `/v1/onboarding/signup` (ID token) and `/v1/auth/google/signup` (OAuth ticket) use the verified email to detect an existing user. An owner contact mobile remains mandatory but may repeat in a separate organization. The internal provisioning field `verifiedGoogleEmail` is set only by these verified server paths, never from request-body fields. Unverified/mobile-only signup retains its mobile collision checks.

Reusing a contact mobile does not link identities, grant existing project memberships or change the previous user. Email-delivered OTPs are blocked when that contact maps to independent accounts with different emails, including OTPs issued before the contact became shared. Google sign-in or Firebase phone/SMS verification continues to use the existing authenticated login flow.

The mobile fallback previously treated a mobile collision as evidence that the Google email already existed. It then passed a signup-needed response into session sign-in, producing “Sign-in did not return an account.” The fallback now checks Google/email-specific conflicts and accepts only session responses. Signup errors preserve the organization/project draft and verified identity.

## Rollout and validation

Build and deploy the API, then rebuild the mobile app for the device. This Google fix adds no database migration; deploy any pending migrations from other changes through the normal API release procedure. Source edits and regression tests do not update the running production API or installed phone app.

Backend: `npm run build` and `node --test tests/*.test.mjs`. The Google route regression fixture mocks Google token validation and Prisma locally; no real identity, account or network provider is used. It covers new emails, existing emails, shared contacts, session/project isolation, required mobiles, duplicate slugs, retryable tickets, unverified email bodies and legacy OTP refusal.

Mobile: `npm run typecheck` and `node --test tests/*.test.cjs`, including Sign in → new-email signup → usable session, preserved drafts, mobile conflicts, signup-needed fallback responses and a successful existing-email signup race.
