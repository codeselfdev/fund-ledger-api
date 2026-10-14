# Project and portal configuration

Deploy migration `20261011010000_project_portal_configuration` before running the updated API. Existing projects default to `fund_shares`; existing deposits retain `accountant` routing. This migration adds columns and enums only. It does not delete members or financial history.

## Creation and onboarding

- `POST /v1/onboarding/signup` and `POST /v1/auth/google/signup`: accept `project_type` (`fund_shares`, `accounting`, `billing`, default `fund_shares`) and `owner_is_member` (boolean, default false).
- `POST /v1/projects`: same fields in addition to existing name, total_shares and address fields. Owner access is always created. An owner Member and member role are created only with `owner_is_member: true` for Fund / Shares. Non-Fund projects do not seed share participants. Type is immutable through project update.
- `POST /v1/onboarding/accounting`: accepts `accountant_is_member` (default false). The accountant account and role are independent of financial membership. Explicit opt-in creates a member role with zero shares; allocate shares separately.
- `POST /v1/onboarding/skip` with `{ "step": "accounting" }`: settles accountant setup without creating an accountant or member. Rejects if an active accountant already exists; manage assigned roles separately.
- `POST /v1/onboarding/skip` with `{ "step": "shareholders" }`: permits deferring member/share assignment, including an empty member list. Shareholder setup never automatically adds management users.
- `POST /v1/memberships` accepts `also_member: true` for an independent explicit member role (zero initial shares). `PATCH /v1/memberships/:id` accepts `also_member: true` to link an existing management user. Untagging/revoking a role does not delete Member history; existing role management applies.

Project lists/details and authentication memberships return `project_type`. Project lists/details return normalized `portal_settings`.

## Project settings

Owner/admin can update only a project in which they have active management access. Use existing `PATCH /v1/projects/:id`:

```json
{
  "portal_settings": {
    "deposit_review": "automatic",
    "member_shortcuts": ["members", "ledger", "expenses"],
    "accountant_shortcuts": ["members", "expenses", "ledger", "commerce"]
  }
}
```

Send the complete settings object. Shortcut lists are ordered, accept empty lists, and reject duplicate or unsupported keys. Member keys: members, ledger, expenses. Accountant keys additionally support commerce, approvals, pending_expenses, accounts. Defaults preserve existing shortcuts. Shortcut visibility is a display preference, never an API permission grant.

## Deposit approval

`deposit_review` supports `automatic` and `admin_only`. Automatic uses active accountant membership with an active user; without one, it routes directly to owner/admin. Admin-only always bypasses the accountant stage. Ordinary and advance submissions store `approvalRoute` (`accountant` or `admin`) at creation.

Direct-admin deposits use existing `pending_approver` status. Only owner/admin can confirm or reject them; no accountant reviewer is fabricated. API list queries exclude direct-admin items from non-management queues. Pending-count queries for admins include both stages. New submission notifications reach owner/admin for direct-admin review; accountant-reviewed deposits notify approver and admins for final confirmation.

`POST /v1/deposits/:id/approve` and `/confirm` retain existing contracts. Final confirmation posts balances/dues/receipts in one transaction. Atomic pending-state transition prevents repeated confirmation from posting twice. Admin can directly finalize a legacy pending_accountant item when accountant access is absent or admin-only review is configured. Changing project settings does not otherwise rewrite recorded routes.

The mobile app resolves project type before selecting a role portal. Fund / Shares has existing features; Accounting and Billing currently display a future-feature placeholder with project switching and sign-out.

Billing projects additionally expose `billing_menus` in project responses and role-aware configuration at `GET /v1/billing/configuration`. Billing default member shortcuts are empty; accountant defaults are `customers`, `billing_invoices`, `billing_collections`, `billing_outstanding`, `billing_reports`. The full billing menu keys can be used in `accountant_shortcuts`; see [Billing Management](BILLING_MANAGEMENT.md). Project creation may omit `total_shares` for Billing (the compatibility field defaults to 1).

## Construction Financial Management

`project_type: construction` opens saved construction budgets, BOQ cost allocation, contractors, certified running bills, supplier/labor payables, site material movements, change orders, financial reports and the existing member/share contribution ledger. See [Construction Financial Management](CONSTRUCTION_FINANCIAL_MANAGEMENT.md) for menu, API, recognition and rollout details.
