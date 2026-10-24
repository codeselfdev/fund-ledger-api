-- New credit extensions only. Historical grants do not notify customers retroactively.
CREATE TABLE "ai_credit_deliveries" (
 "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "notification_id" TEXT NOT NULL,
 "channel" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
 "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lease_until" TIMESTAMP(3), "lease_token" TEXT, "sent_at" TIMESTAMP(3), "last_error" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ai_credit_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ai_credit_deliveries_notification_id_channel_key" ON "ai_credit_deliveries"("notification_id", "channel");
CREATE INDEX "ai_credit_deliveries_status_next_attempt_at_lease_until_idx" ON "ai_credit_deliveries"("status", "next_attempt_at", "lease_until");
CREATE INDEX "ai_credit_deliveries_tenant_id_idx" ON "ai_credit_deliveries"("tenant_id");
