BEGIN;
SET LOCAL TIME ZONE 'UTC';
LOCK TABLE users IN ACCESS EXCLUSIVE MODE;
CREATE FUNCTION normalize_login_mobile(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value IS NULL OR btrim(value)='' OR (value LIKE 'g:%' OR value LIKE 'e:%') THEN NULL
    WHEN regexp_replace(value,'[^0-9]','','g') ~ '^01[0-9]{9}$' THEN '+880'||substr(regexp_replace(value,'[^0-9]','','g'),2)
    WHEN regexp_replace(value,'[^0-9]','','g') ~ '^1[0-9]{9}$' THEN '+880'||regexp_replace(value,'[^0-9]','','g')
    WHEN btrim(value) LIKE '00%' THEN '+'||substr(regexp_replace(value,'[^0-9]','','g'),3)
    ELSE '+'||regexp_replace(value,'[^0-9]','','g') END
$$;

-- Only authenticated explicit identity links are eligible for consolidation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users c LEFT JOIN users r ON r.id=c.identity_root_id WHERE c.identity_root_id IS NOT NULL AND (r.id IS NULL OR r.identity_root_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: invalid/nested identity links; run scripts/audit-user-identities.mjs';
  END IF;
  IF EXISTS (SELECT 1 FROM users GROUP BY COALESCE(identity_root_id,id),tenant_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: multiple accounts for an identity within a tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM users c JOIN users r ON r.id=c.identity_root_id WHERE
      (NULLIF(lower(btrim(c.email)),'') IS NOT NULL AND NULLIF(lower(btrim(c.email)),'') IS DISTINCT FROM NULLIF(lower(btrim(r.email)),'')) OR
      (normalize_login_mobile(c.mobile) IS NOT NULL AND normalize_login_mobile(c.mobile) IS DISTINCT FROM normalize_login_mobile(r.mobile)) OR
      (c.password_hash IS NOT NULL AND c.password_hash IS DISTINCT FROM r.password_hash)) THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: linked accounts have conflicting login contacts or credentials';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE identity_root_id IS NULL AND NULLIF(lower(btrim(email)),'') IS NOT NULL GROUP BY lower(btrim(email)) HAVING count(*)>1) OR
     EXISTS (SELECT 1 FROM users WHERE identity_root_id IS NULL AND normalize_login_mobile(mobile) IS NOT NULL GROUP BY normalize_login_mobile(mobile) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: duplicate contacts across unlinked identities; run scripts/audit-user-identities.mjs';
  END IF;
  IF EXISTS (SELECT 1 FROM users WHERE identity_root_id IS NULL AND
      ((normalize_login_mobile(mobile) IS NULL AND NULLIF(btrim(email),'') IS NULL) OR
       (normalize_login_mobile(mobile) IS NOT NULL AND normalize_login_mobile(mobile) !~ '^\+[1-9][0-9]{6,14}$'))) THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: invalid or missing login contact';
  END IF;
END $$;

DROP TRIGGER users_quota_lock ON users;
DROP TRIGGER users_quota_guard ON users;
ALTER TABLE users DROP CONSTRAINT users_identity_root_id_fkey;
ALTER TABLE app_guide_requests DROP CONSTRAINT app_guide_requests_identity_user_id_fkey;
ALTER TABLE users RENAME TO tenant_users;
ALTER TABLE tenant_users RENAME CONSTRAINT users_pkey TO tenant_users_pkey;
ALTER TABLE tenant_users RENAME CONSTRAINT users_tenant_id_fkey TO tenant_users_tenant_id_fkey;
DROP INDEX users_identity_root_id_idx;
DROP INDEX users_tenant_id_mobile_key;

CREATE TABLE users (
 id text PRIMARY KEY, name text NOT NULL, email text, mobile text, password_hash text,
 is_active boolean NOT NULL DEFAULT true, email_verified_at timestamp(3), mobile_verified_at timestamp(3),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamp(3) NOT NULL,
 CONSTRAINT users_email_normalized CHECK (email IS NULL OR (email=lower(btrim(email)) AND email<>'')),
 CONSTRAINT users_mobile_normalized CHECK (mobile IS NULL OR mobile ~ '^\+[1-9][0-9]{6,14}$'),
 CONSTRAINT users_login_contact_required CHECK (email IS NOT NULL OR mobile IS NOT NULL)
);
INSERT INTO users(id,name,email,mobile,password_hash,is_active,created_at,updated_at)
SELECT id,name,NULLIF(lower(btrim(email)),''),normalize_login_mobile(mobile),password_hash,is_active,created_at,updated_at
FROM tenant_users WHERE identity_root_id IS NULL;
CREATE UNIQUE INDEX users_email_key ON users(email);
CREATE UNIQUE INDEX users_mobile_key ON users(mobile);
ALTER TABLE tenant_users ADD COLUMN user_id text;
UPDATE tenant_users SET user_id=COALESCE(identity_root_id,id);
ALTER TABLE tenant_users ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX tenant_users_tenant_id_user_id_key ON tenant_users(tenant_id,user_id);
CREATE INDEX tenant_users_user_id_idx ON tenant_users(user_id);
ALTER TABLE app_guide_requests ADD CONSTRAINT app_guide_requests_identity_user_id_fkey FOREIGN KEY(identity_user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE tenant_users DROP COLUMN name, DROP COLUMN email, DROP COLUMN mobile, DROP COLUMN password_hash, DROP COLUMN identity_root_id;

CREATE OR REPLACE FUNCTION organization_quota_identities(org text, excluded_table text, excluded_id text)
RETURNS TABLE(identity text) LANGUAGE sql VOLATILE AS $$
 SELECT 'u:'||id FROM tenant_users WHERE tenant_id=org AND is_active
   AND NOT (COALESCE(excluded_table IN ('users','tenant_users'),false) AND id=excluded_id)
 UNION
 SELECT 'u:'||user_id FROM project_memberships WHERE tenant_id=org AND is_active
   AND NOT (COALESCE(excluded_table='project_memberships',false) AND id=excluded_id)
 UNION
 SELECT COALESCE('u:'||m.user_id,'u:'||u.id,'m:'||COALESCE(NULLIF(m.mobile,''),lower(m.email),m.id))
 FROM members m LEFT JOIN LATERAL (
   SELECT a.id FROM tenant_users a JOIN users i ON i.id=a.user_id WHERE a.tenant_id=org AND
    ((i.mobile IS NOT NULL AND i.mobile=normalize_login_mobile(m.mobile)) OR (i.email IS NOT NULL AND i.email=lower(btrim(m.email))))
   ORDER BY a.id LIMIT 1
 ) u ON true WHERE m.tenant_id=org AND m.status='active'
   AND NOT (COALESCE(excluded_table='members',false) AND m.id=excluded_id)
$$;
CREATE TRIGGER tenant_users_quota_lock BEFORE INSERT OR UPDATE OF tenant_id,user_id,is_active ON tenant_users FOR EACH ROW EXECUTE FUNCTION lock_organization_quota();
CREATE TRIGGER tenant_users_quota_guard AFTER INSERT OR UPDATE OF tenant_id,user_id,is_active ON tenant_users FOR EACH ROW EXECUTE FUNCTION enforce_organization_quota();

-- Membership references must agree on tenant, including direct database writes.
CREATE FUNCTION check_account_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenant_users a WHERE a.id=NEW.user_id AND a.tenant_id=NEW.tenant_id) THEN
  RAISE EXCEPTION 'ACCOUNT_TENANT_MISMATCH';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sessions_account_tenant BEFORE INSERT OR UPDATE OF tenant_id,user_id ON sessions FOR EACH ROW EXECUTE FUNCTION check_account_tenant();
CREATE TRIGGER memberships_account_tenant BEFORE INSERT OR UPDATE OF tenant_id,user_id ON project_memberships FOR EACH ROW EXECUTE FUNCTION check_account_tenant();
CREATE TRIGGER members_account_tenant BEFORE INSERT OR UPDATE OF tenant_id,user_id ON members FOR EACH ROW EXECUTE FUNCTION check_account_tenant();
ROLLBACK;
