CREATE TYPE "CommitmentStatus" AS ENUM ('pending', 'kept', 'kept_late', 'broken', 'rescheduled', 'cancelled');
CREATE TYPE "CallOutcome" AS ENUM ('committed', 'no_answer', 'claims_paid', 'dispute');

ALTER TABLE "dues" ADD COLUMN "paid_at" TIMESTAMP(3);

UPDATE "dues" d
SET "paid_at" = settled."paid_at"
FROM (
  SELECT da."due_id", MAX(da."created_at") AS "paid_at"
  FROM "deposit_allocations" da
  JOIN "deposits" dep ON dep."id" = da."deposit_id" AND dep."status" = 'confirmed'
  GROUP BY da."due_id"
) settled
WHERE d."id" = settled."due_id" AND d."status" IN ('paid', 'waived');

CREATE TABLE "member_call_logs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "outcome" "CallOutcome" NOT NULL,
  "summary" TEXT,
  "called_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_call_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_call_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_call_logs_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_call_logs_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "payment_commitments" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "call_log_id" TEXT,
  "amount" INTEGER NOT NULL,
  "promised_date" DATE NOT NULL,
  "summary" TEXT NOT NULL,
  "status" "CommitmentStatus" NOT NULL DEFAULT 'pending',
  "outstanding_at_create" INTEGER NOT NULL,
  "superseded_by_id" TEXT,
  "resolved_at" TIMESTAMP(3),
  "resolved_by_id" TEXT,
  "resolved_deposit_id" TEXT,
  "resolve_reason" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_commitments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_commitments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payment_commitments_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payment_commitments_call_log_id_fkey" FOREIGN KEY ("call_log_id") REFERENCES "member_call_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "payment_commitments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "payment_commitments_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "payment_commitments_resolved_deposit_id_fkey" FOREIGN KEY ("resolved_deposit_id") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "payment_commitments_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "payment_commitments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "member_reminders" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "reminder_date" DATE NOT NULL,
  "outstanding" INTEGER NOT NULL,
  "delivered_count" INTEGER NOT NULL,
  "sent_by_id" TEXT NOT NULL,
  "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "member_reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_reminders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_reminders_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_reminders_sent_by_id_fkey" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "payment_commitments_call_log_id_key" ON "payment_commitments"("call_log_id");
CREATE UNIQUE INDEX "payment_commitments_one_pending_per_member" ON "payment_commitments"("project_id", "member_id") WHERE "status" = 'pending';
CREATE INDEX "payment_commitments_tenant_id_project_id_status_promised_date_idx" ON "payment_commitments"("tenant_id", "project_id", "status", "promised_date");
CREATE INDEX "payment_commitments_tenant_id_project_id_member_id_created_at_idx" ON "payment_commitments"("tenant_id", "project_id", "member_id", "created_at");
CREATE INDEX "member_call_logs_tenant_id_project_id_member_id_called_at_idx" ON "member_call_logs"("tenant_id", "project_id", "member_id", "called_at");
CREATE UNIQUE INDEX "member_reminders_project_id_member_id_reminder_date_key" ON "member_reminders"("project_id", "member_id", "reminder_date");
CREATE INDEX "member_reminders_tenant_id_project_id_member_id_sent_at_idx" ON "member_reminders"("tenant_id", "project_id", "member_id", "sent_at");
