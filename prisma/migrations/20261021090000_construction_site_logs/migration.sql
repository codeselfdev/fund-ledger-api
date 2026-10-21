ALTER TABLE "construction_material_entries" ADD COLUMN "unit_rate" INTEGER, ADD COLUMN "charge_contract_id" TEXT;
CREATE TABLE "construction_site_logs" (
 "id" TEXT NOT NULL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "project_id" TEXT NOT NULL,
 "work_date" DATE NOT NULL, "content" JSONB NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
 "status" TEXT NOT NULL DEFAULT 'draft', "labor_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "material_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 "created_by_id" TEXT NOT NULL, "decided_by_id" TEXT, "submitted_at" TIMESTAMP(3), "decided_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "construction_site_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "construction_site_logs_project_id_work_date_key" ON "construction_site_logs"("project_id", "work_date");
CREATE INDEX "construction_site_logs_tenant_id_project_id_status_idx" ON "construction_site_logs"("tenant_id", "project_id", "status");
CREATE TABLE "construction_waste_limits" (
 "id" TEXT NOT NULL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "project_id" TEXT NOT NULL, "item_id" TEXT NOT NULL,
 "allowance_bps" INTEGER NOT NULL CHECK ("allowance_bps" BETWEEN 0 AND 10000),
 CONSTRAINT "construction_waste_limits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "construction_waste_limits_project_id_item_id_key" ON "construction_waste_limits"("project_id", "item_id");
CREATE INDEX "construction_waste_limits_tenant_id_project_id_idx" ON "construction_waste_limits"("tenant_id", "project_id");
ALTER TABLE "construction_material_entries" ADD COLUMN "charge_bill_id" TEXT;
ALTER TABLE "construction_running_bills" ADD COLUMN "wastage_deduction" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "waste_entry_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "construction_running_bills" DROP CONSTRAINT "construction_running_bill_values";
ALTER TABLE "construction_running_bills" ADD CONSTRAINT "construction_running_bill_values" CHECK (
 current_certified > 0 AND cumulative_certified::bigint = previous_certified::bigint + current_certified AND previous_certified >= 0
 AND retention >= 0 AND advance_recovery >= 0 AND wastage_deduction >= 0
 AND net_payable::bigint = current_certified::bigint - retention - advance_recovery - wastage_deduction
 AND paid_amount BETWEEN 0 AND net_payable AND status IN ('pending','approved','rejected')
);
ALTER TABLE "construction_site_logs" ADD CONSTRAINT "construction_site_log_values" CHECK (version > 0 AND status IN ('draft','pending','approved','rejected'));
ALTER TABLE "construction_material_entries" ADD CONSTRAINT "construction_waste_charge_values" CHECK ((charge_contract_id IS NULL OR kind = 'waste') AND (charge_bill_id IS NULL OR charge_contract_id IS NOT NULL) AND (unit_rate IS NULL OR unit_rate >= 0));
