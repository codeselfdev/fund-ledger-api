CREATE TABLE "assistant_replies" (
 "id" TEXT PRIMARY KEY, "tenant_id" TEXT NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "project_id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "channel" TEXT NOT NULL,
 "request_key" TEXT NOT NULL, "prompt_hash" TEXT NOT NULL, "authorization_hash" TEXT, "prompt" TEXT NOT NULL, "reply" TEXT,
 "status" TEXT NOT NULL DEFAULT 'queued', "period_start" DATE NOT NULL, "lease_until" TIMESTAMP(3),
 "attempts" INTEGER NOT NULL DEFAULT 0, "recipient" TEXT, "connection_id" TEXT, "delivered_at" TIMESTAMP(3), "error_code" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "assistant_replies_tenant_id_channel_request_key_key" ON "assistant_replies"("tenant_id", "channel", "request_key");
CREATE INDEX "assistant_replies_tenant_id_channel_period_start_status_idx" ON "assistant_replies"("tenant_id", "channel", "period_start", "status");
CREATE INDEX "assistant_replies_status_lease_until_idx" ON "assistant_replies"("status", "lease_until");
CREATE INDEX "assistant_replies_tenant_id_project_id_user_id_channel_crea_idx" ON "assistant_replies"("tenant_id", "project_id", "user_id", "channel", "created_at");
