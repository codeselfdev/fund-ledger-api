CREATE TYPE "SchedulePurpose" AS ENUM ('contribution', 'previous_installment');

ALTER TABLE "schedules"
ADD COLUMN "purpose" "SchedulePurpose" NOT NULL DEFAULT 'contribution';

UPDATE "schedules"
SET "purpose" = 'previous_installment'
WHERE "name" = 'Previous installment';

CREATE INDEX "schedules_tenant_id_project_id_purpose_idx"
ON "schedules"("tenant_id", "project_id", "purpose");
