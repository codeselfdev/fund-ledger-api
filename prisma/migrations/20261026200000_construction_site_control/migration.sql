-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "construction_valuation_method" TEXT NOT NULL DEFAULT 'expense';

-- AlterTable
ALTER TABLE "construction_material_entries" ADD COLUMN     "cost_head_id" TEXT,
ADD COLUMN     "stock_location_id" TEXT,
ADD COLUMN     "valuation_value_micro" DECIMAL(30,0);

-- CreateTable
CREATE TABLE "construction_control_settings" (
    "valuation_activation" JSONB,
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "construction_control_settings_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "construction_control_versions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "base_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decision_note" TEXT,
    "decided_at" TIMESTAMP(3),
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_control_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_measurements" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'measurement',
    "boq_id" TEXT,
    "phase_id" TEXT,
    "task_id" TEXT,
    "base_id" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "measurement_date" DATE NOT NULL,
    "evidence" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "reverses_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decision_note" TEXT,
    "decided_at" TIMESTAMP(3),
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_measurements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_valuation_layers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "remaining_quantity" INTEGER NOT NULL,
    "value_micro" DECIMAL(30,0) NOT NULL,
    "sort_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_valuation_layers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_valuation_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "movement_id" TEXT,
    "item_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "cost_head_id" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "value_micro" DECIMAL(30,0) NOT NULL,
    "source_entry_id" TEXT,
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT,
    "allocations" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_valuation_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_reclassifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "cost_head_id" TEXT,
    "value_micro" DECIMAL(30,0) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_reclassifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "construction_control_settings_tenant_id_project_id_idx" ON "construction_control_settings"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "construction_control_versions_tenant_id_project_id_kind_sta_idx" ON "construction_control_versions"("tenant_id", "project_id", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "construction_control_versions_project_id_kind_revision_key" ON "construction_control_versions"("project_id", "kind", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "construction_control_versions_project_id_request_key_key" ON "construction_control_versions"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_measurements_tenant_id_project_id_status_idx" ON "construction_measurements"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "construction_measurements_project_id_request_key_key" ON "construction_measurements"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_valuation_layers_tenant_id_project_id_item_id__idx" ON "construction_valuation_layers"("tenant_id", "project_id", "item_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_valuation_entries_movement_id_key" ON "construction_valuation_entries"("movement_id");

-- CreateIndex
CREATE INDEX "construction_valuation_entries_tenant_id_project_id_item_id_idx" ON "construction_valuation_entries"("tenant_id", "project_id", "item_id", "location_id");

-- CreateIndex
CREATE INDEX "construction_valuation_entries_tenant_id_project_id_cost_he_idx" ON "construction_valuation_entries"("tenant_id", "project_id", "cost_head_id");

-- CreateIndex
CREATE INDEX "construction_reclassifications_tenant_id_project_id_cost_he_idx" ON "construction_reclassifications"("tenant_id", "project_id", "cost_head_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_reclassifications_project_id_source_type_sourc_key" ON "construction_reclassifications"("project_id", "source_type", "source_id");

-- AddForeignKey
ALTER TABLE "construction_control_settings" ADD CONSTRAINT "construction_control_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_control_versions" ADD CONSTRAINT "construction_control_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_measurements" ADD CONSTRAINT "construction_measurements_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_valuation_layers" ADD CONSTRAINT "construction_valuation_layers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_valuation_entries" ADD CONSTRAINT "construction_valuation_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_reclassifications" ADD CONSTRAINT "construction_reclassifications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Protect subledger invariants even when writes originate outside the HTTP API.
ALTER TABLE projects ADD CONSTRAINT construction_valuation_method_check CHECK (construction_valuation_method IN ('expense','weighted_average','fifo'));
ALTER TABLE construction_control_settings ADD CONSTRAINT construction_control_revision_check CHECK (revision > 0);
ALTER TABLE construction_control_versions ADD CONSTRAINT construction_control_version_check CHECK (kind IN ('schedule','boq') AND revision > 0 AND status IN ('pending','approved','rejected') AND (decided_by_id IS NULL OR decided_by_id <> created_by_id));
ALTER TABLE construction_measurements ADD CONSTRAINT construction_measurement_check CHECK (kind IN ('measurement','completion') AND status IN ('pending','approved','rejected') AND (decided_by_id IS NULL OR decided_by_id <> created_by_id) AND ((kind='measurement' AND boq_id IS NOT NULL AND quantity<>0) OR (kind='completion' AND quantity=0 AND ((phase_id IS NOT NULL AND task_id IS NULL) OR (phase_id IS NULL AND task_id IS NOT NULL)))));
ALTER TABLE construction_valuation_layers ADD CONSTRAINT construction_valuation_layer_check CHECK (remaining_quantity >= 0 AND value_micro >= 0 AND (remaining_quantity > 0 OR value_micro=0));
ALTER TABLE construction_valuation_entries ADD CONSTRAINT construction_valuation_entry_check CHECK (quantity<>0 AND ((quantity>0 AND value_micro>=0) OR (quantity<0 AND value_micro<=0)));
ALTER TABLE construction_reclassifications ADD CONSTRAINT construction_reclassification_check CHECK (value_micro >= 0);
