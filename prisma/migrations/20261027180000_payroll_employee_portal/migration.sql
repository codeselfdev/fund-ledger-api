CREATE TABLE "payroll_portal_records" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "employee_id" TEXT REFERENCES "payroll_employees"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('profile','department','designation','office_project','task','work_split','document','location')),
  "record_key" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("project_id", "kind", "record_key")
);
CREATE INDEX "payroll_portal_scope_idx" ON "payroll_portal_records"("tenant_id", "project_id", "kind", "employee_id");
