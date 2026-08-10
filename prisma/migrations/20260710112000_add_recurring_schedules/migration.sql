-- CreateEnum
CREATE TYPE "RecurringFrequency" AS ENUM ('weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'yearly');

-- AlterTable
ALTER TABLE "schedules"
ADD COLUMN "recurring_schedule_id" TEXT,
ADD COLUMN "unit_amount" INTEGER;

-- CreateTable
CREATE TABLE "recurring_schedules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit_amount" INTEGER NOT NULL,
    "frequency" "RecurringFrequency" NOT NULL,
    "starts_on" TIMESTAMP(3) NOT NULL,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "penalty_policy" JSONB,
    "created_by_id" TEXT NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_run_status" TEXT,
    "last_run_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedules_tenant_id_project_id_recurring_schedule_id_idx" ON "schedules"("tenant_id", "project_id", "recurring_schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_recurring_schedule_id_due_date_key" ON "schedules"("recurring_schedule_id", "due_date");

-- CreateIndex
CREATE INDEX "recurring_schedules_tenant_id_project_id_is_active_idx" ON "recurring_schedules"("tenant_id", "project_id", "is_active");

-- CreateIndex
CREATE INDEX "recurring_schedules_tenant_id_project_id_next_run_at_idx" ON "recurring_schedules"("tenant_id", "project_id", "next_run_at");

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_recurring_schedule_id_fkey" FOREIGN KEY ("recurring_schedule_id") REFERENCES "recurring_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
