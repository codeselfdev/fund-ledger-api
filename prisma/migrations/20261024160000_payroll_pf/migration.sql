-- AlterEnum
ALTER TYPE "ProjectType" ADD VALUE 'payroll_pf';

-- CreateTable
CREATE TABLE "payroll_configurations" (
    "project_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_configurations_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "payroll_employees" (
    "user_id" TEXT,
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "joining_date" DATE NOT NULL,
    "basic" INTEGER NOT NULL,
    "medical" INTEGER NOT NULL DEFAULT 0,
    "transport" INTEGER NOT NULL DEFAULT 0,
    "pf_member" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'probation',
    "probation_completed_on" DATE,
    "advance" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "rows" JSONB NOT NULL,
    "settings_snapshot" JSONB NOT NULL,
    "history" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "checked_by_id" TEXT,
    "approved_by_id" TEXT,
    "posting" JSONB,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_leaves" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "working_dates" TEXT[],
    "days" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note_file_id" TEXT,
    "rejection_reason" TEXT,
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "payroll_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_bills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "receipt_file_id" TEXT NOT NULL,
    "receipt_name" TEXT NOT NULL,
    "receipt_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "checked_by_id" TEXT,
    "approved_by_id" TEXT,
    "rejection_reason" TEXT,
    "reserved_run_id" TEXT,
    "posting" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_pf_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "employee_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "own" INTEGER NOT NULL,
    "company" INTEGER NOT NULL,
    "profit" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_pf_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_operations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_operations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_configurations_tenant_id_project_id_idx" ON "payroll_configurations"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "payroll_employees_tenant_id_project_id_idx" ON "payroll_employees"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_employees_project_id_mobile_key" ON "payroll_employees"("project_id", "mobile");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_employees_project_id_user_id_key" ON "payroll_employees"("project_id", "user_id");

-- CreateIndex
CREATE INDEX "payroll_runs_tenant_id_project_id_status_idx" ON "payroll_runs"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_project_id_month_key" ON "payroll_runs"("project_id", "month");

-- CreateIndex
CREATE INDEX "payroll_leaves_tenant_id_project_id_employee_id_status_idx" ON "payroll_leaves"("tenant_id", "project_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "payroll_bills_tenant_id_project_id_employee_id_status_idx" ON "payroll_bills"("tenant_id", "project_id", "employee_id", "status");

-- CreateIndex
CREATE INDEX "payroll_bills_tenant_id_project_id_reserved_run_id_idx" ON "payroll_bills"("tenant_id", "project_id", "reserved_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_bills_project_id_receipt_file_id_key" ON "payroll_bills"("project_id", "receipt_file_id");

-- CreateIndex
CREATE INDEX "payroll_pf_entries_tenant_id_project_id_employee_id_idx" ON "payroll_pf_entries"("tenant_id", "project_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_pf_entries_run_id_employee_id_key" ON "payroll_pf_entries"("run_id", "employee_id");

-- CreateIndex
CREATE INDEX "payroll_operations_tenant_id_project_id_idx" ON "payroll_operations"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_operations_project_id_request_key_key" ON "payroll_operations"("project_id", "request_key");

-- AddForeignKey
ALTER TABLE "payroll_configurations" ADD CONSTRAINT "payroll_configurations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_employees" ADD CONSTRAINT "payroll_employees_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_leaves" ADD CONSTRAINT "payroll_leaves_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_leaves" ADD CONSTRAINT "payroll_leaves_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "payroll_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_bills" ADD CONSTRAINT "payroll_bills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_bills" ADD CONSTRAINT "payroll_bills_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "payroll_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_pf_entries" ADD CONSTRAINT "payroll_pf_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_pf_entries" ADD CONSTRAINT "payroll_pf_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "payroll_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_pf_entries" ADD CONSTRAINT "payroll_pf_entries_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_operations" ADD CONSTRAINT "payroll_operations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
