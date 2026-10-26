# Institute API

The module is `src/modules/institute`. All 22 new database tables use `institute_`. The only existing schema additions are the `teacher` Role, the `institute` ProjectType and `projects.institute_settings`; inverse Prisma relations do not change existing tables. Migration: `prisma/migrations/20261026120000_institute_core/migration.sql`.

`INSTITUTE_ENABLED` defaults off. The flag controls institute creation, routes, signed file access and the delivery worker. Do not enable it until the additive migration is deployed and real PostgreSQL tests pass. This task generated the migration but did not execute it.

Requests use the normal bearer session and `X-Project-Id`. `?portal=office|accounts|teacher|guardian|student|auditor` narrows a multi-role session. Every institute write requires an `Idempotency-Key` UUID. Editable sheets/payments require the current revision. The server uses serializable transactions and binds stored responses to the user, path, portal and payload hash.

Student and guardian sign-ins retain the member role and are linked through institute records. They do not create Fund/Share member records. Teachers are assigned to groups and optionally subjects. Class-teacher assignments decide leave; subject assignments enter marks. Custom menu permissions only narrow those scopes. Receipt and report-card documents are excluded from teacher queries and signed views.

Verification allocates whole taka to the oldest open invoices, creates an institute receipt and shared account transaction atomically, and holds excess as advance. Repeated verification returns the existing receipt. A default receiving account must exist. The institute receipt table is separate because the original Fund receipt requires a shareholder deposit; both use the shared PDF renderer and account ledger.

Published results are immutable JSON snapshots. Corrections require a reason, create another version and notify only changed students. Training results suppress positions. Uploaded attachments stay private, post attachments retain the fixed recipient audience, and signed view URLs expire in two minutes and recheck session, project and relationship scope.

Inbox notifications and durable push/SMS jobs are created in the domain transaction. Quiet hours defer external deliveries from 21:00 to 07:00 in the project timezone. FCM is reused. For fee-reminder SMS, configure `INSTITUTE_SMS_WEBHOOK_URL` and optional `INSTITUTE_SMS_WEBHOOK_TOKEN`. The adapter receives `{to,message,idempotency_key}`, must dedupe that key, and return a successful status. Missing configuration is recorded as a delivery failure and retried. No external messages were sent during tests.

Validation:

```sh
npm run prisma:generate
npm run build
node --test tests/institute*.test.cjs
INSTITUTE_TEST_DATABASE_URL=postgresql://localhost/institute_test node --test tests/institute.integration.test.mjs
```

The integration test refuses any database not named exactly `institute_test`. Apply migrations to that disposable database first. It tests concurrent verification, conflicting attendance revisions, idempotency replay and rollback after a failure following receipt creation. It does not run without the explicit URL. No live PostgreSQL service or running Docker daemon was available during implementation, so these database tests remain unexecuted.
