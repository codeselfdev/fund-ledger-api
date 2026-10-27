-- Check-in/out requests from employees whose GPS was outside the office; HR approves them into attendance.
CREATE TABLE "payroll_attendance_requests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "employee_id" TEXT NOT NULL REFERENCES "payroll_employees"("id") ON DELETE RESTRICT,
  "date" DATE NOT NULL,
  "action" TEXT NOT NULL CHECK ("action" IN ('in', 'out')),
  "requested_at" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "distance_m" INTEGER CHECK ("distance_m" >= 0),
  "accuracy_m" INTEGER CHECK ("accuracy_m" >= 0),
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'approved', 'rejected')),
  "decision_note" TEXT,
  "created_by_id" TEXT NOT NULL,
  "decided_by_id" TEXT,
  "decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "payroll_attendance_requests_tenant_id_project_id_status_idx" ON "payroll_attendance_requests"("tenant_id", "project_id", "status");
CREATE INDEX "payroll_attendance_requests_project_id_employee_id_date_idx" ON "payroll_attendance_requests"("project_id", "employee_id", "date");
-- One open request per employee, day and action.
CREATE UNIQUE INDEX "payroll_attendance_requests_one_pending" ON "payroll_attendance_requests"("project_id", "employee_id", "date", "action") WHERE "status" = 'pending';
