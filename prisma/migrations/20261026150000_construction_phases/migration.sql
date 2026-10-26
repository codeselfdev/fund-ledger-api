CREATE TABLE "construction_phases" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "planned_start" DATE,
  "planned_end" DATE,
  "actual_start" DATE,
  "actual_end" DATE,
  "responsible_user_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "request_key" TEXT,
  "request_hash" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "construction_phases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "construction_phases_responsible_user_id_fkey" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "construction_phases_dates_check" CHECK (
    ("planned_end" IS NULL OR ("planned_start" IS NOT NULL AND "planned_end" >= "planned_start")) AND
    ("actual_end" IS NULL OR ("actual_start" IS NOT NULL AND "actual_end" >= "actual_start")) AND
    ("status" = 'draft' OR ("planned_start" IS NOT NULL AND "planned_end" IS NOT NULL)) AND
    ("status" NOT IN ('active', 'on_hold', 'completed') OR "actual_start" IS NOT NULL) AND
    (("status" = 'completed') = ("actual_end" IS NOT NULL)) AND
    "status" IN ('draft', 'planned', 'active', 'on_hold', 'completed') AND "revision" > 0
  )
);
CREATE UNIQUE INDEX "construction_phases_project_id_name_key" ON "construction_phases"("project_id", "name");
CREATE UNIQUE INDEX "construction_phases_project_id_request_key_key" ON "construction_phases"("project_id", "request_key");
CREATE INDEX "construction_phases_tenant_id_project_id_status_idx" ON "construction_phases"("tenant_id", "project_id", "status");
ALTER TABLE "construction_cost_heads" ADD COLUMN "phase_id" TEXT;
-- Reuse every existing phase name without inventing dates, assignments or progress.
INSERT INTO "construction_phases" ("id", "tenant_id", "project_id", "name", "created_by_id", "created_at", "updated_at")
SELECT 'cp_' || md5("project_id" || ':' || "phase"), "tenant_id", "project_id", "phase", min("created_by_id"), min("created_at"), CURRENT_TIMESTAMP
FROM "construction_cost_heads" GROUP BY "tenant_id", "project_id", "phase";
UPDATE "construction_cost_heads" h SET "phase_id" = p."id" FROM "construction_phases" p
WHERE h."project_id" = p."project_id" AND h."tenant_id" = p."tenant_id" AND h."phase" = p."name";
ALTER TABLE "construction_cost_heads" ADD CONSTRAINT "construction_cost_heads_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "construction_phases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
