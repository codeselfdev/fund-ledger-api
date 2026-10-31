-- Member recognition: extra effort accredited by an owner/admin.
-- Accredited rows add reliability points (offsetting broken commitments and missed deadlines).
CREATE TYPE "RecognitionStatus" AS ENUM ('pending', 'accredited', 'declined', 'withdrawn', 'revoked');

CREATE TABLE "member_recognitions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "member_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "note" TEXT,
  "effort_date" DATE NOT NULL,
  "effort_minutes" INTEGER,
  "status" "RecognitionStatus" NOT NULL DEFAULT 'pending',
  "requested_by_id" TEXT,
  "reviewed_by_id" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "review_note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "member_recognitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_recognitions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_recognitions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "member_recognitions_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "tenant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "member_recognitions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "tenant_users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "member_recognitions_title_check" CHECK (char_length("title") BETWEEN 3 AND 120),
  CONSTRAINT "member_recognitions_note_check" CHECK ("note" IS NULL OR char_length("note") <= 500),
  CONSTRAINT "member_recognitions_minutes_check" CHECK ("effort_minutes" IS NULL OR "effort_minutes" BETWEEN 1 AND 1440)
);

CREATE INDEX "member_recognitions_tenant_id_project_id_status_effort_date_idx" ON "member_recognitions"("tenant_id", "project_id", "status", "effort_date");
CREATE INDEX "member_recognitions_tenant_id_project_id_member_id_created_at_idx" ON "member_recognitions"("tenant_id", "project_id", "member_id", "created_at");
