-- Optional work structure; existing budgets, amounts and site log JSON remain unchanged.
CREATE TABLE "construction_work_locations" (
 "id" TEXT NOT NULL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "project_id" TEXT NOT NULL,
 "parent_id" TEXT, "parent_key" TEXT NOT NULL DEFAULT '', "kind" TEXT NOT NULL,
 CONSTRAINT "construction_work_locations_kind_check" CHECK ("kind" IN ('building','block','floor','zone')),
 CONSTRAINT "construction_work_locations_parent_check" CHECK ("parent_key" = coalesce("parent_id", '') AND "parent_id" IS DISTINCT FROM "id"),
 "name" TEXT NOT NULL, "is_active" BOOLEAN NOT NULL DEFAULT true, "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
 "request_key" TEXT NOT NULL, "request_hash" TEXT NOT NULL, "created_by_id" TEXT NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "construction_work_locations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "construction_work_locations_project_id_request_key_key" ON "construction_work_locations"("project_id","request_key");
CREATE INDEX "construction_work_locations_tenant_id_project_id_is_active_idx" ON "construction_work_locations"("tenant_id","project_id","is_active");
CREATE TABLE "construction_work_packages" (
 "id" TEXT NOT NULL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "project_id" TEXT NOT NULL,
 "phase_id" TEXT NOT NULL, "location_id" TEXT, "description" TEXT NOT NULL DEFAULT '',
 "name" TEXT NOT NULL, "is_active" BOOLEAN NOT NULL DEFAULT true, "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
 "request_key" TEXT NOT NULL, "request_hash" TEXT NOT NULL, "created_by_id" TEXT NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "construction_work_packages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "construction_work_packages_project_id_request_key_key" ON "construction_work_packages"("project_id","request_key");
CREATE INDEX "construction_work_packages_tenant_id_project_id_is_active_idx" ON "construction_work_packages"("tenant_id","project_id","is_active");
CREATE TABLE "construction_tasks" (
 "id" TEXT NOT NULL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "project_id" TEXT NOT NULL,
 "work_package_id" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT '',
 "name" TEXT NOT NULL, "is_active" BOOLEAN NOT NULL DEFAULT true, "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
 "request_key" TEXT NOT NULL, "request_hash" TEXT NOT NULL, "created_by_id" TEXT NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "construction_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "construction_tasks_project_id_request_key_key" ON "construction_tasks"("project_id","request_key");
CREATE INDEX "construction_tasks_tenant_id_project_id_is_active_idx" ON "construction_tasks"("tenant_id","project_id","is_active");
CREATE UNIQUE INDEX "construction_work_locations_scope_name_key" ON "construction_work_locations"("project_id","parent_key","kind","name");
CREATE UNIQUE INDEX "construction_work_packages_phase_id_name_key" ON "construction_work_packages"("phase_id","name");
CREATE UNIQUE INDEX "construction_tasks_work_package_id_name_key" ON "construction_tasks"("work_package_id","name");
ALTER TABLE "construction_work_locations" ADD CONSTRAINT "construction_work_locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "construction_work_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_work_packages" ADD CONSTRAINT "construction_work_packages_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "construction_phases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_work_packages" ADD CONSTRAINT "construction_work_packages_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "construction_work_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_tasks" ADD CONSTRAINT "construction_tasks_work_package_id_fkey" FOREIGN KEY ("work_package_id") REFERENCES "construction_work_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_cost_heads" ADD COLUMN "work_package_id" TEXT, ADD COLUMN "task_id" TEXT, ADD COLUMN "location_id" TEXT, ADD COLUMN "work_context_label" TEXT;
ALTER TABLE "construction_cost_heads" ADD CONSTRAINT "construction_cost_heads_work_package_id_fkey" FOREIGN KEY ("work_package_id") REFERENCES "construction_work_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_cost_heads" ADD CONSTRAINT "construction_cost_heads_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "construction_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_cost_heads" ADD CONSTRAINT "construction_cost_heads_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "construction_work_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "construction_cost_heads" ADD COLUMN "work_scope_key" TEXT NOT NULL DEFAULT '';
DROP INDEX "construction_cost_heads_project_id_name_phase_key";
CREATE UNIQUE INDEX "construction_cost_heads_project_id_name_phase_work_scope_key_key" ON "construction_cost_heads"("project_id","name","phase","work_scope_key");
