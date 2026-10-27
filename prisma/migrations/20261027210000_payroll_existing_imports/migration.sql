-- Existing-payroll imports: opening PF balances have no salary run; imported entries are labelled by source.
ALTER TABLE "payroll_pf_entries" ALTER COLUMN "run_id" DROP NOT NULL;
ALTER TABLE "payroll_pf_entries" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'run';
ALTER TABLE "payroll_pf_entries" ADD CONSTRAINT "payroll_pf_entries_source_check" CHECK ("source" IN ('run', 'opening', 'history'));
ALTER TABLE "payroll_pf_entries" ADD CONSTRAINT "payroll_pf_entries_run_source_check" CHECK (("source" = 'opening') = ("run_id" IS NULL));
