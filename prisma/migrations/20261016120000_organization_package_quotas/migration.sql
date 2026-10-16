ALTER TABLE "uploads" ADD COLUMN "deleted_at" TIMESTAMP(3), ADD COLUMN "purge_after_at" TIMESTAMP(3);
CREATE INDEX "uploads_tenant_id_deleted_at_idx" ON "uploads"("tenant_id", "deleted_at");
CREATE INDEX "uploads_purge_after_at_idx" ON "uploads"("purge_after_at");

-- Users with multiple roles/projects/shares occupy one seat. Member records without
-- a login still occupy a seat; linking the login must not charge a second seat.
CREATE FUNCTION organization_quota_identities(org text, excluded_table text, excluded_id text)
RETURNS TABLE(identity text) LANGUAGE sql VOLATILE AS $$
  SELECT 'u:' || id FROM users WHERE tenant_id = org AND is_active
    AND NOT (COALESCE(excluded_table = 'users', false) AND id = excluded_id)
  UNION
  SELECT 'u:' || user_id FROM project_memberships WHERE tenant_id = org AND is_active
    AND NOT (COALESCE(excluded_table = 'project_memberships', false) AND id = excluded_id)
  UNION
  SELECT COALESCE('u:' || m.user_id, 'u:' || u.id, 'm:' || COALESCE(NULLIF(m.mobile, ''), lower(m.email), m.id))
  FROM members m LEFT JOIN LATERAL (
    SELECT id FROM users WHERE tenant_id = org AND
      ((mobile <> '' AND mobile = m.mobile) OR (email IS NOT NULL AND lower(email) = lower(m.email)))
    ORDER BY id LIMIT 1
  ) u ON true
  WHERE m.tenant_id = org AND m.status = 'active'
    AND NOT (COALESCE(excluded_table = 'members', false) AND m.id = excluded_id);
$$;

-- Serialize quota-affecting writes on a tenant row. NO KEY UPDATE is compatible
-- with FK key-share locks, avoiding lock upgrades on concurrent user creation.
CREATE FUNCTION lock_organization_quota() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM tenants WHERE id = NEW.tenant_id FOR NO KEY UPDATE;
  RETURN NEW;
END;
$$;
CREATE FUNCTION enforce_organization_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pkg text; document_limit int; user_limit int; project_limit int; used bigint;
BEGIN
  SELECT COALESCE(contact->'subscription'->>'package', CASE WHEN contact->'subscription'->>'current_period_end_at' IS NOT NULL THEN 'starter' ELSE 'free' END) INTO pkg FROM tenants WHERE id = NEW.tenant_id;
  document_limit := CASE pkg WHEN 'starter' THEN 1000 WHEN 'business' THEN 15000 WHEN 'custom' THEN NULL ELSE 100 END;
  user_limit := CASE pkg WHEN 'starter' THEN 20 WHEN 'business' THEN 500 ELSE NULL END;
  project_limit := CASE pkg WHEN 'starter' THEN 6 WHEN 'business' THEN 20 WHEN 'custom' THEN NULL ELSE 2 END;
  IF TG_TABLE_NAME = 'projects' THEN
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
CREATE TRIGGER uploads_quota_lock BEFORE INSERT OR UPDATE OF tenant_id, size, deleted_at ON uploads FOR EACH ROW EXECUTE FUNCTION lock_organization_quota();
CREATE TRIGGER uploads_quota_guard AFTER INSERT OR UPDATE OF tenant_id, size, deleted_at ON uploads FOR EACH ROW EXECUTE FUNCTION enforce_organization_quota();
CREATE TRIGGER users_quota_lock BEFORE INSERT OR UPDATE OF tenant_id, is_active, mobile, email ON users FOR EACH ROW EXECUTE FUNCTION lock_organization_quota();
CREATE TRIGGER users_quota_guard AFTER INSERT OR UPDATE OF tenant_id, is_active, mobile, email ON users FOR EACH ROW EXECUTE FUNCTION enforce_organization_quota();
CREATE TRIGGER members_quota_lock BEFORE INSERT OR UPDATE OF tenant_id, user_id, mobile, email, status ON members FOR EACH ROW EXECUTE FUNCTION lock_organization_quota();
CREATE TRIGGER members_quota_guard AFTER INSERT OR UPDATE OF tenant_id, user_id, mobile, email, status ON members FOR EACH ROW EXECUTE FUNCTION enforce_organization_quota();
CREATE TRIGGER memberships_quota_lock BEFORE INSERT OR UPDATE OF tenant_id, user_id, is_active ON project_memberships FOR EACH ROW EXECUTE FUNCTION lock_organization_quota();
CREATE TRIGGER memberships_quota_guard AFTER INSERT OR UPDATE OF tenant_id, user_id, is_active ON project_memberships FOR EACH ROW EXECUTE FUNCTION enforce_organization_quota();
CREATE TRIGGER projects_quota_lock BEFORE INSERT OR UPDATE OF tenant_id ON projects FOR EACH ROW EXECUTE FUNCTION lock_organization_quota();
CREATE TRIGGER projects_quota_guard AFTER INSERT OR UPDATE OF tenant_id ON projects FOR EACH ROW EXECUTE FUNCTION enforce_organization_quota();
