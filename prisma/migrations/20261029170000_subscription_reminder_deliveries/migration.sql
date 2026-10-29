CREATE TABLE "subscription_reminder_deliveries" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "notification_id" TEXT NOT NULL,
  "period_ends_at" TIMESTAMP(3) NOT NULL,
  "stage" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" TIMESTAMP(3), "lease_token" TEXT, "sent_at" TIMESTAMP(3), "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_reminder_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_reminder_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "subscription_reminder_deliveries_notification_id_channel_key" ON "subscription_reminder_deliveries"("notification_id", "channel");
CREATE INDEX "subscription_reminder_deliveries_pending_idx" ON "subscription_reminder_deliveries"("status", "next_attempt_at", "lease_until");
CREATE INDEX "subscription_reminder_deliveries_tenant_id_idx" ON "subscription_reminder_deliveries"("tenant_id");
