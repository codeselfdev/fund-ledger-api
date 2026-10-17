ALTER TABLE account_deletion_requests DROP CONSTRAINT account_deletion_requests_status_check;
ALTER TABLE account_deletion_requests ADD CONSTRAINT account_deletion_requests_status_check
 CHECK (status IN ('pending','in_review','needs_information','processing','processing_failed','completed','rejected'));
ALTER TABLE account_deletion_requests ADD COLUMN processing_lease_until TIMESTAMP(3), ADD COLUMN processing_error TEXT;

-- The request and its alert commit together. Idempotent request retries emit no duplicate alert.
CREATE FUNCTION platform_account_deletion_alert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO platform_alerts(id,tenant_id,kind,user_id,event_key)
 SELECT gen_random_uuid()::text,NEW.tenant_id,'account_deletion',NEW.user_id,'account_deletion:'||NEW.id
 FROM tenants WHERE id=NEW.tenant_id ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER platform_account_deletion_alert AFTER INSERT ON account_deletion_requests
 FOR EACH ROW EXECUTE FUNCTION platform_account_deletion_alert();

-- Previously submitted open requests must also reach the operator once.
INSERT INTO platform_alerts(id,tenant_id,kind,user_id,event_key)
 SELECT gen_random_uuid()::text,r.tenant_id,'account_deletion',r.user_id,'account_deletion:'||r.id
 FROM account_deletion_requests r JOIN tenants t ON t.id=r.tenant_id
 WHERE r.status IN ('pending','in_review','needs_information') ON CONFLICT DO NOTHING;
