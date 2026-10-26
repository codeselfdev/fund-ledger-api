-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'teacher';

-- AlterEnum
ALTER TYPE "ProjectType" ADD VALUE 'institute';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "institute_settings" JSONB;

-- CreateTable
CREATE TABLE "institute_groups" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "section" TEXT,
    "academic_year" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "institute_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_students" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "roll_no" TEXT NOT NULL,
    "student_code" TEXT,
    "group_id" TEXT NOT NULL,
    "user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "joined_on" DATE NOT NULL,
    "left_on" DATE,

    CONSTRAINT "institute_students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_guardian_links" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "student_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "can_pay" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "institute_guardian_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_teacher_assignments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "subject_id" TEXT,
    "is_class_teacher" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "institute_teacher_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_subjects" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "pass_percent" INTEGER NOT NULL DEFAULT 33,

    CONSTRAINT "institute_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_routine_slots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "group_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "starts_at" TEXT NOT NULL,
    "ends_at" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "teacher_user_id" TEXT NOT NULL,
    "room" TEXT,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,

    CONSTRAINT "institute_routine_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_attendance_sheets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "group_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "session" INTEGER NOT NULL DEFAULT 1,
    "saved_by_id" TEXT,
    "saved_at" TIMESTAMP(3),

    CONSTRAINT "institute_attendance_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_attendance_marks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sheet_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,

    CONSTRAINT "institute_attendance_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_leave_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "student_id" TEXT NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by" TEXT,

    CONSTRAINT "institute_leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_fee_plans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "group_id" TEXT,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "cycle" TEXT NOT NULL,
    "due_day" INTEGER NOT NULL,

    CONSTRAINT "institute_fee_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_fee_invoices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "student_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paid_amount" INTEGER NOT NULL DEFAULT 0,
    "due_on" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',

    CONSTRAINT "institute_fee_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_fee_payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "student_id" TEXT NOT NULL,
    "invoice_ids" TEXT[],
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "trx_id" TEXT,
    "proof_file_id" TEXT,
    "submitted_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "verified_by" TEXT,
    "receipt_id" TEXT,
    "account_id" TEXT,
    "advance_amount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "institute_fee_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_fee_receipts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "student_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "receipt_no" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "issued_by" TEXT NOT NULL,

    CONSTRAINT "institute_fee_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_posts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "due_on" DATE,
    "requires_ack" BOOLEAN NOT NULL DEFAULT false,
    "file_ids" TEXT[],
    "author_user_id" TEXT NOT NULL,
    "group_ids" TEXT[],
    "sent_at" TIMESTAMP(3),
    "withdrawn_at" TIMESTAMP(3),

    CONSTRAINT "institute_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_post_recipients" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "post_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "delivered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),
    "ack_at" TIMESTAMP(3),

    CONSTRAINT "institute_post_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_documents" (
    "post_id" TEXT,
    "publication_id" TEXT,
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "student_id" TEXT,
    "group_id" TEXT,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "file_id" TEXT,
    "receipt_id" TEXT,
    "visible_from" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institute_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_exams" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "group_ids" TEXT[],
    "subject_ids" TEXT[],
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "grading" TEXT,

    CONSTRAINT "institute_exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_mark_sheets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "exam_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "author_user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',

    CONSTRAINT "institute_mark_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_marks" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sheet_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "components" JSONB NOT NULL,
    "absent" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "institute_marks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_result_publications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "exam_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "show_position" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" JSONB NOT NULL,
    "published_by" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "institute_result_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_write_receipts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,

    CONSTRAINT "institute_write_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institute_notification_deliveries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "history" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "user_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "institute_notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "institute_groups_tenant_id_project_id_idx" ON "institute_groups"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_groups_project_id_academic_year_name_key" ON "institute_groups"("project_id", "academic_year", "name");

-- CreateIndex
CREATE INDEX "institute_students_tenant_id_project_id_idx" ON "institute_students"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_students_project_id_group_id_roll_no_key" ON "institute_students"("project_id", "group_id", "roll_no");

-- CreateIndex
CREATE UNIQUE INDEX "institute_students_project_id_student_code_key" ON "institute_students"("project_id", "student_code");

-- CreateIndex
CREATE INDEX "institute_guardian_links_tenant_id_project_id_idx" ON "institute_guardian_links"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_guardian_links_student_id_user_id_key" ON "institute_guardian_links"("student_id", "user_id");

-- CreateIndex
CREATE INDEX "institute_teacher_assignments_tenant_id_project_id_idx" ON "institute_teacher_assignments"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_teacher_assignments_group_id_subject_id_user_id_key" ON "institute_teacher_assignments"("group_id", "subject_id", "user_id");

-- CreateIndex
CREATE INDEX "institute_subjects_tenant_id_project_id_idx" ON "institute_subjects"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_subjects_project_id_code_key" ON "institute_subjects"("project_id", "code");

-- CreateIndex
CREATE INDEX "institute_routine_slots_tenant_id_project_id_idx" ON "institute_routine_slots"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "institute_attendance_sheets_tenant_id_project_id_idx" ON "institute_attendance_sheets"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_attendance_sheets_project_id_group_id_date_sessio_key" ON "institute_attendance_sheets"("project_id", "group_id", "date", "session");

-- CreateIndex
CREATE INDEX "institute_attendance_marks_tenant_id_project_id_idx" ON "institute_attendance_marks"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_attendance_marks_sheet_id_student_id_key" ON "institute_attendance_marks"("sheet_id", "student_id");

-- CreateIndex
CREATE INDEX "institute_leave_requests_tenant_id_project_id_idx" ON "institute_leave_requests"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "institute_fee_plans_tenant_id_project_id_idx" ON "institute_fee_plans"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "institute_fee_invoices_tenant_id_project_id_idx" ON "institute_fee_invoices"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_fee_invoices_student_id_plan_id_period_key" ON "institute_fee_invoices"("student_id", "plan_id", "period");

-- CreateIndex
CREATE INDEX "institute_fee_payments_tenant_id_project_id_idx" ON "institute_fee_payments"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_fee_payments_project_id_method_trx_id_key" ON "institute_fee_payments"("project_id", "method", "trx_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_fee_receipts_payment_id_key" ON "institute_fee_receipts"("payment_id");

-- CreateIndex
CREATE INDEX "institute_fee_receipts_tenant_id_project_id_idx" ON "institute_fee_receipts"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_fee_receipts_project_id_receipt_no_key" ON "institute_fee_receipts"("project_id", "receipt_no");

-- CreateIndex
CREATE INDEX "institute_posts_tenant_id_project_id_idx" ON "institute_posts"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "institute_post_recipients_tenant_id_project_id_idx" ON "institute_post_recipients"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_post_recipients_post_id_user_id_student_id_key" ON "institute_post_recipients"("post_id", "user_id", "student_id");

-- CreateIndex
CREATE INDEX "institute_documents_tenant_id_project_id_idx" ON "institute_documents"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "institute_exams_tenant_id_project_id_idx" ON "institute_exams"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "institute_mark_sheets_tenant_id_project_id_idx" ON "institute_mark_sheets"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_mark_sheets_exam_id_group_id_subject_id_key" ON "institute_mark_sheets"("exam_id", "group_id", "subject_id");

-- CreateIndex
CREATE INDEX "institute_marks_tenant_id_project_id_idx" ON "institute_marks"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_marks_sheet_id_student_id_key" ON "institute_marks"("sheet_id", "student_id");

-- CreateIndex
CREATE INDEX "institute_result_publications_tenant_id_project_id_idx" ON "institute_result_publications"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_result_publications_exam_id_group_id_version_key" ON "institute_result_publications"("exam_id", "group_id", "version");

-- CreateIndex
CREATE INDEX "institute_write_receipts_tenant_id_project_id_idx" ON "institute_write_receipts"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_write_receipts_project_id_user_id_key_key" ON "institute_write_receipts"("project_id", "user_id", "key");

-- CreateIndex
CREATE INDEX "institute_notification_deliveries_tenant_id_project_id_idx" ON "institute_notification_deliveries"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "institute_notification_deliveries_project_id_user_id_dedupe_key" ON "institute_notification_deliveries"("project_id", "user_id", "dedupe_key", "channel");

-- AddForeignKey
ALTER TABLE "institute_groups" ADD CONSTRAINT "institute_groups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_groups" ADD CONSTRAINT "institute_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_students" ADD CONSTRAINT "institute_students_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "institute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_students" ADD CONSTRAINT "institute_students_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_students" ADD CONSTRAINT "institute_students_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_guardian_links" ADD CONSTRAINT "institute_guardian_links_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_guardian_links" ADD CONSTRAINT "institute_guardian_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_guardian_links" ADD CONSTRAINT "institute_guardian_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_teacher_assignments" ADD CONSTRAINT "institute_teacher_assignments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "institute_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_teacher_assignments" ADD CONSTRAINT "institute_teacher_assignments_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "institute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_teacher_assignments" ADD CONSTRAINT "institute_teacher_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_teacher_assignments" ADD CONSTRAINT "institute_teacher_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_subjects" ADD CONSTRAINT "institute_subjects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_subjects" ADD CONSTRAINT "institute_subjects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_routine_slots" ADD CONSTRAINT "institute_routine_slots_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "institute_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_routine_slots" ADD CONSTRAINT "institute_routine_slots_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "institute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_routine_slots" ADD CONSTRAINT "institute_routine_slots_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_routine_slots" ADD CONSTRAINT "institute_routine_slots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_attendance_sheets" ADD CONSTRAINT "institute_attendance_sheets_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "institute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_attendance_sheets" ADD CONSTRAINT "institute_attendance_sheets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_attendance_sheets" ADD CONSTRAINT "institute_attendance_sheets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_attendance_marks" ADD CONSTRAINT "institute_attendance_marks_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_attendance_marks" ADD CONSTRAINT "institute_attendance_marks_sheet_id_fkey" FOREIGN KEY ("sheet_id") REFERENCES "institute_attendance_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_attendance_marks" ADD CONSTRAINT "institute_attendance_marks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_attendance_marks" ADD CONSTRAINT "institute_attendance_marks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_leave_requests" ADD CONSTRAINT "institute_leave_requests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_leave_requests" ADD CONSTRAINT "institute_leave_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_leave_requests" ADD CONSTRAINT "institute_leave_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_plans" ADD CONSTRAINT "institute_fee_plans_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "institute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_plans" ADD CONSTRAINT "institute_fee_plans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_plans" ADD CONSTRAINT "institute_fee_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_invoices" ADD CONSTRAINT "institute_fee_invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "institute_fee_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_invoices" ADD CONSTRAINT "institute_fee_invoices_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_invoices" ADD CONSTRAINT "institute_fee_invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_invoices" ADD CONSTRAINT "institute_fee_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_payments" ADD CONSTRAINT "institute_fee_payments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_payments" ADD CONSTRAINT "institute_fee_payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_payments" ADD CONSTRAINT "institute_fee_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_receipts" ADD CONSTRAINT "institute_fee_receipts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_receipts" ADD CONSTRAINT "institute_fee_receipts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_fee_receipts" ADD CONSTRAINT "institute_fee_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_posts" ADD CONSTRAINT "institute_posts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_posts" ADD CONSTRAINT "institute_posts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_post_recipients" ADD CONSTRAINT "institute_post_recipients_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_post_recipients" ADD CONSTRAINT "institute_post_recipients_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "institute_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_post_recipients" ADD CONSTRAINT "institute_post_recipients_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_post_recipients" ADD CONSTRAINT "institute_post_recipients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_documents" ADD CONSTRAINT "institute_documents_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "institute_posts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_documents" ADD CONSTRAINT "institute_documents_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "institute_result_publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_documents" ADD CONSTRAINT "institute_documents_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "institute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_documents" ADD CONSTRAINT "institute_documents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_documents" ADD CONSTRAINT "institute_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_documents" ADD CONSTRAINT "institute_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_exams" ADD CONSTRAINT "institute_exams_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_exams" ADD CONSTRAINT "institute_exams_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_mark_sheets" ADD CONSTRAINT "institute_mark_sheets_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "institute_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_mark_sheets" ADD CONSTRAINT "institute_mark_sheets_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "institute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_mark_sheets" ADD CONSTRAINT "institute_mark_sheets_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "institute_exams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_mark_sheets" ADD CONSTRAINT "institute_mark_sheets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_mark_sheets" ADD CONSTRAINT "institute_mark_sheets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_marks" ADD CONSTRAINT "institute_marks_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "institute_students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_marks" ADD CONSTRAINT "institute_marks_sheet_id_fkey" FOREIGN KEY ("sheet_id") REFERENCES "institute_mark_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_marks" ADD CONSTRAINT "institute_marks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_marks" ADD CONSTRAINT "institute_marks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_result_publications" ADD CONSTRAINT "institute_result_publications_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "institute_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_result_publications" ADD CONSTRAINT "institute_result_publications_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "institute_exams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_result_publications" ADD CONSTRAINT "institute_result_publications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_result_publications" ADD CONSTRAINT "institute_result_publications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_write_receipts" ADD CONSTRAINT "institute_write_receipts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_write_receipts" ADD CONSTRAINT "institute_write_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_notification_deliveries" ADD CONSTRAINT "institute_notification_deliveries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institute_notification_deliveries" ADD CONSTRAINT "institute_notification_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable subject assignments need a partial key for the class-teacher case.
CREATE UNIQUE INDEX "institute_teacher_assignments_class_key" ON "institute_teacher_assignments" ("group_id", "user_id") WHERE "subject_id" IS NULL;
ALTER TABLE "institute_students" ADD CONSTRAINT "institute_student_status" CHECK ("status" IN ('active','left','transferred'));
ALTER TABLE "institute_attendance_marks" ADD CONSTRAINT "institute_attendance_status" CHECK ("status" IN ('present','late','absent','leave'));
ALTER TABLE "institute_fee_plans" ADD CONSTRAINT "institute_fee_plan_amount" CHECK ("amount" > 0 AND "due_day" BETWEEN 1 AND 28);
ALTER TABLE "institute_fee_invoices" ADD CONSTRAINT "institute_invoice_amount" CHECK ("amount" > 0 AND "paid_amount" BETWEEN 0 AND "amount");
ALTER TABLE "institute_fee_payments" ADD CONSTRAINT "institute_payment_amount" CHECK ("amount" > 0 AND "advance_amount" >= 0);
ALTER TABLE "institute_documents" ADD CONSTRAINT "institute_document_scope" CHECK (("student_id" IS NOT NULL)::int + ("group_id" IS NOT NULL)::int = 1);
ALTER TABLE "institute_routine_slots" ADD CONSTRAINT "institute_routine_time" CHECK ("starts_at" < "ends_at" AND "weekday" BETWEEN 0 AND 6);
