CREATE TABLE "platform_broadcasts" (
  "id" TEXT NOT NULL, "actor" TEXT NOT NULL, "request_key" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL, "title" TEXT NOT NULL, "body" TEXT NOT NULL,
  "device_count" INTEGER NOT NULL, "account_count" INTEGER NOT NULL,
  "organization_count" INTEGER NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_broadcasts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_broadcasts_actor_request_key_key" ON "platform_broadcasts"("actor", "request_key");
CREATE INDEX "platform_broadcasts_created_at_id_idx" ON "platform_broadcasts"("created_at", "id");
CREATE TABLE "platform_broadcast_deliveries" (
  "id" TEXT NOT NULL, "broadcast_id" TEXT NOT NULL, "token_hash" TEXT NOT NULL,
  "recipient_ids" TEXT[] NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "lease_token" TEXT,
  "lease_until" TIMESTAMP(3), "last_error" TEXT, "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_broadcast_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_broadcast_deliveries_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "platform_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "platform_broadcast_deliveries_broadcast_id_token_hash_key" ON "platform_broadcast_deliveries"("broadcast_id", "token_hash");
CREATE INDEX "platform_broadcast_deliveries_status_next_attempt_at_idx" ON "platform_broadcast_deliveries"("status", "next_attempt_at");
