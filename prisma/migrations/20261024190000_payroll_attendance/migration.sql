CREATE TABLE "payroll_attendance_configurations" (
  "project_id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "settings" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "payroll_attendance_configurations_tenant_id_project_id_idx" ON "payroll_attendance_configurations"("tenant_id", "project_id");
CREATE TABLE "payroll_attendances" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "employee_id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('present', 'late', 'half_day', 'absent')),
  "check_in" TIMESTAMP(3),
  "check_out" TIMESTAMP(3),
  "source" TEXT NOT NULL DEFAULT 'manual' CHECK ("source" IN ('manual', 'phone')),
  "office_verified" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "history" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CHECK ("check_out" IS NULL OR ("check_in" IS NOT NULL AND "check_out" >= "check_in")),
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("employee_id") REFERENCES "payroll_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "payroll_attendances_project_id_employee_id_date_key" ON "payroll_attendances"("project_id", "employee_id", "date");
CREATE INDEX "payroll_attendances_tenant_id_project_id_date_idx" ON "payroll_attendances"("tenant_id", "project_id", "date");
