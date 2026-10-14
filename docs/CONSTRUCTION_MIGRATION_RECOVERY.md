# Recovery for the initial construction migration

The construction migration in commit `2465c6b` repeated 32 foreign-key definitions. PostgreSQL rejected the second `construction_cost_heads_project_id_fkey` with error 42710; Prisma recorded P3018. Subsequent deployments stop with P3009 and Coolify rolls back to the previous API, so billing endpoints remain unavailable even though the service displays Running.

The corrected migration removes only the duplicate block. A clean PostgreSQL 16 installation now applies all 26 migrations. Reproducing the original failure with Prisma 5.22 and PostgreSQL 16 showed that PostgreSQL rolled back the construction schema changes while retaining the failed Prisma migration record. Check the real database before assuming it is in the same state.

From the corrected backend checkout with the production `DATABASE_URL` supplied through the deployment environment, run:

```sh
npm run construction:migration:recover
```

This is read-only. It requires exactly the known failed migration and verifies there are no construction tables, `projects.construction_settings` column, or `construction` project enum value. If changes exist, it refuses recovery; inspect and reconcile that database separately.

After the check passes:

```sh
npm run construction:migration:recover -- --apply
```

This uses `prisma migrate resolve --rolled-back 20261014110000_construction_financial_management`. It changes migration history only; it does not drop tables or alter business records. It does not run the faulty migration again.

Commit and push the corrected migration, then redeploy the corrected backend release. The usual startup command, `npx prisma migrate deploy && node dist/server.js`, will apply it and start the API. Confirm a successful deployment and an authenticated `GET /v1/billing/plans` response of HTTP 200 using the billing project's `X-Project-Id` header.

Do not mark the failed migration applied when its tables are absent. Do not reset the production database. Retrying the original image without the corrected SQL will reproduce P3018.

This follows Prisma's [failed migration recovery workflow](https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing#failed-migration).
