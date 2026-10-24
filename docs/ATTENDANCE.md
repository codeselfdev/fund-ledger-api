# Payroll & PF attendance

Attendance is available only in the Payroll & PF project type, through the shared Shortcuts / All tools catalogue and workspace navigation. Saved personal pins are preserved. Employee accounts receive only their own attendance and payroll data; managers, accountants, approvers, cashiers and auditors can read the team sheet. Owners/admins and accountants can record or correct attendance with a required reason and a matching record revision. Only owners/admins can configure attendance.

## Setup

1. Deploy the matching API and apply `20261024190000_payroll_attendance` with the normal release migration workflow. No production migration is performed by this implementation.
2. Build an updated native app with `expo-location`; existing installed binaries need rebuilding to contain the location module. Web and Android bundle exports verify bundling, rather than physical GPS behaviour.
3. In Attendance → Attendance settings, the owner sets the office name, latitude/longitude (or uses a fresh foreground location), radius, shift times and company holidays. Office coordinates are deliberately empty initially; check-in remains disabled until configured.

Office GPS is mandatory at both check-in and check-out, as confirmed by the user. Default shift: 09:00–18:00, late after 09:15, Asia/Dhaka. Friday follows the existing project leave policy as the weekly day off. Shifts must end on the same day. Overnight shifts are outside this version.

## Behaviour and payroll

Phone punches use server timestamps and the employee linked to the authenticated account. The API rejects additional employee/time fields, stale or inaccurate location fixes, reported mock locations, and fixes outside the configured office radius. Location must be at most two minutes old, with accuracy no worse than the smaller of 100 m and the office radius. This is location validation from the device-reported fix; it is not device attestation. Employee coordinates are not stored in attendance or audit history. No background location is requested.

One record per employee per project per day is enforced in the database. Punches and corrections use durable actor/payload-bound idempotency receipts. Repeated or concurrent attempts cannot create multiple check-ins. A correction retains original punch times, records the reason and actor, and requires the exact revision seen when the form opened.

Employee view: check-in/out, monthly calendar, present/late/absent/leave counts, daily history and actual worked duration. HR view: today's team and totals, a horizontal monthly sheet, holiday/leave legends, correction history and settings. Foreground workspaces refresh every minute and on return to the app; requests from a previous project, role, month or session are discarded.

Missing punches stay pending; no automatic absence is inferred. Recorded absence = one unpaid day; recorded half day = 0.5. Late arrivals do not automatically deduct salary. The deduction is gross ÷ 30 for the combined unpaid units, rounded once in whole taka. Approved leave overrides attendance and unpaid leave on the same date is charged once. Fridays, configured holidays, dates before joining and other months do not add attendance deductions. Holiday changes can also exempt unpaid leave dates. Attendance changes rebuild affected unpaid salary rows and clear checks/approvals when totals change. Paid salary months are locked; historical corrections or holiday edits affecting them require an explicit later adjustment.

The monthly percentage uses present time (half day = 0.5) divided by working days to date, excluding leave, days off and pre-joining dates. Pending days affect this percentage but never create salary deductions.

## Verification

- `npm run typecheck`
- `node --test tests/attendance.test.cjs tests/payroll.test.cjs tests/shortcuts.test.cjs`
- `npx expo export --platform web` and `npx expo export --platform android`
- API build and attendance policy / authenticated integration tests, plus existing payroll disbursement and shortcut tests. Integration tests require an explicitly named disposable local `payroll_test` PostgreSQL database via `PAYROLL_TEST_DATABASE_URL`.

Visual review uses synthetic employee data in the web export at phone width; no real employee location or financial record is changed during review. A physical device GPS and permission check remains part of native release QA.
