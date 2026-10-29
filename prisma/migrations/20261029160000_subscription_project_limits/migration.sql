-- Update project creation caps without rewriting existing projects or invoices.
-- Existing quota locks and triggers continue enforcing atomic writes.
CREATE OR REPLACE FUNCTION enforce_organization_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pkg text; document_limit int; user_limit int; project_limit int; used bigint;
BEGIN
  SELECT COALESCE(contact->'subscription'->>'package', CASE WHEN contact->'subscription'->>'current_period_end_at' IS NOT NULL THEN 'starter' ELSE 'free' END) INTO pkg FROM tenants WHERE id = NEW.tenant_id;
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
