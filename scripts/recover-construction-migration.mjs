import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// One-off recovery for the duplicate-FK failure in the first construction release.
// Read-only by default. --apply clears the failed migration record only after
// verifying PostgreSQL rolled back every construction schema change.
const migration = '20261014110000_construction_financial_management';
const root = fileURLToPath(new URL('../', import.meta.url));
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/recover-construction-migration.mjs [--apply]');
const prisma = new PrismaClient();
try {
  const needsRecovery = await prisma.$transaction(async tx => {
    const locks = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(72707369) AS locked`;
    if (!locks[0].locked) throw new Error('Another migration is running; try again after it finishes.');
    const rows = await tx.$queryRaw`SELECT migration_name, finished_at, rolled_back_at, logs FROM "_prisma_migrations" ORDER BY started_at`;
    const failed = rows.filter(row => !row.finished_at && !row.rolled_back_at);
    if (!failed.length && rows.some(row => row.migration_name === migration && (row.finished_at || row.rolled_back_at))) return false;
    if (failed.length !== 1 || failed[0].migration_name !== migration || !failed[0].logs?.includes('construction_cost_heads_project_id_fkey') || !failed[0].logs?.includes('already exists')) throw new Error('This is not the expected duplicate construction foreign-key failure. No changes made.');
    const tables = await tx.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND left(tablename, 13) = 'construction_'`;
    const columns = await tx.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'construction_settings'`;
    const labels = await tx.$queryRaw`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = current_schema() AND t.typname = 'ProjectType' AND e.enumlabel = 'construction'`;
    if (tables.length || columns.length || labels.length) throw new Error('Construction schema changes exist. Refusing to mark this migration rolled back; inspect and reconcile the partial migration first. No changes made.');
    console.log('Verified the expected failed migration and absence of construction tables, settings column and enum value.');
    return true;
  });
  if (!needsRecovery) {
    console.log('Construction migration is already resolved; no changes needed.');
  } else if (!apply) {
    console.log('Read-only check complete. Run again with --apply to mark the failed migration rolled back, then deploy the corrected release.');
  } else {
    // Use Prisma to reconcile migration history, without changing business data.
    const resolved = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)), 'migrate', 'resolve', '--rolled-back', migration], { cwd: root, env: process.env, stdio: 'inherit' });
    if (resolved.error || resolved.status !== 0) throw new Error('Prisma resolve did not finish. Inspect its output before retrying.');
    console.log('Recovery complete. Deploy the corrected release to apply the construction migration. No tables or business records were changed.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
