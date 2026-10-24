# Payroll & PF API

`payroll_pf` is a separate PostgreSQL `ProjectType`. Standard signup, Google signup, owned-organization/project creation, project details, memberships and onboarding checks retain this value. The feature is mounted at `/v1/payroll` behind the existing authentication and subscription gates; every route also verifies the active project's type. Other project types cannot use payroll endpoints.

## Storage and money

The migration `20261024160000_payroll_pf` creates project-scoped settings, employees, runs, leaves, bills, PF entries and actor-bound operation receipts. Employee mobile numbers are normalized to Bangladesh local format and unique inside the project. Imported employees do not automatically receive login access; owners use existing project roles/invitations. Employees link to an authenticated account by its real mobile number and retain that user ID after linking. Synthetic email/Google identifiers cannot be treated as mobile numbers.

Amounts follow the existing account/expense schema: whole taka in bounded signed 32-bit integer columns. Import, bills and salary calculations validate this range. House rent, PF and unpaid deductions round to whole taka. Client previews use the same rounding. No sample employees, payroll runs or receipts are seeded in production.

New hires start in probation. Owners confirm completion through `PATCH /employees/:id/status` with the current revision, `status: active`, actual `probation_completed_on` and a UUID request key; the phone profile includes a confirm-today action. The default PF rule starts contributions after that explicit date, without assuming a probation duration. Joining-date and one-year eligibility are also supported. Contributions start from posted salary runs, never from a theoretical back-calculation over an employee's employment history.

## Endpoints

All routes require bearer auth and an accessible `X-Project-Id`. Responses use `{ok:true,data:...}`. IDs and linked accounts/uploads are tenant/project scoped.

| Method and path | Purpose |
| --- | --- |
| `GET /workspace?month=YYYY-MM` | Settings, employee balances, the month's run and request history; member responses contain only the linked employee's records and salary rows. Bank posting totals and other staff's salary rows are removed. |
| `PUT /settings` | Save PF settings using an expected revision; owner/admin only. |
| `POST /employees/import` | Review-ready rows, `match_by: mobile`, UUID `request_key`. Strictly validate all rows before a transactional upsert. Existing mobile numbers update salaries but retain their original joining date and account link. |
| `PATCH /employees/:id/status` | Owner/admin changes employee status and confirms probation completion. |
| `POST /runs` | Prepare the month, including only staff who have joined. One run per project/month. |
| `POST /runs/:id/check` | An accountant checks a Prepared run with its revision and UUID request key. The preparer cannot check it. |
| `POST /runs/:id/approve` | Owner/admin/approver approves a Checked run; the checker cannot approve it. The original preparer may approve after another accountant has checked. |
| `POST /runs/:id/disburse` | Owner/admin/accountant/cashier posts an Approved run using `account_id`, revision and UUID request key. |
| `POST /leave` | A member applies for their linked employee. Working-day count, Friday exclusion, same-year allowance, pending reservations, overlap and doctor's note requirements are checked on the server. |
| `POST /leave/:id/decision` | Owner/admin/approver approves or rejects; no self-approval. Rejection requires a reason. |
| `POST /bills` | A member submits their own receipt, or owner/admin/accountant submits on behalf of an employee. |
| `POST /bills/:id/check`, `/approve`, `/reject` | Enforce current one/two-step policy, revisions and independent reviewers. Rejection requires a reason. |
| `POST /bills/:id/disburse` | Pay an Approved bill outside any salary run from a selected account. Reserved or previously paid bills cannot be paid separately. |

Write schemas are strict. Totals and status transitions are computed from persisted records; disbursement accepts no client-supplied amount. Settings support rate 5/7.5/10%, basic/gross basis, equal/half/off match, explicit eligibility, graded/cliff/immediate vesting, estimated yearly profit rate, loan parameters and withdrawal/bill approval preferences.

Receipt and doctor's-note uploads use `purpose: payroll_receipt` and `payroll_leave_note`. Submissions require an image/PDF uploaded by the submitting actor in this project. Upload viewing permits authorized staff, the uploader and the linked employee when staff submitted on their behalf. Other employees cannot view the file even if they know its ID. Shared legacy account, ledger, expense, income, activity, report and assistant endpoints are blocked for payroll member-only accounts; their scoped payroll workspace remains accessible.

## Transactions and lifecycle

Financial mutations use the existing serializable transaction retry helper. A durable `(project_id, request_key)` operation receipt binds the request to its actor, endpoint and parsed payload, and returns the original result on retries. A different account, actor or payload cannot reuse that key. Item status/revision and conditional balance checks prevent double payment even when a caller uses a different request key. A failed account, expense, ledger, PF or operation-receipt write rolls back the entire transaction.

Approval changes no cash balance. Disbursement atomically:

1. Checks the source account belongs to the project and has sufficient balance.
2. Debits that bank/cash account by the authoritative net payable.
3. Creates one outgoing account transaction referencing `payroll_salary` or `payroll_bill` and one Paid expense for cash reporting.
4. Marks the salary run and exact included bill IDs Paid, saves their posting/account references and extends approval history.
5. Credits employee/company PF contribution entries once per run/employee and recovers any recorded outstanding salary advance.
6. Saves the idempotent result with ledger transaction IDs.

Company PF and withheld PF are recorded as internal member-fund balances; this does not execute an external bank transfer or separately fund a PF investment account. Paid expenses and account ledger entries are the cash reporting view. PF liability balances are preserved in contribution entries rather than being added to bank balances.

Approved unpaid bills reserve the earliest eligible unpaid salary run, including reimbursements carried from an earlier month. The same bill cannot enter two runs. Paying a standalone bill before preparation excludes it from salary. Salary-affecting leave, imports, eligibility changes, settings and bill approvals recalculate affected unpaid rows and reset their check/approval state when the calculation changes. Paid rows/settings/postings remain immutable. Unpaid leave affecting an already paid month requires an explicit adjustment and is rejected rather than rewriting history; an adjustment UI/API is not included here.

The server returns the current Asia/Dhaka date. Annual/Sick/Casual allowances are 20/14/10 working days and Friday is the holiday. Pending requests reserve leave. More than two sick days needs a doctor's note. Approved unpaid days are attributed to their own month at gross / 30, rounded to whole taka. Tax retains the design's labelled simplified estimate and is not a statutory tax engine.

Bill limits are warnings for review: Conveyance 3,000; Medical 5,000; Mobile 500; Food 1,000; Travel/Other unlimited. They do not silently truncate a submitted claim. Settings for annual PF profit, loans and withdrawals are persisted and previewed; automatic annual profit posting, issuing/recovering PF loans, and withdrawal processing are not part of this set of screens/endpoints. Actual PF profit/loan balances are not invented from those settings.

## Verification and deployment

Run `npm run build` and `node --test tests/payroll.policy.test.mjs`. To run the authenticated PostgreSQL integration test, provide `PAYROLL_TEST_DATABASE_URL` pointing only to a disposable database named `payroll_test` on localhost, then run `node --test tests/payroll.integration.test.mjs`. The suite covers project-type creation, scoped records/files, import validation/upsert, leave validation, role separation, stale approval invalidation, separate bill payment, duplicate/concurrent salary requests, competing account debits and rollback after a forced ledger failure.

Deploy the database migration with the repository's normal Prisma migration process, regenerate Prisma Client, build and restart the API, then ship the matching mobile client. This change does not apply migrations to a live database or deploy either app.
