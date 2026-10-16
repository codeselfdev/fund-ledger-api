-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "deletion_started_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "assistant_replies" ALTER COLUMN "period_start" SET DATA TYPE TIMESTAMP(3);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "last_sender" TEXT NOT NULL DEFAULT 'user',
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_attachments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_installations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "package" TEXT NOT NULL,
    "billing_cycle" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "notes" TEXT,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "period_ends_at" TIMESTAMP(3) NOT NULL,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_audit" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "internal_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_deletion_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "objects_deleted" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "tenant_deletion_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_tickets_tenant_id_requester_id_last_message_at_idx" ON "support_tickets"("tenant_id", "requester_id", "last_message_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_last_message_at_idx" ON "support_tickets"("status", "last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_tenant_id_requester_id_request_key_key" ON "support_tickets"("tenant_id", "requester_id", "request_key");

-- CreateIndex
CREATE INDEX "support_messages_tenant_id_ticket_id_created_at_idx" ON "support_messages"("tenant_id", "ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_messages_ticket_id_request_key_key" ON "support_messages"("ticket_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "support_attachments_storage_key_key" ON "support_attachments"("storage_key");

-- CreateIndex
CREATE INDEX "support_attachments_tenant_id_idx" ON "support_attachments"("tenant_id");

-- CreateIndex
CREATE INDEX "app_installations_tenant_id_first_seen_at_idx" ON "app_installations"("tenant_id", "first_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "app_installations_tenant_id_user_id_installation_id_key" ON "app_installations"("tenant_id", "user_id", "installation_id");

-- CreateIndex
CREATE INDEX "platform_payments_tenant_id_paid_at_idx" ON "platform_payments"("tenant_id", "paid_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_payments_tenant_id_request_key_key" ON "platform_payments"("tenant_id", "request_key");

-- CreateIndex
CREATE INDEX "internal_audit_tenant_id_created_at_idx" ON "internal_audit"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_deletion_jobs_tenant_id_key" ON "tenant_deletion_jobs"("tenant_id");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_installations" ADD CONSTRAINT "app_installations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_payments" ADD CONSTRAINT "platform_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
