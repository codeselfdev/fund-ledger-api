-- CreateTable
CREATE TABLE "fixed_assets" (
    "depreciation_source_id" TEXT,
    "depreciation_source_through" TEXT,
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cost" INTEGER NOT NULL,
    "residual" INTEGER NOT NULL,
    "life_months" INTEGER NOT NULL,
    "purchase_date" TIMESTAMP(3) NOT NULL,
    "in_use_date" TIMESTAMP(3) NOT NULL,
    "supplier" TEXT NOT NULL,
    "invoice" TEXT NOT NULL,
    "invoice_upload_id" TEXT,
    "account_id" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "assigned_to" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "warranty_until" TIMESTAMP(3),
    "next_service_date" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "disposed_at" TIMESTAMP(3),
    "disposal" JSONB,
    "posted_through" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixed_asset_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "detail" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixed_asset_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fixed_asset_journals" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixed_asset_journals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fixed_assets_code_key" ON "fixed_assets"("code");

-- CreateIndex
CREATE INDEX "fixed_assets_tenant_id_project_id_status_idx" ON "fixed_assets"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_asset_operations_project_id_request_key_key" ON "fixed_asset_operations"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "fixed_asset_events_tenant_id_project_id_asset_id_idx" ON "fixed_asset_events"("tenant_id", "project_id", "asset_id");

-- CreateIndex
CREATE INDEX "fixed_asset_journals_tenant_id_project_id_period_idx" ON "fixed_asset_journals"("tenant_id", "project_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "fixed_asset_journals_asset_id_kind_period_project_id_key" ON "fixed_asset_journals"("asset_id", "kind", "period", "project_id");

-- AddForeignKey
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_operations" ADD CONSTRAINT "fixed_asset_operations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_events" ADD CONSTRAINT "fixed_asset_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_events" ADD CONSTRAINT "fixed_asset_events_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fixed_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_journals" ADD CONSTRAINT "fixed_asset_journals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixed_asset_journals" ADD CONSTRAINT "fixed_asset_journals_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "fixed_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Empty serials are permitted, real serials are unique within an organization.
CREATE UNIQUE INDEX "fixed_assets_tenant_serial_key" ON "fixed_assets"("tenant_id", "serial") WHERE "serial" <> '';
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_values_check" CHECK ("cost" > 0 AND "residual" >= 0 AND "residual" < "cost" AND "life_months" BETWEEN 1 AND 600);
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_status_check" CHECK (("status" = 'active' AND "disposed_at" IS NULL) OR ("status" = 'disposed' AND "disposed_at" IS NOT NULL));
