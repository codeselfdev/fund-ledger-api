-- No explicit BEGIN/COMMIT: Prisma runs this file as one implicit transaction, so it stays
-- atomic AND the real error is reported (an explicit BEGIN masked it as "transaction is aborted").
SET LOCAL TIME ZONE 'UTC';
LOCK TABLE users IN ACCESS EXCLUSIVE MODE;
CREATE FUNCTION normalize_login_mobile(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN value IS NULL OR btrim(value)='' OR (value LIKE 'g:%' OR value LIKE 'e:%') THEN NULL
    WHEN regexp_replace(value,'[^0-9]','','g') ~ '^01[0-9]{9}$' THEN '+880'||substr(regexp_replace(value,'[^0-9]','','g'),2)
    WHEN regexp_replace(value,'[^0-9]','','g') ~ '^1[0-9]{9}$' THEN '+880'||regexp_replace(value,'[^0-9]','','g')
    WHEN btrim(value) LIKE '00%' THEN '+'||substr(regexp_replace(value,'[^0-9]','','g'),3)
    ELSE '+'||regexp_replace(value,'[^0-9]','','g') END
$$;
-- A normalized mobile only counts as a login if it is a real E.164 number; junk values
-- ("N/A", "123", "+") must not be treated as logins or used to link accounts together.
CREATE FUNCTION valid_login_mobile(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN normalize_login_mobile(value) ~ '^\+[1-9][0-9]{6,14}$' THEN normalize_login_mobile(value) END
$$;

-- Quota triggers are replaced below; drop them first so the cleanup can't trip them.
DROP TRIGGER users_quota_lock ON users;
DROP TRIGGER users_quota_guard ON users;

-- Resolve duplicate mobiles across separate (unlinked) accounts by LINKING them, not deleting:
-- one account per number becomes the identity root, the others become its tenant accounts.
-- Their tenant memberships, sessions and history are kept; login uses the root's credentials.
-- Groups that would put two accounts of one identity in the same tenant are left alone and
-- reported by the guard below.
DO $$
DECLARE g record; root text; n int := 0;
BEGIN
  FOR g IN
    SELECT valid_login_mobile(mobile) AS mob, array_agg(id ORDER BY (password_hash IS NOT NULL) DESC, last_login_at DESC NULLS LAST, created_at, id) AS ids
    FROM users WHERE identity_root_id IS NULL AND valid_login_mobile(mobile) IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  LOOP
    -- skip if the merged identity would have two accounts in one tenant
    CONTINUE WHEN EXISTS (SELECT 1 FROM users WHERE COALESCE(identity_root_id,id) = ANY(g.ids)
                          GROUP BY tenant_id HAVING count(*) > 1);
    root := g.ids[1];
    -- re-point existing children of the losing roots, then link the losing roots themselves
    UPDATE users SET identity_root_id = root WHERE identity_root_id = ANY(g.ids[2:]);
    UPDATE users SET identity_root_id = root WHERE id = ANY(g.ids[2:]);
    -- linked accounts must not carry their own conflicting credentials/contacts
    UPDATE users c SET password_hash = NULL FROM users r
      WHERE c.identity_root_id = root AND r.id = root AND c.password_hash IS DISTINCT FROM r.password_hash;
    UPDATE users c SET email = NULL FROM users r
      WHERE c.identity_root_id = root AND r.id = root
        AND NULLIF(lower(btrim(c.email)),'') IS DISTINCT FROM NULLIF(lower(btrim(r.email)),'');
    UPDATE app_guide_requests SET identity_user_id = root WHERE identity_user_id = ANY(g.ids[2:]);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'linked % duplicate-mobile groups', n;
END $$;

-- Resolve duplicate emails across separate accounts. A shared email does not prove a shared
-- person (families/offices share inboxes), so accounts that have their own mobile stay separate
-- and just lose the duplicate email (they keep logging in by mobile). Accounts whose ONLY login
-- is that email are linked to the primary account, since that email is already their sole login.
DO $$
DECLARE g record; root text; acc text; n int := 0;
BEGIN
  FOR g IN
    SELECT lower(btrim(email)) AS em,
           array_agg(id ORDER BY (password_hash IS NOT NULL) DESC, last_login_at DESC NULLS LAST, created_at, id) AS ids
    FROM users WHERE identity_root_id IS NULL AND NULLIF(lower(btrim(email)),'') IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  LOOP
    root := g.ids[1];
    -- email-only duplicates: link to root (one at a time) unless that would put two
    -- accounts of the same identity in one tenant
    FOREACH acc IN ARRAY g.ids[2:] LOOP
      CONTINUE WHEN (SELECT valid_login_mobile(mobile) FROM users WHERE id = acc) IS NOT NULL;
      CONTINUE WHEN EXISTS (SELECT 1 FROM users a JOIN users b ON a.tenant_id = b.tenant_id
                            WHERE COALESCE(a.identity_root_id,a.id) = root AND COALESCE(b.identity_root_id,b.id) = acc);
      UPDATE users SET identity_root_id = root WHERE identity_root_id = acc;
      UPDATE users SET identity_root_id = root WHERE id = acc;
    END LOOP;
    UPDATE app_guide_requests a SET identity_user_id = root FROM users c
      WHERE c.id = a.identity_user_id AND c.identity_root_id = root;
    UPDATE users c SET password_hash = NULL FROM users r
      WHERE c.identity_root_id = root AND r.id = root AND c.password_hash IS DISTINCT FROM r.password_hash;
    -- duplicates that have their own mobile: keep them separate, drop the shared email
    UPDATE users SET email = NULL
      WHERE id = ANY(g.ids[2:]) AND identity_root_id IS NULL AND valid_login_mobile(mobile) IS NOT NULL;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'resolved % duplicate-email groups', n;
END $$;

-- Accounts left with no usable login (no email, no valid mobile) are kept with all their data;
-- they get a reserved, undeliverable placeholder email (RFC 2606 ".invalid") so the new users
-- table's contact constraint holds. An admin can set a real email/mobile for them later.
UPDATE users SET email = 'no-login+' || lower(id) || '@fundledger.invalid'
WHERE identity_root_id IS NULL AND valid_login_mobile(mobile) IS NULL AND NULLIF(btrim(email),'') IS NULL;

-- Only authenticated explicit identity links are eligible for consolidation.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.id, ', ') INTO bad FROM (SELECT c.id FROM users c LEFT JOIN users r ON r.id=c.identity_root_id
    WHERE c.identity_root_id IS NOT NULL AND (r.id IS NULL OR r.identity_root_id IS NOT NULL) ORDER BY c.id LIMIT 50) c;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: invalid/nested identity links (account ids: %)', bad;
  END IF;
  SELECT string_agg(g, '; ') INTO bad FROM (SELECT tenant_id||': '||string_agg(id, ',') AS g FROM users
    GROUP BY COALESCE(identity_root_id,id),tenant_id HAVING count(*)>1 ORDER BY 1 LIMIT 50) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: multiple accounts for an identity within a tenant (%)', bad;
  END IF;
  SELECT string_agg(g, '; ') INTO bad FROM (SELECT 'child '||c.id||' root '||r.id AS g FROM users c JOIN users r ON r.id=c.identity_root_id WHERE
      (NULLIF(lower(btrim(c.email)),'') IS NOT NULL AND NULLIF(lower(btrim(c.email)),'') IS DISTINCT FROM NULLIF(lower(btrim(r.email)),'')) OR
      (valid_login_mobile(c.mobile) IS NOT NULL AND valid_login_mobile(c.mobile) IS DISTINCT FROM valid_login_mobile(r.mobile)) OR
      (c.password_hash IS NOT NULL AND c.password_hash IS DISTINCT FROM r.password_hash) ORDER BY 1 LIMIT 50) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: linked accounts have conflicting login contacts or credentials (%)', bad;
  END IF;
  SELECT string_agg(g, '; ') INTO bad FROM (
    SELECT 'email '||lower(btrim(email))||': '||string_agg(id, ',') AS g FROM users WHERE identity_root_id IS NULL AND NULLIF(lower(btrim(email)),'') IS NOT NULL GROUP BY lower(btrim(email)) HAVING count(*)>1
    UNION ALL
    SELECT 'mobile '||valid_login_mobile(mobile)||': '||string_agg(id, ',') FROM users WHERE identity_root_id IS NULL AND valid_login_mobile(mobile) IS NOT NULL GROUP BY valid_login_mobile(mobile) HAVING count(*)>1
    ORDER BY 1 LIMIT 50) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: duplicate contacts across unlinked identities (%); run scripts/audit-user-identities.mjs', bad;
  END IF;
  SELECT string_agg(id, ', ') INTO bad FROM (SELECT id FROM users WHERE identity_root_id IS NULL AND
      ((valid_login_mobile(mobile) IS NULL AND NULLIF(btrim(email),'') IS NULL) OR
       (valid_login_mobile(mobile) IS NOT NULL AND valid_login_mobile(mobile) !~ '^\+[1-9][0-9]{6,14}$')) ORDER BY id LIMIT 50) x;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'IDENTITY_MIGRATION_BLOCKED: invalid or missing login contact (account ids: %)', bad;
  END IF;
END $$;

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
SELECT id,name,NULLIF(lower(btrim(email)),''),valid_login_mobile(mobile),password_hash,is_active,created_at,updated_at
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
DROP FUNCTION valid_login_mobile(text);
