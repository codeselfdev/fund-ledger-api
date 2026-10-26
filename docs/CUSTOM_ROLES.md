# Custom project roles

Owners and admins open **Roles & access → Create role** to name a role and choose Read and Write for each menu. The editor lists menus for the active project type: Fund / Shares, Accounting, Billing, Construction, or Payroll & PF. Save the definition, then choose it in **Assign role**. Existing built-in roles remain available; their descriptions now reflect the project type rather than assuming shares and deposits.

Read opens a menu and its records. Write includes Read and permits that menu's mutations, including approvals, disbursements, imports, exports, and messaging where those actions exist. Turning Read off also turns Write off. Read-only menus do not offer Write. For forms that select related records, grant Read on the related menus, such as Customers, Items, Contractors, or Accounts. Ledger readers and financial writers can fetch the shared account list needed by their screens without receiving account mutation access. The Construction approvals inbox selects Read on the records it reviews; removing a required Read also removes inbox access. Composite Billing subscriber creation checks every affected menu, including Invoice write when billing starts this month.

Definitions and assignments belong to one tenant/project. Role administration and ownership are reserved for independent built-in owners/admins. A custom role does not grant access to the assistant or unclassified API modules. Role access is additive: an independently assigned built-in role retains its existing permissions. Revoke that assignment if the person should have only the custom role's permissions. The assignment editor changes one existing membership at a time.

## Server and session contract

The sibling `fund-ledger` API implements:

- `GET /v1/project-roles`: project role definitions and active assignment counts.
- `POST /v1/project-roles`: `{ name, description, permissions }`.
- `PUT /v1/project-roles/:id`: the same fields plus `revision`.
- `DELETE /v1/project-roles/:id`: `{ revision }`; active assignments must be removed first.
- Membership POST/PATCH accept `custom_role_id`. Custom assignments use the existing `auditor` enum value as a storage compatibility value, with a foreign key to the definition. This storage value is excluded from independent built-in access. A user can have one custom assignment in the existing auditor membership slot; edit that assignment to select another custom definition. PATCH with `custom_role_id: null` explicitly switches back to a built-in role.

Membership summaries include `builtin_roles` and `custom_roles` alongside the legacy `role`/`roles` fields. Custom-only sessions enter the menu workspace. Individual screens receive a UI scope for the selected menu so read-only access hides write controls. Shortcuts are filtered both locally and by the server.

Authentication loads current definitions on every scoped request. The API checks menu access before its existing handlers, retaining scoped database lookups and financial validation. A custom write grant supplies the existing handler's administrative capability only for that permitted request. It never changes the stored membership or token. An unknown menu/module is denied to custom-only users. Source and destination permissions are both checked for document conversions; file reads and uploads follow attachment purpose.

Shared responses need extra care: Accounting workflow metadata omits aggregates and recent documents when Overview is denied. Payroll filters salary, PF, leave, bills and attendance separately, and Overview returns aggregates without granting raw salary rows. Client role metadata refreshes when returning to the menu list and when the app foregrounds. Server enforcement is immediate even if an older client has stale metadata.

## Rollout

1. In `fund-ledger`, generate Prisma and apply migration `20261025090000_project_roles` with the normal release procedure. It adds `project_roles` and nullable `project_memberships.custom_role_id`; existing memberships are not changed.
2. Deploy the matching API before releasing this app. Older servers keep built-in assignment available but cannot create or list custom definitions.
3. Build the mobile/web app and verify an owner can create and assign a role in each project type. Verify a custom-only account sees only its allowed menus, can read but cannot mutate a read-only menu, and loses server access after its role is edited or revoked.

No production migration or deployment is performed by this source change.

## Validation

Mobile: `npm run typecheck`, `npm run build:web`, and the menu-access, custom-role-workspace, accounting-ui, billing-management, construction, project-session and shortcut-preferences test suites.

API: Prisma generation/validation, TypeScript build, and the menu-access, project-roles.routes, memberships.roles.routes, project-configuration, member-project-read, shortcuts.routes, shortcuts.payroll, payroll.policy and expense-review-policy test suites. API route tests use mocked Prisma fixtures and loopback HTTP servers; they do not test the migration against a live database.
