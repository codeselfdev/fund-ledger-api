-- Preserve shared project history when its author account is deleted.
-- The linked-organization identity root restriction remains intentional.
BEGIN;

ALTER TABLE "member_call_logs" DROP CONSTRAINT "member_call_logs_created_by_id_fkey";
ALTER TABLE "member_call_logs" ALTER COLUMN "created_by_id" DROP NOT NULL;
ALTER TABLE "member_call_logs" ADD CONSTRAINT "member_call_logs_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_commitments" DROP CONSTRAINT "payment_commitments_created_by_id_fkey";
ALTER TABLE "payment_commitments" ALTER COLUMN "created_by_id" DROP NOT NULL;
ALTER TABLE "payment_commitments" ADD CONSTRAINT "payment_commitments_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "member_reminders" DROP CONSTRAINT "member_reminders_sent_by_id_fkey";
ALTER TABLE "member_reminders" ALTER COLUMN "sent_by_id" DROP NOT NULL;
ALTER TABLE "member_reminders" ADD CONSTRAINT "member_reminders_sent_by_id_fkey"
  FOREIGN KEY ("sent_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "polls" DROP CONSTRAINT "polls_created_by_id_fkey";
ALTER TABLE "polls" ALTER COLUMN "created_by_id" DROP NOT NULL;
ALTER TABLE "polls" ADD CONSTRAINT "polls_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_events" DROP CONSTRAINT "project_events_created_by_id_fkey";
ALTER TABLE "project_events" ALTER COLUMN "created_by_id" DROP NOT NULL;
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_notices" DROP CONSTRAINT "project_notices_created_by_id_fkey";
ALTER TABLE "project_notices" ALTER COLUMN "created_by_id" DROP NOT NULL;
ALTER TABLE "project_notices" ADD CONSTRAINT "project_notices_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
