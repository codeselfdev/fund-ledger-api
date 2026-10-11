# Independently owned organizations and manual subscription billing

Any authenticated user can create an independently billed organization and its first project using `POST /v1/projects/owned-organization`. The body requires `organization_name`, `name`, `total_shares`, and optionally `project_type`, `address`, `owner_is_member` (default false). This never adds a project or elevates the actor's role in the previous organization. The server creates a separate tenant and organization-local user, an owner membership, default Cash account and completed/skipped optional onboarding. Fund/Share owners can configure accountant roles later; admin-direct approval applies when no accountant exists. The response includes `tenant_id`, `project_id`, roles and optional member link.

A nullable `users.identity_root_id` explicitly links accounts created through this authenticated operation. Existing identities are never merged using email or mobile matching. Existing organization-scoped JWT/session validation and operational membership filters remain unchanged. `GET /v1/projects` and `/v1/auth/me` expose only active projects granted to accounts within the explicit identity group. Memberships include `tenant_id`. Discovery and creation remain available after subscription expiry or loss of the previous project role.

`POST /v1/auth/switch-project` accepts `project_id`. Same-organization switching retains the existing token. Cross-organization switching verifies the explicit identity link and active target membership, then returns a new organization-scoped login payload with `token`, `user`, `tenant`, `identity_root_id`. Mobile must hydrate `/auth/me` using that new token and validate the identity root, target project, user, organization and membership before persisting. Role and member linkage come only from the target project's memberships. Switching back restores the original organization role. Clients must not send the old token to target operational APIs.

New organizations receive three calendar months free (month-end dates are clamped), not a fixed 90-day approximation. Existing trial and paid-period records are retained. Expiry blocks operational APIs with 402. Billing, payment submission, discovery and switching remain available. No unpaid invoice is generated automatically: the operator issues one if a renewal payment is needed, choosing the yearly amount and instructions. Amounts are positive whole currency units; no hardcoded price.

## Owner payment flow

- `GET /v1/subscription` returns access status, trial end, paid period end and `can_manage_billing`.
- `GET /v1/subscription/invoices` is restricted to organization management.
- `POST /v1/subscription/invoices/:id/payment` accepts `{ "payment_reference": "transaction-or-receipt-reference" }`. A reference only submits a payment for review; it never restores access.
- Rejected submissions show the operator's reason and can be resubmitted. Already submitted payments cannot be overwritten while being reviewed.
- The previous customer `/subscription/renew` and `/subscription/trial` routes return 403. Tenant contact updates reject reserved subscription/billing fields.

## Trusted billing operator

These endpoints require the existing server-side provisioning API key, not a customer JWT. Never store this key in mobile:

- `GET /v1/platform/billing/:tenantId/invoices`
- `POST /v1/platform/billing/:tenantId/invoices` with `{ "amount": 2500, "currency": "BDT", "instructions": "Your manual payment instructions" }` (example amount only).
- `POST /v1/platform/billing/:tenantId/invoices/:invoiceId/review` with `{ "decision": "approve" }` after verifying the manual payment; or `{ "decision": "reject", "reason": "Payment not found" }`.

Alternatively, on the trusted backend host use `npm run billing -- list ORG`, `npm run billing -- issue ORG AMOUNT "INSTRUCTIONS"`, `npm run billing -- approve ORG INVOICE`, or `npm run billing -- reject ORG INVOICE "REASON"`. Production equivalents use `billing:prod` after compilation. CLI actions require backend/database access and perform real writes.

Approval atomically records the invoice and renews the organization for exactly one calendar year from the later of now or its existing trial/paid end. Retrying approval never grants another year. Rejection does not renew access. Optimistic concurrency on tenant `updatedAt` prevents competing billing approvals, and contact writers include the same precondition to avoid undoing a concurrent approval. Every billing mutation is audited in its transaction. Invoices are persisted under the existing tenant contact JSON; no separate invoice migration is required.

## Rollout and validation

Additive migration `20261011100000_linked_organization_identity` adds the nullable identity link, index and foreign key. It does not relink, delete or migrate existing financial data. Apply only after normal database backup and migration review; this task does not deploy or run live database migrations. Generate Prisma client and build the backend before deploying a matching app. Older servers return 404 for the new organization creation endpoint instead of accidentally creating a project in the previous organization.

Regression tests mock persistence and run real auth, projects, tenant, subscription and billing routers. They verify all seven starting roles, identity spoofing, foreign/revoked membership rejection, scoped token isolation, returning to member access, optional financial links, trial boundaries, manual approval and idempotent/concurrent renewal.
