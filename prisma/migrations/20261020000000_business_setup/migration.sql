-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "tax_snapshot" JSONB;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "tax_snapshot" JSONB;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "business_documents" ADD COLUMN     "tax_snapshot" JSONB;

-- AlterTable
ALTER TABLE "billing_invoices" ADD COLUMN     "tax_snapshot" JSONB;

-- CreateTable
CREATE TABLE "business_configurations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "builtin_search" JSONB NOT NULL DEFAULT '{}',
    "tax_setup" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_fields" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "match" TEXT NOT NULL DEFAULT 'contains',
    "filterable" BOOLEAN NOT NULL DEFAULT false,
    "show_in_list" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_imports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "result" JSONB,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_tax_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "rate_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "base" INTEGER NOT NULL,
    "rate_bps" INTEGER NOT NULL,
    "reversal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_tax_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_configurations_project_id_key" ON "business_configurations"("project_id");

-- CreateIndex
CREATE INDEX "business_configurations_tenant_id_project_id_idx" ON "business_configurations"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "business_fields_tenant_id_project_id_entity_archived_idx" ON "business_fields"("tenant_id", "project_id", "entity", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "business_fields_project_id_entity_key_key" ON "business_fields"("project_id", "entity", "key");

-- CreateIndex
CREATE INDEX "business_imports_tenant_id_project_id_created_by_id_status_idx" ON "business_imports"("tenant_id", "project_id", "created_by_id", "status");

-- CreateIndex
CREATE INDEX "business_imports_expires_at_status_idx" ON "business_imports"("expires_at", "status");

-- CreateIndex
CREATE INDEX "business_tax_entries_tenant_id_project_id_kind_created_at_idx" ON "business_tax_entries"("tenant_id", "project_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "business_tax_entries_project_id_source_type_source_id_rate__key" ON "business_tax_entries"("project_id", "source_type", "source_id", "rate_id", "reversal");

-- AddForeignKey
ALTER TABLE "business_configurations" ADD CONSTRAINT "business_configurations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_fields" ADD CONSTRAINT "business_fields_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_imports" ADD CONSTRAINT "business_imports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_tax_entries" ADD CONSTRAINT "business_tax_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Stable typed metadata, never per-business DDL.
ALTER TABLE business_fields ADD CONSTRAINT business_fields_entity_check CHECK (entity IN ('customer','dealer','item'));
ALTER TABLE business_fields ADD CONSTRAINT business_fields_type_check CHECK (type IN ('text','long_text','number','money','date','boolean','select','multi_select','phone','email'));
ALTER TABLE business_fields ADD CONSTRAINT business_fields_options_check CHECK (jsonb_typeof(options) = 'array');
ALTER TABLE customers ADD CONSTRAINT customers_attributes_object CHECK (jsonb_typeof(attributes) = 'object');
ALTER TABLE vendors ADD CONSTRAINT vendors_attributes_object CHECK (jsonb_typeof(attributes) = 'object');
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_attributes_object CHECK (jsonb_typeof(attributes) = 'object');
CREATE INDEX customers_attributes_gin ON customers USING GIN (attributes);
CREATE INDEX vendors_attributes_gin ON vendors USING GIN (attributes);
CREATE INDEX inventory_items_attributes_gin ON inventory_items USING GIN (attributes);
