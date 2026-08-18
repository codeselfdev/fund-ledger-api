# FundLedger API

Express + TypeScript API service for the FundLedger multi-tenant SaaS app.

## Stack

- Express 4
- TypeScript
- Prisma ORM
- PostgreSQL
- Zod validation
- JWT bearer sessions
- Project-scoped RBAC

## Run Locally

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

## Run with Docker Compose

```bash
docker compose up --build
```

This starts:

- `postgres` on `localhost:5432`
- `ledger-api-service` on `localhost:4000`

The API container runs `prisma migrate deploy` on startup before starting the server.

Stop services:

```bash
docker compose down
```

Health check:

```bash
curl http://localhost:4000/health
```

## Onboarding (self-serve)

Users sign up themselves. Flow is short and skippable:

```text
Signup  →  Project setup (skip OK)  →  Invite team (skip OK)  →  Done
```

Every new org gets **6 months free** (~182 days). After that, renew for **1 year** via `POST /v1/subscription/renew`.

### 1. Signup

```bash
curl -sS -X POST "$API/v1/onboarding/signup" \
  -H "Content-Type: application/json" \
  -d '{
    "org_name": "Green Valley Society",
    "slug": "green-valley",
    "name": "Salahuddin Ahmed",
    "mobile": "+8801711553300",
    "email": "owner@example.com",
    "project_name": "Tower A"
  }'
```

Returns `token`, `project.id`, `onboarding`, and trial `subscription`.

Use:

```http
Authorization: Bearer <token>
X-Project-Id: <project.id>
```

### 2. Project setup (optional)

```bash
curl -sS -X POST "$API/v1/onboarding/project" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Project-Id: $PROJECT_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Tower A Construction","total_shares":52}'
```

Or skip:

```bash
curl -sS -X POST "$API/v1/onboarding/skip" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"step":"project"}'
```

### 3. Invite teammates (optional)

```bash
curl -sS -X POST "$API/v1/onboarding/invites" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Project-Id: $PROJECT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "invites": [
      { "name": "Project Admin", "mobile": "+8801811553300", "email": "admin@example.com", "role": "admin" },
      { "name": "Member One", "mobile": "+8801911553300", "role": "member" }
    ]
  }'
```

Or skip `invites`, or finish everything:

```bash
curl -sS -X POST "$API/v1/onboarding/complete" \
  -H "Authorization: Bearer $TOKEN"
```

`GET /v1/auth/me` and `GET /v1/onboarding/status` expose progress so the app can resume or hide the wizard.

## Bootstrap via CLI (optional)

For internal/ops setup without the mobile signup screen:

```bash
npm run create:super-admin -- \
  --name "Green Valley Society" \
  --slug green-valley \
  --admin-name "Salahuddin Ahmed" \
  --admin-mobile "+8801711553300" \
  --admin-email "owner@example.com" \
  --trial-days 182 \
  --print-otp
```

Coolify / Docker:

```bash
npm run create:super-admin:prod -- \
  --name "Green Valley Society" \
  --slug green-valley \
  --admin-name "Salahuddin Ahmed" \
  --admin-mobile "+8801711553300" \
  --admin-email "owner@example.com" \
  --trial-days 182 \
  --print-otp
```

## Provisioning Key

Tenant signup is not open-public. `POST /v1/tenants` is intended to be called by your billing/backend flow after a one-time or monthly payment check succeeds.

Set one or more comma-separated keys:

```bash
PROVISIONING_API_KEYS=key_live_1,key_live_2
```

Call the endpoint with either:

```http
X-API-Key: key_live_1
```

or:

```http
Authorization: ApiKey key_live_1
```

## Request Scope

Protected requests use:

```http
Authorization: Bearer <token>
X-Project-Id: <project_id>
```

The bearer token identifies the tenant and user. `X-Project-Id` selects the active project and the middleware loads the user's project role(s). Every project table query is scoped by both `tenant_id` and `project_id`.

## Push Notifications (FCM)

FCM delivery is optional and enabled when `FCM_SERVICE_ACCOUNT_JSON` is set.

Expected JSON fields:

- `project_id`
- `client_email`
- `private_key`

The API stores an FCM token against the authenticated tenant user via:

- `POST /v1/notifications/device-token`
- `DELETE /v1/notifications/device-token`

## Object Storage (Local or Cloudflare R2)

Set `UPLOAD_STORAGE=local` (default) or `UPLOAD_STORAGE=r2`.

For R2, configure:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_ENDPOINT` (optional; defaults to `https://<account_id>.r2.cloudflarestorage.com`)

`/v1/uploads/*` and member document upload/view APIs use the same storage backend.

## Roles

- `owner`: tenant admin, project creation, invitations, tenant and penalty policy settings
- `member`: own dues, receipts, payment submissions
- `cashier`: on-site member collections
- `accountant`: members, first deposit approval, expenses, disbursements, transfers
- `approver`: schedules, final deposit confirmation, expense approval/rejection, penalty waiver
- `auditor`: read-only staff access

`staff` endpoints allow `accountant`, `approver`, or `auditor`, matching the supplied spec.

## Database Tables

The Prisma schema in [prisma/schema.prisma](/Users/octolaneai/Desktop/codebase/fund-ledger/prisma/schema.prisma) defines:

- `tenants`, `projects`
- `users`, `project_memberships`, `members`, `invitations`, `otp_codes`, `sessions`
- `schedules`, `dues`, `due_penalty_entries`
- `deposits`, `receipts`
- `expenses`
- `accounts`, `transfers`, `account_transactions`
- `uploads`
- `notifications`, `activity`

## API List

See [docs/API.md](/Users/octolaneai/Desktop/codebase/fund-ledger/docs/API.md).

## Apidog Collection

Import [docs/apidog-openapi.json](/Users/octolaneai/Desktop/codebase/fund-ledger/docs/apidog-openapi.json) into Apidog as an OpenAPI 3.0 collection.
