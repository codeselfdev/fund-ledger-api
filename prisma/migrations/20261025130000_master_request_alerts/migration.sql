CREATE TABLE "master_alert_deliveries" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "alert_id" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" TIMESTAMP(3),
  "lease_token" TEXT,
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "accepted_push_hashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "master_alert_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "master_alert_deliveries_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "platform_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "master_alert_deliveries_alert_id_channel_key" ON "master_alert_deliveries"("alert_id", "channel");
CREATE INDEX "master_alert_deliveries_status_next_attempt_at_lease_until_idx" ON "master_alert_deliveries"("status", "next_attempt_at", "lease_until");
CREATE INDEX "master_alert_deliveries_tenant_id_idx" ON "master_alert_deliveries"("tenant_id");

-- Support message triggers and billing upserts already commit PlatformAlert with their source request.
-- A nested trigger keeps both admin channels atomic with those same transactions.
CREATE FUNCTION queue_master_request_alert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IN ('support_message', 'billing_upgrade', 'billing_payment') THEN
    INSERT INTO master_alert_deliveries(id, tenant_id, alert_id, channel)
    SELECT gen_random_uuid()::text, NEW.tenant_id, NEW.id, channel
    FROM (VALUES ('email'), ('push')) AS channels(channel)
    ON CONFLICT (alert_id, channel) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER queue_master_request_alert AFTER INSERT ON "platform_alerts"
  FOR EACH ROW EXECUTE FUNCTION queue_master_request_alert();
-- Deliberately no historical backfill: rollout must not broadcast old requests to the master.
