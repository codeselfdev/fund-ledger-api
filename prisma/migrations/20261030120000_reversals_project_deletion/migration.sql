ALTER TABLE sessions ADD COLUMN authenticated_at TIMESTAMP(3);
ALTER TYPE "DepositStatus" ADD VALUE IF NOT EXISTS 'reversed';
ALTER TYPE "ExpenseStatus" ADD VALUE IF NOT EXISTS 'reversed';
ALTER TABLE projects ADD COLUMN deletion_started_at TIMESTAMP(3);
ALTER TABLE account_transactions ADD COLUMN reversed_at TIMESTAMP(3), ADD COLUMN reversal_of_id TEXT;
CREATE UNIQUE INDEX account_transactions_reversal_of_id_key ON account_transactions(reversal_of_id);
ALTER TABLE deposit_allocations ADD COLUMN principal_amount INTEGER, ADD COLUMN penalty_amount INTEGER;
ALTER TABLE receipts ADD COLUMN voided_at TIMESTAMP(3), ADD COLUMN void_reason TEXT;
CREATE TABLE project_deletion_jobs (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL, manifest JSONB NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
 objects_deleted INTEGER NOT NULL DEFAULT 0, lease_until TIMESTAMP(3), error TEXT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP(3)
);
CREATE INDEX project_deletion_jobs_status_lease_until_idx ON project_deletion_jobs(status,lease_until);
CREATE TABLE transaction_reversals (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
 request_key TEXT NOT NULL, reason TEXT NOT NULL, user_id TEXT NOT NULL, result JSONB NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project_id,kind,record_id), UNIQUE(project_id,request_key)
);
-- Database barrier covers requests, imports, workers and old application instances.
-- Shared transaction locks serialize writes against deletion's exclusive project lock.
CREATE FUNCTION guard_deleting_project() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE locked_project TEXT; project_key TEXT; project_keys TEXT[];
BEGIN
 project_keys := ARRAY[NEW.project_id];
 IF TG_OP='UPDATE' THEN project_keys := array_append(project_keys,OLD.project_id); END IF;
 FOR project_key IN SELECT DISTINCT unnest(project_keys) ORDER BY 1 LOOP
  IF project_key IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended(project_key,0));
   SELECT id INTO locked_project FROM projects WHERE id=project_key AND deletion_started_at IS NOT NULL;
   IF locked_project IS NOT NULL THEN RAISE EXCEPTION 'Project is locked for deletion' USING ERRCODE='55000'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
DO $$
DECLARE t RECORD;
BEGIN
 FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='project_id' AND table_name<>'project_deletion_jobs'
 LOOP
  EXECUTE format('CREATE TRIGGER project_deletion_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_deleting_project()',t.table_name);
 END LOOP;
END $$;
CREATE FUNCTION guard_deleting_project_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(OLD.id,0));
 IF OLD.deletion_started_at IS NOT NULL THEN RAISE EXCEPTION 'Project is locked for deletion' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_deletion_row_guard BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION guard_deleting_project_row();

ALTER TABLE fixed_assets DROP CONSTRAINT fixed_assets_status_check;
ALTER TABLE fixed_assets ADD CONSTRAINT fixed_assets_status_check CHECK ((status IN ('active','reversed') AND disposed_at IS NULL) OR (status='disposed' AND disposed_at IS NOT NULL));

-- Keep the serial in history while allowing a corrected replacement purchase.
DROP INDEX fixed_assets_tenant_serial_key;
CREATE UNIQUE INDEX fixed_assets_tenant_serial_key ON fixed_assets(tenant_id,serial) WHERE serial <> '' AND status <> 'reversed';
