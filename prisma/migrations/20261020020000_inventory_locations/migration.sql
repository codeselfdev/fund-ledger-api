ALTER TABLE "projects" ADD COLUMN "stock_management_enabled" BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE "inventory_locations" (
 "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "project_id" TEXT NOT NULL, "name" TEXT NOT NULL, "address" TEXT,
 "is_default" BOOLEAN NOT NULL DEFAULT false, "is_active" BOOLEAN NOT NULL DEFAULT true,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_locations_project_id_name_key" ON "inventory_locations"("project_id", "name");
CREATE INDEX "inventory_locations_tenant_id_project_id_is_active_idx" ON "inventory_locations"("tenant_id", "project_id", "is_active");
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD COLUMN "location_id" TEXT;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "stock_movements_project_id_item_id_location_id_idx" ON "stock_movements"("project_id", "item_id", "location_id");
ALTER TABLE "business_documents" ADD COLUMN "stock_location_id" TEXT, ADD COLUMN "stock_tracked" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "business_documents" ALTER COLUMN "stock_tracked" SET DEFAULT false;
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_stock_location_id_fkey" FOREIGN KEY ("stock_location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchases" ADD COLUMN "stock_location_id" TEXT, ADD COLUMN "stock_tracked" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "purchases" ALTER COLUMN "stock_tracked" SET DEFAULT false;
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_stock_location_id_fkey" FOREIGN KEY ("stock_location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales" ADD COLUMN "stock_location_id" TEXT, ADD COLUMN "stock_tracked" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "sales" ALTER COLUMN "stock_tracked" SET DEFAULT false;
ALTER TABLE "sales" ADD CONSTRAINT "sales_stock_location_id_fkey" FOREIGN KEY ("stock_location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
