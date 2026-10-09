# FundLedger API List

Detailed member exit payloads and responses are available in
[`MEMBER_EXIT_API.md`](./MEMBER_EXIT_API.md).

The standalone member settlement reference is
[`MEMBER_SETTLEMENT_API.md`](./MEMBER_SETTLEMENT_API.md).

The short project logo integration guide is
[`PROJECT_LOGO_API.md`](./PROJECT_LOGO_API.md).

Notices, WhatsApp, receipt history, and expense grouping are summarized in
[`NOTICE_RECEIPT_EXPENSE_API.md`](./NOTICE_RECEIPT_EXPENSE_API.md).

All responses use:

```json
{ "ok": true, "data": {}, "meta": {} }
```

Errors use:

```json
{ "ok": false, "error": { "code": "VALIDATION", "message": "...", "fields": {} } }
```

## Clients, Projects & Sessions

### Self-serve onboarding (recommended)

Onboarding is tracked in a dedicated DB table (`onboarding_progress`) and has **4 required steps**:

1. Organization + project creation
2. Accountant assignment + income/expense approval flow
3. Bank/cash account setup
4. Shareholder member setup (share allocation)

Every new org gets **~6 months free** (`182` days), then yearly renewal.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/onboarding/signup` | public | Step 1: create org + owner + initial project + 6‑month trial; returns token. Accepts Google or Firebase phone `id_token`. Google signup does not require `owner_mobile`. |
| GET | `/v1/onboarding/status` | any | Current onboarding step states, approval flow, and completion status |
| POST | `/v1/onboarding/organization` | owner | Update organization/project details and complete the organization step (`/project` is a compatibility alias) |
| POST | `/v1/onboarding/accounting` | owner | Step 2: assign accountant and set approval flow (`accountant_only` / `accountant_and_approver`) for income & expense |
| POST | `/v1/onboarding/accounts` | owner | Step 3: create required bank/cash accounts |
| POST | `/v1/onboarding/shareholders` | owner | Step 4: create shareholder members and allocate shares toward project cap |
| POST | `/v1/onboarding/skip` | owner | Skip only final shareholders step when at least 1 active share is already assigned |
| POST | `/v1/onboarding/complete` | owner | Mark onboarding completed (only when all required steps are done) |

`GET /v1/auth/me` also returns `onboarding` and `subscription` so clients can resume onboarding and read completion state from DB.

### Provisioning & core APIs

`POST /v1/tenants` remains API-key protected for billing/backend provisioning. Send `X-API-Key: <key>` or `Authorization: ApiKey <key>`. Configure accepted keys with `PROVISIONING_API_KEYS`.

When a tenant subscription expires, operational APIs are blocked for all tenant users. Subscription APIs remain available so the mobile app can display status and trigger renewal.

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/tenants` | api_key | Provision tenant, first owner, default project, default cash account, and subscription trial (`trial_days`, default 182) |
| GET | `/v1/tenants/current` | any | Current tenant details |
| PATCH | `/v1/tenants/current` | owner | Update tenant branding, contact, locale, currency |
| GET | `/v1/projects` | any | Projects accessible to caller |
| GET | `/v1/projects/:id` | member | Project details, share allocation, logo, role, and edit permission |
| POST | `/v1/projects` | owner | Create project with share cap and optional penalty policy |
| PATCH | `/v1/projects/:id` | owner, admin | Update name, share cap, penalty policy, or `logo_file_id`; send `null` to remove the logo |
| POST | `/v1/invitations` | owner, approver, admin | Invite or grant project role by mobile, create/link the user and member, issue OTP, and email app/invitation instructions when email exists |
| GET | `/v1/memberships` | owner, admin | List project role memberships and linked users |
| POST | `/v1/memberships` | owner, admin | Add or reactivate a project role by `user_id`, mobile, or email; creates a user when mobile is new and `name` is supplied |
| PATCH | `/v1/memberships/:id` | owner, admin | Change a project role or activate/deactivate the membership |
| GET | `/v1/auth/google` | public | Start Google OAuth. Query: `intent` (`login` or `signup`), `redirect_uri`, optional `tenant_slug`. Google returns to `/v1/auth/google/callback`. |
| GET | `/v1/auth/google/callback` | public | Google redirect target. Issues a short-lived identity `ticket` (includes ID token) and redirects to the app. |
| POST | `/v1/auth/google/complete` | public | Exchange `{ ticket }`. Existing Gmail returns `{ kind: session, token, ... }`; unknown Gmail returns `{ kind: signup, signup_needed: true, email, name, ticket, id_token, signupFlow }`. |
| POST | `/v1/auth/google/signup` | public | Finish Google signup with `{ ticket, org_name, owner_name?, owner_mobile?, project_name?, total_shares? }`; returns token, memberships, onboarding, and subscription state. |
| POST | `/v1/auth/otp/request` | public | Create one-time login code for registered mobile (legacy fallback) |
| POST | `/v1/auth/login` | public | Login with `{ id_token }` (Google or Firebase phone) or `{ mobile, otp }`. Google users are matched by email. |
| POST | `/v1/auth/switch-project` | any | Set active project for current session |
| GET | `/v1/auth/me` | any | Current user, tenant, active project, roles, linked member, `can_pay_for_members`, onboarding, subscription |
| POST | `/v1/auth/logout` | any | Revoke current token |
| GET | `/v1/subscription` | any | Current tenant subscription status for mobile gating |
| POST | `/v1/subscription/renew` | owner, admin | Renew subscription for 1 year |
| POST | `/v1/subscription/trial` | owner, admin | Start/reset custom trial period (`trial_days`) |

Project logos use the normal authenticated upload flow:

1. Upload an image with `POST /v1/uploads` as multipart form data using `purpose=project_logo`.
2. Send the returned file ID to `PATCH /v1/projects/:id` as `{ "logo_file_id": "..." }`.
3. Read `logo_url` from project list/detail responses and request it with the normal bearer token and project header.

Only owner/admin users can upload or assign a project logo. The selected upload must be an image
from the same tenant and project. Send `{ "logo_file_id": null }` to remove it. Logo assignment and
removal are included in the existing `project.updated` audit record.

## Members & Shares

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/members` | staff | List members with status and search filters |
| GET | `/v1/members/due-overview` | owner, staff | Current schedule due, earlier schedule due, total due, and per-member outstanding breakdown |
| GET | `/v1/member-document-titles` | any | List active member-document title dropdown options |
| POST | `/v1/member-document-titles` | owner, admin | Create fixed document title option |
| PATCH | `/v1/member-document-titles/:id` | owner, admin | Update/disable fixed document title option |
| POST | `/v1/members/:id/documents` | self, staff | Upload member document against fixed title |
| GET | `/v1/members/:id/documents` | self, staff | List member documents with titles |
| GET | `/v1/members/:id/documents/:documentId/view` | self, staff | View/download member document |
| GET | `/v1/members/import/csv-format` | accountant, admin | Download CSV format for initial bulk import |
| POST | `/v1/members/import` | accountant, admin | Idempotent CSV import: create new members, reactivate inactive matches, update active matches, reuse users/memberships, and email invitations to created/reactivated members |
| GET | `/v1/members/:id` | staff, self | Member detail and contribution summary |
| GET | `/v1/members/:id/settlement` | staff, self | Show outstanding principal/penalty, unused advance, pending deposits, and whether removal/transfer is allowed |
| POST | `/v1/members` | accountant, admin | Add member, create/link user and project membership, validate total shares, email app invitation instructions when email exists, and support `previous_due_amount` |
| POST | `/v1/members/:id/invitation/resend` | owner, accountant, admin | Issue a fresh OTP and resend the app invitation email to an existing member |
| POST | `/v1/members/:id/settle` | accountant, admin | Apply unused advance to dues, optionally write off remaining dues, and/or refund remaining advance through the original account |
| POST | `/v1/members/:id/remove` | owner, admin | Soft-remove a zero-balance member, set shares to zero, and revoke the member role |
| POST | `/v1/members/:id/transfer` | owner, admin | Transfer shares and member access to an existing or newly created member after the source balance reaches zero |
| PATCH | `/v1/members/:id` | accountant, admin | Update contact/shares; owner/admin may activate or deactivate, subject to the same zero-balance guard |
| GET | `/v1/deposit-delegates` | owner, admin | List member users who are allowed to submit deposits on behalf of others |
| POST | `/v1/deposit-delegates` | owner, admin | Grant or revoke on-behalf deposit permission for a specific member user |
| PATCH | `/v1/deposit-delegates/:id` | owner, admin | Toggle an existing on-behalf deposit permission record |

Required member fields: `name`, `mobile`, `shares`. Optional: `address`, `email`, `previous_due_amount`.

`GET /v1/members/due-overview` treats the contribution schedule with the latest due date as the
current schedule. `before_current_schedule_due` includes every other outstanding due, including
imported previous installments. All values include unpaid principal and unpaid penalties after
payments and waivers. Members with a zero balance are omitted from `members`.

```json
{
  "ok": true,
  "data": {
    "current_schedule": { "id": "schedule_id", "name": "October installment", "due_date": "2026-10-31T00:00:00.000Z" },
    "amounts": {
      "current_schedule_due": 125000,
      "before_current_schedule_due": 35000,
      "total_due": 160000
    },
    "member_count": 2,
    "members": [
      {
        "member_id": "member_id",
        "name": "Example Member",
        "mobile": "+8801700000000",
        "shares": 2,
        "status": "active",
        "current_schedule_due": 25000,
        "before_current_schedule_due": 5000,
        "total_due": 30000
      }
    ]
  }
}
```

CSV import matches members by mobile within the active project. Existing member and user records are
reused; historical dues, deposits, receipts, and audit data are never deleted. For an existing
member, `previous_due_amount` is ignored to prevent duplicate accounting entries. An inactive
member must still have zero dues, zero unused advance, and no pending deposits before import can
reactivate them.

Member exit workflow:

1. Read `/members/:id/settlement`. Pending deposits must be approved/rejected first.
2. Record a normal deposit when the member pays outstanding dues, or call `/settle` for an authorized advance application, write-off, or refund.
3. Continue only when `can_exit` is `true`.
4. Call `/remove` or `/transfer`. Active owner/admin/accountant/approver/auditor/cashier roles must be reassigned or deactivated separately before exit.

`/settle` never treats a write-off as payment. Written-off principal is stored separately. An
advance refund atomically deducts the advance's original bank/cash account, creates a `money_out`
account transaction, and writes both account and member audit events. The refund response includes
the account balance before and after the deduction.

Applying advance credit to a due does not reduce a bank/cash balance: the cash entered the account
when the advance deposit was confirmed. Application is a non-cash reclassification from member
advance to paid due and is audited as `member.advance_applied`. Deducting cash again would count the
same advance twice.

Member document files are grouped in storage as: `tenant scoped > project scoped > member scoped`.

## Payment Schedules & Dues

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/schedules` | any | List member-facing schedules with collection percentage |
| POST | `/v1/schedules` | approver | Create schedule with fixed `unit_amount` and generate equal dues per active member |
| PATCH | `/v1/schedules/:id` | approver | Edit or close schedule |
| GET | `/v1/recurring-schedules` | approver, admin | List recurring schedule rules |
| POST | `/v1/recurring-schedules` | approver, admin | Create recurring rule (`weekly`, `biweekly`, `monthly`, `bimonthly`, `quarterly`, `yearly`) |
| PATCH | `/v1/recurring-schedules/:id` | approver, admin | Update recurring rule config |
| DELETE | `/v1/recurring-schedules/:id` | approver, admin | Deactivate recurring rule |
| GET | `/v1/me/dues` | member | Signed-in member dues |
| GET | `/v1/me/summary` | member | Contribution, pending, outstanding, penalty due, share percent |
| GET | `/v1/dues` | staff | Staff due list; filter by status |

Required schedule fields: `name`, `unit_amount`, `due_date`. Optional: `status`, `penalty_policy`.

Imported opening dues use an internal schedule with `purpose: "previous_installment"`. It remains in
the database so dues, settlement calculations, and audit history retain their accounting link, but it
is excluded from `GET /v1/schedules` and the dashboard schedule count by default. Staff accounting
tools can request all schedules with `GET /v1/schedules?include_system=true`. System accounting
schedules cannot be edited through `PATCH /v1/schedules/:id`.

Recurring scheduler cron creates schedules on intended run day, and checks tenant subscription before creating each scheduled item.
Generated schedule names are dynamic by frequency/date (examples: weekly `1W JAN 26`, monthly `JAN 26`, quarterly `Q1 26`).

## Deposits & Collections

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/deposits` | member, cashier, accountant, admin | Submit member payment with `schedule_ids`, `account_id`, `member_id`, amount and method; member can submit for another member only when delegated by owner/admin. Accountant submission is auto-marked accountant-approved (`pending_approver`) |
| POST | `/v1/deposits/advance` | member, cashier, accountant, admin | Submit advance member payment; member can submit for another member only when delegated by owner/admin. Accountant submission is auto-marked accountant-approved (`pending_approver`) |
| GET | `/v1/deposits` | staff | Deposit queue; default list is role-scoped (accountant sees `pending_accountant`, approver sees `pending_approver`) |
| DELETE | `/v1/deposits/:id` | member, cashier | Cancel the caller's own payment while it is still pending accountant review |
| POST | `/v1/deposits/:id/approve` | accountant, approver | Accountant step: move to `pending_approver`; approver step: final confirmation, receipt, ledger posting |
| POST | `/v1/deposits/:id/confirm` | approver | Attempt 2: confirm, issue receipt, post ledger entry |
| POST | `/v1/deposits/:id/reject` | accountant, approver | Reject pending deposit with reason |
| POST | `/v1/uploads` | any | Multipart upload for proof or invoice, returns `file_id`; `purpose=project_logo` requires owner/admin and an image |
| GET | `/v1/uploads/:id/view` | any | View/download uploaded attachment by `file_id` |

Required deposit fields: `schedule_ids` (array), `member_id`, `account_id`, `amount`, `method`.
Members must also upload a payment receipt before submission; the uploaded receipt ID is sent in
`proof_file_id`. Receipt upload is optional for authorized staff submissions. Optional fields:
`reference`, `allocate`.

Notifications are created after submission, accountant approval, final confirmation, and rejection.

When a new schedule is created, any confirmed advance deposits for a member are automatically applied to that member's new due.

## Receipts

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/me/receipts` | member | Member payment history |
| GET | `/v1/members/:id/receipts` | owner, staff | Approved payment receipts for a member profile, newest first |
| GET | `/v1/receipts/:id` | self, owner, staff | Receipt detail |
| GET | `/v1/receipts/:id/pdf` | self, owner, staff | Download the generated payment receipt as `application/pdf` |

The member receipt list returns the normal receipt object with its confirmed deposit. The PDF route
uses `Content-Disposition: attachment` and requires the same bearer token and `X-Project-Id` header
as the JSON APIs.

## Expenses

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/expenses` | accountant | Initiate expense in `pending` state |
| GET | `/v1/expenses` | staff | List/filter expenses |
| GET | `/v1/expenses/by-category` | owner, staff | Group expenses by custom/legacy expense category with totals and time-ordered breakdown items |
| POST | `/v1/expenses/:id/approve` | accountant/approver/admin | Approve and immediately disburse. Permission follows onboarding expense approval flow |
| POST | `/v1/expenses/:id/reject` | accountant/approver/admin | Reject pending expense with reason. Permission follows onboarding expense approval flow |
| POST | `/v1/expenses/:id/disburse` | accountant | Legacy/manual disburse for expenses already in `approved` state |

Required expense fields: `title`, `amount`, `account_id`, plus either `category` or `category_def_id`. Optional: `vendor`, `vendor_id`, `doc_file_id`.

`GET /v1/expenses/by-category` accepts the same optional `status` filter as the normal expense list.
Each group contains `category_id`, `category_key`, `category_name`, `total_amount`, `expense_count`,
and `items`. Every item includes `occurred_at`, using the payment time when paid and creation time
otherwise.

Notifications are created after submission, approval, rejection, and disbursement.

## Bank Accounts, Transfers & Ledger

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/accounts` | accountant, admin | Create account with optional `opening_balance` (posts initial `money_in` income entry labeled opening balance) |
| POST | `/v1/incomes` | accountant/approver/admin | Record manual income. Role is enforced by onboarding income approval flow |
| GET | `/v1/accounts` | any | Account balances and total |
| POST | `/v1/accounts/:id/adjust` | accountant, admin | Post an audited manual `money_in` or `money_out` balance adjustment with a reason |
| POST | `/v1/accounts/:id/transfers` | accountant, admin | Transfer from the selected account to another project account with paired ledger rows |
| GET | `/v1/accounts/:id/transactions` | staff | Movement history for one account |
| GET | `/v1/accounts/:id/in-out` | staff | List account cashflow entries as `in`/`out` with amount and title |
| GET | `/v1/accounts/:id/entries` | staff | Alias of in/out cashflow endpoint for client compatibility |
| POST | `/v1/transfers` | accountant | Move funds between accounts with paired ledger rows |
| GET | `/v1/dashboard` | staff | Role-aware counters plus receivable and income-vs-expense chart data; optional `chart_months` (1-24, default 6) |
| GET | `/v1/ledger` | accountant, auditor | Ledger entries; filter by date, account, direction |

Required transfer fields: `from_account_id`, `to_account_id`, `amount`. Optional: `note`.
For an account-detail screen, use `POST /v1/accounts/:id/transfers` and omit `from_account_id`
from the body because `:id` is the source account. Both transfer endpoints use the same atomic balance,
paired ledger, and audit implementation.

## Activity, Notifications & Penalties

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/activity` | any | Scoped immutable audit feed |
| GET | `/v1/notifications` | any | Bell feed for recipient |
| PATCH | `/v1/notifications/:id/read` | any | Mark notification read |
| POST | `/v1/notifications/device-token` | any | Register or refresh current user FCM token (tenant scoped) |
| DELETE | `/v1/notifications/device-token` | any | Remove current user FCM token (logout/device unlink) |
| POST | `/v1/notifications/broadcast` | owner, admin, accountant | Send tenant+project scoped in-app + FCM broadcast by role/member targeting |
| GET | `/v1/integrations/whatsapp` | owner, admin | Read project WhatsApp Business connection and mapped group status |
| PUT | `/v1/integrations/whatsapp` | owner, admin | Verify and securely store a WhatsApp Business Platform connection |
| PUT | `/v1/integrations/whatsapp/group` | owner, admin | Verify and map an eligible Groups API group to the project |
| DELETE | `/v1/integrations/whatsapp` | owner, admin | Disconnect WhatsApp and remove stored credentials/group mapping |
| GET | `/v1/penalty-policy` | any | Effective policy for project or schedule |
| PUT | `/v1/penalty-policy?scope=client\|project` | owner | Set client or project policy |
| GET | `/v1/dues/:id/penalty` | self, staff | Penalty breakdown for one due |
| POST | `/v1/dues/:id/penalty/waive` | approver | Waive accrued penalty with reason |

Register a device with `{ "fcm_token": "..." }`. A manual notice accepts `title`, `body`, either
`roles` or `member_ids`, and optional `send_whatsapp` (default `false`). Its response includes the
in-app/device `recipient_count` and WhatsApp delivery result.

Connect WhatsApp with:

```json
{
  "waba_id": "123456789",
  "phone_number_id": "987654321",
  "access_token": "permanent-system-user-token",
  "graph_api_version": "v22.0"
}
```

Then map the announcement group with `{ "group_id": "...", "group_name": "Project notices" }`.
This integration uses Meta's official WhatsApp Business Platform Groups API. The account and group
must be eligible for that API; a normal consumer WhatsApp group or invite link is not a group ID.
Set `WHATSAPP_CREDENTIALS_KEY` in production so stored access tokens are encrypted independently of
the JWT signing secret.

Automatic in-app/device notices are sent when a manual or recurring payment schedule starts, when a
payment receives final confirmation, and when an expense is approved and posted. When WhatsApp is
enabled, the same events also reach the mapped group. Delivery failures do not roll back the
accounting transaction and are returned or logged for operational follow-up.

WhatsApp is currently off by default. Set `WHATSAPP_ENABLED=true` on the API and
`EXPO_PUBLIC_WHATSAPP_ENABLED=true` in the mobile build when the integration should be exposed.

## Polls & Events

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/polls/active` | any | Active polls with the current user's vote |
| GET | `/v1/polls?status=active\|expired\|closed\|all` | any | Poll history; admins also receive vote counts |
| POST | `/v1/polls` | owner, admin | Publish a poll with 2-10 options and an expiry |
| POST | `/v1/polls/:id/vote` | any | Submit or change the current user's vote |
| GET | `/v1/polls/:id/analytics` | owner, admin | Participation, option totals, and voter breakdown |
| POST | `/v1/polls/:id/close` | owner, admin | Close voting before expiry |
| GET | `/v1/events/upcoming` | any | Next 10 non-cancelled events |
| GET | `/v1/events?scope=upcoming\|past\|all` | any | Event history |
| POST | `/v1/events` | owner, admin | Announce an event |
| PATCH | `/v1/events/:id` | owner, admin | Update event details and reset reminders when time changes |
| POST | `/v1/events/:id/cancel` | owner, admin | Cancel an event and notify project users |

Poll creation requires `title`, `options`, and ISO-8601 `expires_at`; `description` is optional.
Event creation requires `title`, `place`, `agenda`, and ISO-8601 `starts_at`. Active, unvoted poll
members receive an in-app/device reminder every two hours. Event reminders are sent to every active
project user one hour and ten minutes before the start time.

## Payment follow-ups

Owner/admin can log member calls, payment commitments, manual commitment outcomes, and one payment reminder per member per Dhaka day. Auditors have read-only access to the queue and reliability ranking.

| Method | Path | Role |
| --- | --- | --- |
| GET | `/v1/follow-ups?tab=need\|upcoming\|settled` | owner, admin, auditor |
| GET | `/v1/follow-ups/reliability?tier=all\|reliable\|watch\|at_risk` | owner, admin, auditor |
| GET | `/v1/members/:id/follow-up` | owner, admin, accountant, auditor |
| POST | `/v1/members/:id/call-logs` | owner, admin, accountant |
| POST | `/v1/commitments/:id/resolve` | owner, admin |
| POST | `/v1/members/:id/reminders` | owner, admin |

See `docs/PAYMENT_FOLLOWUPS_API.md` for payloads, errors, automatic deposit resolution, Dhaka date rules, and scoring.

## Enum Reference

- `deposit.status`: `submitted`, `pending_accountant`, `pending_approver`, `confirmed`, `rejected`
- `expense.status`: `draft`, `pending`, `approved`, `paid`, `rejected`
- `schedule.status`: `draft`, `active`, `closed`
- `due.status`: `upcoming`, `due`, `overdue`, `partial`, `paid`, `waived`
- `penalty.type`: `onetime`, `recurring`
- `recurring_period`: `weekly`, `monthly`
- `plan`: `free`, `standard`, `pro`
- `payment.method`: `bkash`, `nagad`, `bank`, `cheque`, `cash`
- `account.type`: `bank`, `cash`
- `txn.direction`: `in`, `out`, `transfer`, `penalty`
- `role`: `owner`, `admin`, `member`, `cashier`, `accountant`, `approver`, `auditor`
