# FundLedger API List

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
| POST | `/v1/onboarding/signup` | public | Step 1: create org + owner + initial project + 6‑month trial; returns token |
| GET | `/v1/onboarding/status` | any | Current onboarding step states, approval flow, and completion status |
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
| POST | `/v1/projects` | owner | Create project with share cap and optional penalty policy |
| POST | `/v1/invitations` | owner, approver | Invite or grant project role by mobile |
| POST | `/v1/auth/otp/request` | public | Create one-time login code for registered mobile |
| POST | `/v1/auth/login` | public | Login with mobile and OTP; returns bearer token and memberships |
| POST | `/v1/auth/switch-project` | any | Set active project for current session |
| GET | `/v1/auth/me` | any | Current user, tenant, active project, roles, linked member, `can_pay_for_members`, onboarding, subscription |
| POST | `/v1/auth/logout` | any | Revoke current token |
| GET | `/v1/subscription` | any | Current tenant subscription status for mobile gating |
| POST | `/v1/subscription/renew` | owner, admin | Renew subscription for 1 year |
| POST | `/v1/subscription/trial` | owner, admin | Start/reset custom trial period (`trial_days`) |

## Members & Shares

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/members` | staff | List members with status and search filters |
| GET | `/v1/member-document-titles` | any | List active member-document title dropdown options |
| POST | `/v1/member-document-titles` | owner, admin | Create fixed document title option |
| PATCH | `/v1/member-document-titles/:id` | owner, admin | Update/disable fixed document title option |
| POST | `/v1/members/:id/documents` | self, staff | Upload member document against fixed title |
| GET | `/v1/members/:id/documents` | self, staff | List member documents with titles |
| GET | `/v1/members/:id/documents/:documentId/view` | self, staff | View/download member document |
| GET | `/v1/members/import/csv-format` | accountant, admin | Download CSV format for initial bulk import |
| POST | `/v1/members/import` | accountant, admin | Bulk import members via CSV; previous dues go to schedule `Previous installment` |
| GET | `/v1/members/:id` | staff, self | Member detail and contribution summary |
| POST | `/v1/members` | accountant, admin | Add member; validates total shares and supports `previous_due_amount` |
| PATCH | `/v1/members/:id` | accountant | Update contact, shares, activate/deactivate |
| GET | `/v1/deposit-delegates` | owner, admin | List member users who are allowed to submit deposits on behalf of others |
| POST | `/v1/deposit-delegates` | owner, admin | Grant or revoke on-behalf deposit permission for a specific member user |
| PATCH | `/v1/deposit-delegates/:id` | owner, admin | Toggle an existing on-behalf deposit permission record |

Required member fields: `name`, `mobile`, `shares`. Optional: `address`, `email`, `previous_due_amount`.

Member document files are grouped in storage as: `tenant scoped > project scoped > member scoped`.

## Payment Schedules & Dues

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/schedules` | any | List schedules with collection percentage |
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

Recurring scheduler cron creates schedules on intended run day, and checks tenant subscription before creating each scheduled item.
Generated schedule names are dynamic by frequency/date (examples: weekly `1W JAN 26`, monthly `JAN 26`, quarterly `Q1 26`).

## Deposits & Collections

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/deposits` | member, cashier, accountant, admin | Submit member payment; member can submit for another member only when delegated by owner/admin. Accountant submission is auto-marked accountant-approved (`pending_approver`) |
| POST | `/v1/deposits/advance` | member, cashier, accountant, admin | Submit advance member payment; member can submit for another member only when delegated by owner/admin. Accountant submission is auto-marked accountant-approved (`pending_approver`) |
| GET | `/v1/deposits` | staff | Deposit queue; default list is role-scoped (accountant sees `pending_accountant`, approver sees `pending_approver`) |
| POST | `/v1/deposits/:id/approve` | accountant, approver | Accountant step: move to `pending_approver`; approver step: final confirmation, receipt, ledger posting |
| POST | `/v1/deposits/:id/confirm` | approver | Attempt 2: confirm, issue receipt, post ledger entry |
| POST | `/v1/deposits/:id/reject` | accountant, approver | Reject pending deposit with reason |
| POST | `/v1/uploads` | any | Multipart upload for proof or invoice, returns `file_id` |
| GET | `/v1/uploads/:id/view` | any | View/download uploaded attachment by `file_id` |

Required deposit fields: `schedule_id`, `member_id`, `amount`, `method`. Optional: `proof_file_id`, `reference`, `allocate`.

Notifications are created after submission, accountant approval, final confirmation, and rejection.

When a new schedule is created, any confirmed advance deposits for a member are automatically applied to that member's new due.

## Receipts

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/me/receipts` | member | Member payment history |
| GET | `/v1/receipts/:id` | self, staff | Receipt detail |
| GET | `/v1/receipts/:id/pdf` | self, staff | Receipt PDF placeholder response |

## Expenses

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/expenses` | accountant | Initiate expense in `pending` state |
| GET | `/v1/expenses` | staff | List/filter expenses |
| POST | `/v1/expenses/:id/approve` | accountant/approver/admin | Approve and immediately disburse. Permission follows onboarding expense approval flow |
| POST | `/v1/expenses/:id/reject` | accountant/approver/admin | Reject pending expense with reason. Permission follows onboarding expense approval flow |
| POST | `/v1/expenses/:id/disburse` | accountant | Legacy/manual disburse for expenses already in `approved` state |

Required expense fields: `title`, `amount`, `category`. Optional: `vendor`, `doc_file_id`.

Notifications are created after submission, approval, rejection, and disbursement.

## Bank Accounts, Transfers & Ledger

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/accounts` | accountant, admin | Create account with optional `opening_balance` (posts initial `money_in` income entry labeled opening balance) |
| POST | `/v1/incomes` | accountant/approver/admin | Record manual income. Role is enforced by onboarding income approval flow |
| GET | `/v1/accounts` | accountant, auditor | Account balances and total |
| GET | `/v1/accounts/:id/transactions` | accountant, auditor | Movement history for one account |
| GET | `/v1/accounts/:id/in-out` | staff | List account cashflow entries as `in`/`out` with amount and title |
| GET | `/v1/accounts/:id/entries` | staff | Alias of in/out cashflow endpoint for client compatibility |
| POST | `/v1/transfers` | accountant | Move funds between accounts with paired ledger rows |
| GET | `/v1/dashboard` | staff | Role-aware dashboard counters |
| GET | `/v1/ledger` | accountant, auditor | Ledger entries; filter by date, account, direction |

Required transfer fields: `from_account_id`, `to_account_id`, `amount`. Optional: `note`.

## Activity, Notifications & Penalties

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/activity` | any | Scoped immutable audit feed |
| GET | `/v1/notifications` | any | Bell feed for recipient |
| PATCH | `/v1/notifications/:id/read` | any | Mark notification read |
| POST | `/v1/notifications/device-token` | any | Register or refresh current user FCM token (tenant scoped) |
| DELETE | `/v1/notifications/device-token` | any | Remove current user FCM token (logout/device unlink) |
| POST | `/v1/notifications/broadcast` | owner, admin, accountant | Send tenant+project scoped in-app + FCM broadcast by role/member targeting |
| GET | `/v1/penalty-policy` | any | Effective policy for project or schedule |
| PUT | `/v1/penalty-policy?scope=client\|project` | owner | Set client or project policy |
| GET | `/v1/dues/:id/penalty` | self, staff | Penalty breakdown for one due |
| POST | `/v1/dues/:id/penalty/waive` | approver | Waive accrued penalty with reason |

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
- `role`: `owner`, `member`, `cashier`, `accountant`, `approver`, `auditor`
