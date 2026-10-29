BEGIN;
SET LOCAL TIME ZONE 'UTC';

CREATE TYPE "SubscriptionPackage" AS ENUM ('free', 'starter', 'business', 'custom');

CREATE TYPE "SubscriptionState" AS ENUM ('trial', 'active', 'expired');

CREATE TYPE "SubscriptionBillingCycle" AS ENUM ('monthly', 'yearly');

CREATE TYPE "SubscriptionInvoiceState" AS ENUM ('open', 'submitted', 'approved', 'rejected');

CREATE TABLE "tenant_subscriptions" (
    "tenant_id" TEXT NOT NULL,
    "package" "SubscriptionPackage" NOT NULL DEFAULT 'free',
    "status" "SubscriptionState" NOT NULL,
    "billing_cycle" "SubscriptionBillingCycle" NOT NULL,
    "trial_starts_at" TIMESTAMP(3),
    "trial_ends_at" TIMESTAMP(3),
    "current_period_start_at" TIMESTAMP(3),
    "current_period_end_at" TIMESTAMP(3),
    "quota_reset_at" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("tenant_id")
);

CREATE TABLE "subscription_invoices" (
    "tenant_id" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "package" "SubscriptionPackage",
    "billing_cycle" "SubscriptionBillingCycle",
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "SubscriptionInvoiceState" NOT NULL DEFAULT 'open',
    "instructions" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payment_reference" TEXT,
    "payment_amount" INTEGER,
    "payment_request_key" TEXT,
    "receipt_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "period_ends_at" TIMESTAMP(3),

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("tenant_id","id")
);

CREATE TABLE "subscription_history" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor" TEXT,
    "invoice_id" TEXT,
    "payment_id" TEXT,
    "previous" JSONB,
    "current" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_subscriptions_status_trial_ends_at_idx" ON "tenant_subscriptions"("status", "trial_ends_at");

CREATE INDEX "tenant_subscriptions_status_current_period_end_at_idx" ON "tenant_subscriptions"("status", "current_period_end_at");

CREATE INDEX "subscription_invoices_tenant_id_issued_at_idx" ON "subscription_invoices"("tenant_id", "issued_at");

CREATE INDEX "subscription_invoices_status_submitted_at_idx" ON "subscription_invoices"("status", "submitted_at");

CREATE UNIQUE INDEX "subscription_invoices_tenant_id_payment_request_key_key" ON "subscription_invoices"("tenant_id", "payment_request_key");

CREATE INDEX "subscription_history_tenant_id_created_at_idx" ON "subscription_history"("tenant_id", "created_at");

CREATE UNIQUE INDEX "subscription_history_tenant_id_revision_key" ON "subscription_history"("tenant_id", "revision");

ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscription_history" ADD CONSTRAINT "subscription_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invalid dates/packages/statuses fail the transaction rather than changing access silently.
INSERT INTO tenant_subscriptions (tenant_id,package,status,billing_cycle,trial_starts_at,trial_ends_at,current_period_start_at,current_period_end_at,quota_reset_at,created_at,updated_at)
SELECT id,
  COALESCE(contact->'subscription'->>'package', CASE WHEN contact->'subscription'->>'current_period_end_at' IS NOT NULL THEN 'starter' ELSE 'free' END)::"SubscriptionPackage",
  COALESCE(contact->'subscription'->>'status','active')::"SubscriptionState",
  COALESCE(contact->'subscription'->>'billing_cycle','yearly')::"SubscriptionBillingCycle",
  (contact->'subscription'->>'trial_starts_at')::timestamptz,
  (contact->'subscription'->>'trial_ends_at')::timestamptz,
  (contact->'subscription'->>'current_period_start_at')::timestamptz,
  (contact->'subscription'->>'current_period_end_at')::timestamptz,
  (contact->'subscription'->>'quota_reset_at')::timestamptz,
  created_at,COALESCE((contact->'subscription'->>'updated_at')::timestamptz,updated_at)
FROM tenants WHERE jsonb_typeof(contact->'subscription')='object';

-- Missing subscriptions stay inaccessible instead of gaining a new trial.
INSERT INTO tenant_subscriptions (tenant_id,package,status,billing_cycle,created_at,updated_at)
SELECT id,'free','expired','yearly',created_at,updated_at FROM tenants
WHERE NOT EXISTS (SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id=tenants.id);

INSERT INTO subscription_invoices (tenant_id,id,package,billing_cycle,amount,currency,status,instructions,issued_at,payment_reference,payment_amount,payment_request_key,receipt_id,submitted_at,approved_at,rejection_reason,period_ends_at)
SELECT t.id,i->>'id',(i->>'package')::"SubscriptionPackage",(i->>'billing_cycle')::"SubscriptionBillingCycle",
  (i->>'amount')::int,i->>'currency',(i->>'status')::"SubscriptionInvoiceState",i->>'instructions',(i->>'issued_at')::timestamptz,
  i->>'payment_reference',(i->>'payment_amount')::int,i->>'payment_request_key',i->'receipt'->>'id',
  (i->>'submitted_at')::timestamptz,(i->>'approved_at')::timestamptz,i->>'rejection_reason',(i->>'period_ends_at')::timestamptz
FROM tenants t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.contact->'billing'->'invoices','[]'::jsonb)) i;
ALTER TABLE subscription_payment_receipts ADD CONSTRAINT subscription_payment_receipts_invoice_fkey
 FOREIGN KEY(tenant_id,invoice_id) REFERENCES subscription_invoices(tenant_id,id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX subscription_invoices_one_unpaid_per_tenant ON subscription_invoices(tenant_id) WHERE status<>'approved';
ALTER TABLE subscription_invoices ADD CONSTRAINT subscription_invoice_positive_amount CHECK (amount>0 AND (payment_amount IS NULL OR payment_amount>0));
CREATE FUNCTION subscription_invoice_receipt_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subscription_payment_receipts r WHERE r.id=NEW.receipt_id AND r.tenant_id=NEW.tenant_id AND r.invoice_id=NEW.id) THEN
  RAISE EXCEPTION 'SUBSCRIPTION_RECEIPT_SCOPE_MISMATCH';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER subscription_invoice_receipt_scope BEFORE INSERT OR UPDATE OF receipt_id ON subscription_invoices FOR EACH ROW EXECUTE FUNCTION subscription_invoice_receipt_scope();
ALTER TABLE tenant_subscriptions ADD CONSTRAINT subscription_positive_revision CHECK (revision>0);

INSERT INTO subscription_history(id,tenant_id,revision,event,current,created_at)
SELECT 'migration:'||tenant_id,tenant_id,revision,'migrated',to_jsonb(s),updated_at FROM tenant_subscriptions s;

CREATE FUNCTION subscription_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Cascading organization deletion can remove history; ordinary edits cannot.
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'SUBSCRIPTION_HISTORY_IMMUTABLE';
END $$;
CREATE TRIGGER subscription_history_immutable BEFORE UPDATE OR DELETE ON subscription_history FOR EACH ROW EXECUTE FUNCTION subscription_history_immutable();

-- Direct operator edits get a new revision and a history event as well.
CREATE FUNCTION subscription_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'SUBSCRIPTION_TENANT_IMMUTABLE'; END IF;
 NEW.revision:=CASE WHEN TG_OP='INSERT' THEN 1 ELSE OLD.revision+1 END;
 RETURN NEW;
END $$;
CREATE TRIGGER subscription_revision BEFORE INSERT OR UPDATE ON tenant_subscriptions FOR EACH ROW EXECUTE FUNCTION subscription_revision();

CREATE FUNCTION subscription_history_fallback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb;
BEGIN
 -- Deferred execution permits the service to supply a richer event in the same transaction.
 -- A tenant deleted in that transaction no longer needs a history event.
 IF NOT EXISTS(SELECT 1 FROM tenant_subscriptions WHERE tenant_id=NEW.tenant_id) THEN RETURN NULL; END IF;
 SELECT current INTO snapshot FROM subscription_history WHERE tenant_id=NEW.tenant_id AND revision=NEW.revision;
 IF FOUND THEN
  IF snapshot->>'package' IS DISTINCT FROM NEW.package::text OR snapshot->>'status' IS DISTINCT FROM NEW.status::text THEN
   RAISE EXCEPTION 'SUBSCRIPTION_HISTORY_STATE_MISMATCH';
  END IF;
  RETURN NULL;
 END IF;
 INSERT INTO subscription_history(id,tenant_id,revision,event,actor,previous,current)
 VALUES('database:'||NEW.tenant_id||':'||NEW.revision,NEW.tenant_id,NEW.revision,
  CASE WHEN TG_OP='INSERT' THEN 'database_created' ELSE 'database_updated' END,current_user,
  CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW));
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subscription_history_fallback AFTER INSERT OR UPDATE ON tenant_subscriptions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION subscription_history_fallback();

-- The database and application enforce the same canonical package.
CREATE OR REPLACE FUNCTION enforce_organization_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pkg text; document_limit int; user_limit int; project_limit int; used bigint;
BEGIN
  SELECT package::text INTO pkg FROM tenant_subscriptions WHERE tenant_id = NEW.tenant_id;
  document_limit := CASE pkg WHEN 'starter' THEN 1000 WHEN 'business' THEN 15000 WHEN 'custom' THEN NULL ELSE 100 END;
  user_limit := CASE pkg WHEN 'starter' THEN 20 WHEN 'business' THEN 500 ELSE NULL END;
  project_limit := CASE pkg WHEN 'starter' THEN 2 WHEN 'business' THEN 6 WHEN 'custom' THEN NULL ELSE 2 END;
  IF TG_TABLE_NAME = 'projects' THEN
    -- Existing over-limit projects remain editable; only new slots or tenant moves consume capacity.
    IF TG_OP = 'UPDATE' AND NEW.tenant_id = OLD.tenant_id THEN RETURN NEW; END IF;
    IF project_limit IS NOT NULL THEN
      SELECT count(*) INTO used FROM projects WHERE tenant_id = NEW.tenant_id;
      IF used > project_limit THEN RAISE EXCEPTION 'PROJECT_QUOTA_EXCEEDED'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'uploads' THEN
    IF (TG_OP = 'INSERT' OR NEW.size IS DISTINCT FROM OLD.size) AND (NEW.size <= 0 OR NEW.size > 5000000) THEN RAISE EXCEPTION 'DOCUMENT_TOO_LARGE'; END IF;
    IF NEW.deleted_at IS NULL AND document_limit IS NOT NULL THEN
      SELECT count(*) INTO used FROM uploads WHERE tenant_id = NEW.tenant_id AND deleted_at IS NULL;
      IF used > document_limit THEN RAISE EXCEPTION 'DOCUMENT_QUOTA_EXCEEDED'; END IF;
    END IF;
  ELSIF user_limit IS NOT NULL THEN
    -- Deactivation/removal must remain available even if a legacy tenant exceeds its quota.
    IF TG_TABLE_NAME = 'members' THEN
      IF NEW.status <> 'active' THEN RETURN NEW; END IF;
    ELSE
      IF NOT NEW.is_active THEN RETURN NEW; END IF;
    END IF;
    SELECT count(*) INTO used FROM organization_quota_identities(NEW.tenant_id, NULL, NULL);
    IF used > user_limit THEN RAISE EXCEPTION 'USER_QUOTA_EXCEEDED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Retire both old entitlement locations. Preserve unrelated billing settings.
UPDATE tenants SET contact=(contact-'subscription') #- '{billing,invoices}' WHERE contact IS NOT NULL;
ALTER TABLE tenants DROP COLUMN plan;
DROP TYPE "TenantPlan";
COMMIT;
