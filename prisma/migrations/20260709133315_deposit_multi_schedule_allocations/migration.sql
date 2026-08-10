-- AlterTable
ALTER TABLE "deposits" ALTER COLUMN "schedule_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "deposit_allocations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "deposit_id" TEXT NOT NULL,
    "due_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deposit_allocations_tenant_id_project_id_due_id_idx" ON "deposit_allocations"("tenant_id", "project_id", "due_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_allocations_deposit_id_due_id_key" ON "deposit_allocations"("deposit_id", "due_id");

-- AddForeignKey
ALTER TABLE "deposit_allocations" ADD CONSTRAINT "deposit_allocations_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_allocations" ADD CONSTRAINT "deposit_allocations_due_id_fkey" FOREIGN KEY ("due_id") REFERENCES "dues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_allocations" ADD CONSTRAINT "deposit_allocations_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
