# FundLedger Mobile API Integration

This guide is the mobile implementation handoff. The complete endpoint inventory is in
[`API.md`](./API.md), and the Apidog/Postman import file is
[`apidog-openapi.json`](./apidog-openapi.json).

Detailed member settlement, removal, and transfer payloads are in
[`MEMBER_EXIT_API.md`](./MEMBER_EXIT_API.md).

For settlement-only integration, use
[`MEMBER_SETTLEMENT_API.md`](./MEMBER_SETTLEMENT_API.md).

## Environments

| Environment | Base URL |
| --- | --- |
| Local | `http://localhost:4000` |
| Production | Use the deployed `PUBLIC_API_URL` value |

All application endpoints are under `/v1`. The health check is `GET /health`.

## Response contract

Successful responses use:

```json
{
  "ok": true,
  "data": {}
}
```

Validation and application errors use:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION",
    "message": "Invalid request",
    "fields": {}
  }
}
```

The mobile client should always read business data from `data`, and display `error.message`
for a failed request. `error.fields` can be mapped to form fields when present.

## Authenticated requests

Store the session token in secure device storage. Send both headers for project-scoped APIs:

```http
Authorization: Bearer <token>
X-Project-Id: <active_project_id>
Content-Type: application/json
```

Use `POST /v1/auth/switch-project` when the user changes projects, then update the locally
stored `active_project_id`. Passing `X-Project-Id` on every project request is still recommended.

Amounts are JSON integers. Timestamps returned by the API are ISO 8601 strings.

## App startup routing

After restoring a token, call `GET /v1/auth/me`.

1. If the request returns `401`, clear the token and show sign-in.
2. If `subscription.has_access` is false, show the subscription screen.
3. If `onboarding.status` is `in_progress`, resume the first pending onboarding step.
4. Otherwise open the dashboard using `active_project_id`.

The response also contains `roles`, `memberships`, `member_id`, and
`can_pay_for_members`, which should drive menu visibility and payment controls.

## Google sign-in and signup

### API-hosted OAuth flow

Open this URL in the system browser or an auth session:

```text
GET /v1/auth/google?intent=login&redirect_uri=fundledger://auth
```

Optional query parameters:

- `intent`: `login` or `signup`
- `tenant_slug`: use only when the same Google email can belong to multiple organizations
- `redirect_uri`: the mobile deep link that receives the result

The API redirects back to the app as one of:

```text
fundledger://auth?ticket=<one-time-ticket>&status=identity
fundledger://auth?error=<message>
```

Exchange the ticket:

```http
POST /v1/auth/google/complete
Content-Type: application/json

{ "ticket": "<one-time-ticket>" }
```

An existing user receives a session:

```json
{
  "ok": true,
  "data": {
    "kind": "session",
    "token": "eyJ...",
    "user": { "id": "usr_1", "name": "Nadia", "mobile": "+880..." },
    "tenant": { "id": "ten_1", "name": "Green Valley", "slug": "green-valley" },
    "active_project_id": "prj_1",
    "memberships": []
  }
}
```

An unknown Google email starts signup immediately:

```json
{
  "ok": true,
  "data": {
    "kind": "signup",
    "signup_needed": true,
    "provider": "google",
    "email": "nadia@gmail.com",
    "name": "Nadia Rahman",
    "ticket": "<same-ticket>",
    "signupFlow": {
      "next_endpoint": "/v1/auth/google/signup",
      "onboarding_entrypoint": "organization",
      "prefill": {
        "owner_email": "nadia@gmail.com",
        "owner_name": "Nadia Rahman"
      }
    }
  }
}
```

Route `kind: "signup"` directly to the organization screen with the returned name and email
prefilled. Keep the ticket only in memory; it expires after 30 minutes.

Complete signup:

```http
POST /v1/auth/google/signup
Content-Type: application/json

{
  "ticket": "<one-time-ticket>",
  "org_name": "Green Valley Society",
  "owner_name": "Nadia Rahman",
  "owner_mobile": "+8801711553300",
  "project_name": "Tower A",
  "total_shares": 52
}
```

`owner_mobile`, `project_name`, and `total_shares` are optional. The response contains a normal
session token plus `onboarding` and `subscription`; continue with the onboarding flow below.

### Firebase Google token alternative

If the app already uses Firebase Google authentication, send its ID token to:

```http
POST /v1/auth/login
Content-Type: application/json

{ "id_token": "<firebase-id-token>" }
```

For an unknown email, this returns `kind: "signup"` with
`signupFlow.next_endpoint = "/v1/onboarding/signup"`. Call that endpoint with the same
`id_token` and the organization fields.

## Phone OTP sign-in

Request an OTP for an existing user:

```http
POST /v1/auth/otp/request
Content-Type: application/json

{ "mobile": "+8801711553300" }
```

Then create a session:

```http
POST /v1/auth/login
Content-Type: application/json

{
  "mobile": "+8801711553300",
  "otp": "123456",
  "tenant_slug": "green-valley"
}
```

`tenant_slug` is needed only if that identity belongs to more than one tenant. OTP login does
not create a new account. Users are created when an owner/admin invites them or when a member is
added.

## Invitation deep links

Adding a member, membership, or invitation creates/links a user and returns both camelCase and
snake_case aliases for the links:

```json
{
  "invitation_link": "fundledger://invite?...",
  "app_download_link": "https://...",
  "invitationEmail": { "sent": true, "to": "member@gmail.com" },
  "signInOptions": [
    { "method": "google", "label": "Sign in with Google" },
    { "method": "otp", "label": "Sign in with OTP" }
  ]
}
```

The invite deep link can include:

- `tenant_id`
- `project_id`
- `role`
- `mobile`
- `email`
- `invitation_id` or `member_id`
- `api_url`

On `fundledger://invite`, persist the project context temporarily and show the two sign-in
options. Google must use the invited email. Phone sign-in must use the invited mobile. After
login, use the returned `active_project_id` and memberships as the source of truth.

## Owner onboarding

The standard sequence is:

| Step | Endpoint | Main payload |
| --- | --- | --- |
| Create organization | `POST /v1/onboarding/signup` | `org_name`, owner identity, optional project fields |
| Resume state | `GET /v1/onboarding/status` | none |
| Organization/project | `POST /v1/onboarding/organization` | organization/project fields |
| Accountant | `POST /v1/onboarding/accounting` | accountant and approval modes |
| Accounts | `POST /v1/onboarding/accounts` | one or more bank/cash accounts |
| Shareholders | `POST /v1/onboarding/shareholders` | one or more members |
| Optional final skip | `POST /v1/onboarding/skip` | `{ "step": "shareholders" }` |
| Finish | `POST /v1/onboarding/complete` | none |

Example accountant setup:

```json
{
  "accountant": {
    "name": "Rashid Khan",
    "mobile": "+8801811553300",
    "email": "rashid@gmail.com"
  },
  "approval_flow": {
    "income": "accountant_only",
    "expense": "accountant_and_approver"
  }
}
```

Example account setup:

```json
{
  "accounts": [
    { "name": "Main Cash", "type": "cash", "is_default": true, "opening_balance": 10000 },
    { "name": "City Bank", "type": "bank", "opening_balance": 0 }
  ]
}
```

## Mobile screen endpoint map

| Screen or action | Method and path |
| --- | --- |
| Session/bootstrap | `GET /v1/auth/me` |
| Project picker | `GET /v1/projects`, `POST /v1/auth/switch-project` |
| Dashboard | `GET /v1/dashboard` |
| Member list/detail | `GET /v1/members`, `GET /v1/members/:id` |
| Add/edit member | `POST /v1/members`, `PATCH /v1/members/:id` |
| Resend member invitation | `POST /v1/members/:id/invitation/resend` |
| Member exit balance | `GET /v1/members/:id/settlement`, `POST /v1/members/:id/settle` |
| Remove/transfer member | `POST /v1/members/:id/remove`, `POST /v1/members/:id/transfer` |
| Project roles | `GET /v1/memberships`, `POST /v1/memberships` (email or mobile), `PATCH /v1/memberships/:id` |
| Invite user | `POST /v1/invitations` |
| My dues/summary | `GET /v1/me/dues`, `GET /v1/me/summary` |
| Payment schedules | `GET /v1/schedules` (system accounting schedules are hidden by default) |
| Upload proof/document | `POST /v1/uploads` (`multipart/form-data`, field `file`) |
| Submit payment | `POST /v1/deposits` |
| Submit advance | `POST /v1/deposits/advance` |
| Payment approval queue | `GET /v1/deposits` |
| Approve/reject payment | `POST /v1/deposits/:id/approve`, `POST /v1/deposits/:id/reject` |
| My receipts | `GET /v1/me/receipts` |
| Expenses | `GET /v1/expenses`, `POST /v1/expenses` |
| Approve/reject expense | `POST /v1/expenses/:id/approve`, `POST /v1/expenses/:id/reject` |
| Accounts and entries | `GET /v1/accounts`, `GET /v1/accounts/:id/in-out` |
| Create/adjust account | `POST /v1/accounts`, `POST /v1/accounts/:id/adjust` |
| Transfer funds | `POST /v1/transfers`, or `POST /v1/accounts/:id/transfers` from account detail |
| Audit trail | `GET /v1/activity` |
| Notification feed | `GET /v1/notifications`, `PATCH /v1/notifications/:id/read` |
| Push token | `POST /v1/notifications/device-token`, `DELETE /v1/notifications/device-token` |

## Important write payloads

Add a member (also creates/links the user and member membership):

```json
{
  "name": "Imran Hossain",
  "mobile": "+8801911553300",
  "email": "imran@gmail.com",
  "shares": 2,
  "address": "Flat B-4",
  "previous_due_amount": 5000
}
```

Bulk member import is safe to repeat with the same CSV. `POST /v1/members/import` creates new
mobiles, reactivates inactive matches, and updates active matches in place. It does not delete or
duplicate historical accounting data. The response includes:

```json
{
  "ok": true,
  "data": {
    "imported_count": 12,
    "created_count": 0,
    "reactivated_count": 4,
    "updated_count": 8,
    "created_member_ids": [],
    "reactivated_member_ids": ["mem_09", "mem_10", "mem_11", "mem_12"],
    "updated_member_ids": ["mem_01", "mem_02", "mem_03", "mem_04", "mem_05", "mem_06", "mem_07", "mem_08"],
    "previous_due_total": 0,
    "previous_due_ignored_count": 12,
    "schedule_name": null,
    "invitation_emails_sent": 4,
    "invitation_emails_failed": 0
  }
}
```

`previous_due_amount` is created only for new members. It is ignored for existing members so
uploading the same file cannot add the same opening due twice.

Before removing or transferring a member, load the settlement summary:

```http
GET /v1/members/mem_1/settlement
```

The operation is allowed only when `can_exit` is `true`. Pending deposits must be approved or
rejected through the normal payment workflow first. To apply advance credit, write off an
authorized remainder, and refund unused advance through its original account:

```json
{
  "reason": "Final settlement before ownership transfer",
  "apply_advance_to_dues": true,
  "write_off_remaining_dues": true,
  "refund_remaining_advance": true
}
```

Send that payload to `POST /v1/members/:id/settle`. A real payment should still use the normal
deposit flow; `write_off_remaining_dues` records a waiver, not a payment.

When `refund_remaining_advance` refunds money to the member, each `refunds` item identifies the
bank/cash account and confirms the ledger impact:

```json
{
  "deposit_id": "dep_advance_01",
  "account_id": "acc_main_01",
  "account_name": "Main Bank Account",
  "account_is_default": true,
  "transaction_id": "txn_refund_01",
  "amount": 3000,
  "account_balance_before": 25000,
  "account_balance_after": 22000
}
```

Applying advance to a due does not deduct the account again because the confirmed advance already
increased that account. It changes the member's advance allocation and due balance, and creates a
`member.advance_applied` audit event with `account_balance_changed: false`.

Remove a settled member:

```json
{ "reason": "Member resigned from the project" }
```

Send to `POST /v1/members/:id/remove`.

Transfer settled membership and shares to a new user:

```json
{
  "reason": "Ownership transferred by agreement",
  "new_member": {
    "name": "New Shareholder",
    "mobile": "+8801711000022",
    "email": "new.member@gmail.com",
    "address": "Dhaka"
  }
}
```

Alternatively, send `target_member_id` instead of `new_member` to transfer shares to an existing
member. The old member's historical dues, deposits, receipts, and audit records remain attached
to the old record; only shares and active member access move.

Submit a payment. `schedule_ids` and `account_id` are required:

```json
{
  "schedule_ids": ["sch_january", "sch_february"],
  "member_id": "mem_1",
  "account_id": "acc_bank_1",
  "amount": 20000,
  "method": "bkash",
  "proof_file_id": "file_1",
  "reference": "TrxID ABC123",
  "allocate": "penalty_first"
}
```

For member submissions, show the upload control as **Receipt (required)**. Upload the receipt or
transaction screenshot through `POST /v1/uploads`, then send the returned file ID as
`proof_file_id`. If it is missing, display the API message: `Please upload a receipt before
submitting this payment`. Do not display internal request-property names as validation text.

Submit an expense:

`expense_date` accepts a calendar date (`YYYY-MM-DD`) on or before today in Asia/Dhaka. It defaults to the current Dhaka date for older clients. `vendor_phone` is optional; an existing vendor's saved phone is used when it is omitted, while explicit `null` leaves the expense contact blank without editing the vendor directory. The returned `expenseDate` and `vendorPhone` preserve these values. Expense grouping uses the business date; `createdAt` and `paidAt` continue to record when the expense was posted and disbursed.

```json
{
  "title": "Cement purchase",
  "amount": 50000,
  "category": "materials",
  "vendor": "ABC Traders",
  "account_id": "acc_bank_1",
  "doc_file_id": "file_2"
}
```

Create an account and transfer funds:

```json
{
  "name": "City Bank",
  "type": "bank",
  "is_default": false,
  "opening_balance": 100000
}
```

For the general transfer action, call `POST /v1/transfers`:

```json
{
  "from_account_id": "acc_cash",
  "to_account_id": "acc_bank",
  "amount": 25000,
  "note": "Cash deposit"
}
```

From an account detail screen, call `POST /v1/accounts/{source_account_id}/transfers`:

```json
{
  "to_account_id": "acc_bank",
  "amount": 25000,
  "note": "Cash deposit"
}
```

Grant role access by an existing user's email, mobile, or user ID:

```json
{
  "email": "accountant@gmail.com",
  "role": "accountant"
}
```

When mobile identifies a new user, also send `name`. Email-only lookup grants access to an existing
Google user; an unknown email must first be added as a member or supplied with name and mobile.

## Dashboard charts

`GET /v1/dashboard?chart_months=6` includes two mobile-ready datasets under `charts`:

```json
{
  "charts": {
    "receivable": {
      "goal": 150000,
      "achieved": 90000,
      "remaining": 60000,
      "achieved_percent": 60,
      "series": [
        { "key": "achieved", "label": "Achieved", "value": 90000 },
        { "key": "remaining", "label": "Remaining", "value": 60000 }
      ]
    },
    "income_vs_expense": {
      "period_months": 6,
      "income_total": 210000,
      "expense_total": 125000,
      "net": 85000,
      "series": [
        { "period": "2026-10", "label": "Oct", "income": 50000, "expense": 30000 }
      ]
    }
  }
}
```

Income and expense chart values represent `money_in` and `money_out` cash movement. Account-to-account
transfers are excluded so they do not inflate either side.

## Audit trail UI

Call `GET /v1/activity` with the active project header. It returns the newest 100 events. Each
event includes the actor, entity, before/after snapshots, and timestamp:

```json
{
  "id": "act_1",
  "action": "member.updated",
  "entityType": "member",
  "entityId": "mem_1",
  "before": { "shares": 2 },
  "after": { "shares": 3 },
  "createdAt": "2026-10-03T08:30:00.000Z",
  "actor": {
    "id": "usr_1",
    "name": "Project Owner",
    "mobile": "+880...",
    "email": "owner@gmail.com"
  }
}
```

Recommended display format:

```text
Project Owner updated member Imran Hossain
3 Oct 2026, 2:30 PM
```

Important actions include:

- Members: `member.created`, `member.updated`, `member.removed`, `member.reactivated`, `member.bulk_imported`
- Member exit: `member.balance_settled`, `member.membership_transferred`
- Roles: `invitation.created`, `membership.created`, `membership.updated`, `membership.reactivated`
- Payments: `deposit.submitted`, `deposit.approved_by_accountant`, `deposit.confirmed`, `deposit.rejected`, `deposit.cancelled`
- Expenses: `expense.submitted`, `expense.approved`, `expense.rejected`, `expense.disbursed`
- Banking: `account.created`, `account.adjusted`, `account_transaction.created`, `transfer.created`, `income.recorded`

Use `actor.name` as the primary label and fall back to `actor.mobile`, then `"System"` when
`actor` is null. Use `before` and `after` only on an event detail screen because their shape
depends on the entity type.

## Push notifications

After obtaining an FCM token, register it for the signed-in user:

```http
POST /v1/notifications/device-token

{ "fcm_token": "<token>" }
```

On logout, call `DELETE /v1/notifications/device-token` before `POST /v1/auth/logout`, then clear
the local session even if either network call fails.

## Payment follow-ups

Show the Follow-ups queue and ranking only for `owner`, `admin`, and `auditor`. Add a member Follow-up button for `owner`, `admin`, `accountant`, and `auditor`. Owner/admin/accountant may render Log call on member details; Remind and Mark as paid remain owner/admin-only. Use `GET /v1/follow-ups?tab=need` for the navigation badge and never enable Remind from the device date. The server-provided `reminder.available` is authoritative and should be refreshed when the app returns to the foreground.

After a call log, manual resolution, or reminder, invalidate the follow-up list, member detail, reliability ranking, and badge count. A reminder response with `delivered_count: 0` should show “Member has no app account — call instead”. A `409 REMINDER_ALREADY_SENT_TODAY` keeps the button disabled.

See `docs/PAYMENT_FOLLOWUPS_API.md` for the complete endpoint contract.

## Role values

`owner`, `admin`, `member`, `cashier`, `accountant`, `approver`, `auditor`

The API remains the authority for permissions. Mobile role checks should hide unavailable
actions, but the client must still handle `403` responses.

### Schedule collection and member summary

`GET /v1/schedules` retains its existing fields and adds `collection`: `total` (principal after waivers plus penalties), `collected` (confirmed principal and penalty payments), `remaining`, `pending`, `waived`, `paid_count`, `dues_count`, and `collected_percent`. Pending deposits in either approval stage are forecast against their selected dues in due-date order, capped at outstanding balances across requests; they never count as collected. Draft and closed schedules remain distinguishable by `status`.

`GET /v1/schedules/:id/member-summary` is restricted to staff and management in the selected tenant/project. It returns `{ schedule, collection, items }`; each item includes member identity, shares and photo reference, the due with `outstanding`, `pending_amount`, `pending_deposit_ids`, and exclusive `payment_state` (`unpaid`, `pending`, `paid`). Settled balances including waivers have state `paid`; the UI labels them Settled where appropriate. Pending figures are estimates until confirmation, using the same oldest-due-first policy as deposits.

`GET /v1/recurring-schedules` adds `estimated_total` (rule unit amount times active member shares) and `estimated_dues` (active members with shares). These are forecasts; future membership changes can alter generated dues. Existing schedule PATCH, recurring-rule PATCH, deposit and member-reminder endpoints continue to handle mutations. No new schema migration is needed for schedule summaries.
