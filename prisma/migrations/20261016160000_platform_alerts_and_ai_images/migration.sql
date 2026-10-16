CREATE TABLE "assistant_attachments" (
 "id" TEXT PRIMARY KEY,"tenant_id" TEXT NOT NULL,"reply_id" TEXT NOT NULL,
 "file_name" TEXT NOT NULL,"mime_type" TEXT NOT NULL,"size" INTEGER NOT NULL,"content_hash" TEXT NOT NULL,"storage_key" TEXT NOT NULL UNIQUE,
 CONSTRAINT "assistant_attachments_reply_id_fkey" FOREIGN KEY ("reply_id") REFERENCES "assistant_replies"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "assistant_attachments_tenant_id_reply_id_idx" ON "assistant_attachments"("tenant_id","reply_id");
CREATE TABLE "platform_alerts" (
 "id" TEXT PRIMARY KEY,"tenant_id" TEXT NOT NULL,"kind" TEXT NOT NULL,"user_id" TEXT,"ticket_id" TEXT,"event_key" TEXT NOT NULL UNIQUE,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"read_at" TIMESTAMP(3),"email_sent_at" TIMESTAMP(3),"telegram_sent_at" TIMESTAMP(3),"telegram_attempts" INTEGER NOT NULL DEFAULT 0,"telegram_next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"telegram_lease_until" TIMESTAMP(3),"attempts" INTEGER NOT NULL DEFAULT 0,
 "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"lease_until" TIMESTAMP(3),
 CONSTRAINT "platform_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX "platform_alerts_created_at_id_idx" ON "platform_alerts"("created_at","id");
CREATE INDEX "platform_alerts_email_sent_at_next_attempt_at_idx" ON "platform_alerts"("email_sent_at","next_attempt_at");
CREATE INDEX "platform_alerts_telegram_sent_at_telegram_next_attempt_at_idx" ON "platform_alerts"("telegram_sent_at","telegram_next_attempt_at");
CREATE INDEX "platform_alerts_tenant_id_created_at_idx" ON "platform_alerts"("tenant_id","created_at");
-- Events commit with the source record. Rollbacks and idempotent message retries cannot create phantom alerts.
CREATE FUNCTION platform_signup_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO platform_alerts(id,tenant_id,kind,event_key) VALUES(gen_random_uuid()::text,NEW.id,'signup','signup:'||NEW.id) ON CONFLICT DO NOTHING;
 RETURN NEW; END $$;
CREATE TRIGGER platform_signup_alert AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION platform_signup_alert();
CREATE FUNCTION platform_support_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.sender='user' THEN
 INSERT INTO platform_alerts(id,tenant_id,kind,user_id,ticket_id,event_key)
 SELECT gen_random_uuid()::text,NEW.tenant_id,'support_message',requester_id,NEW.ticket_id,'support:'||NEW.id FROM support_tickets WHERE id=NEW.ticket_id ON CONFLICT DO NOTHING;
 END IF; RETURN NEW; END $$;
CREATE TRIGGER platform_support_alert AFTER INSERT ON support_messages FOR EACH ROW EXECUTE FUNCTION platform_support_alert();
