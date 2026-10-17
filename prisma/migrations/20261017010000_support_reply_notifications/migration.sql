-- New replies only. Historical support messages are not backfilled or emailed.
CREATE TABLE "support_reply_deliveries" (
 "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL, "message_id" TEXT NOT NULL,
 "channel" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
 "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lease_until" TIMESTAMP(3), "lease_token" TEXT, "sent_at" TIMESTAMP(3), "last_error" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "support_reply_deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "support_reply_deliveries_message_id_channel_key" ON "support_reply_deliveries"("message_id", "channel");
CREATE INDEX "support_reply_deliveries_status_next_attempt_at_lease_until_idx" ON "support_reply_deliveries"("status", "next_attempt_at", "lease_until");
CREATE INDEX "support_reply_deliveries_tenant_id_idx" ON "support_reply_deliveries"("tenant_id");
