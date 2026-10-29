-- Read-only. Lists every reason 20261030020000_global_users_and_tenant_memberships would fail.
WITH u AS (
  SELECT id, tenant_id, identity_root_id, password_hash,
         NULLIF(lower(btrim(email)),'') AS em,
         CASE WHEN mobile IS NULL OR btrim(mobile)='' OR mobile LIKE 'g:%' OR mobile LIKE 'e:%' THEN NULL
              WHEN regexp_replace(mobile,'[^0-9]','','g') ~ '^01[0-9]{9}$' THEN '+880'||substr(regexp_replace(mobile,'[^0-9]','','g'),2)
              WHEN regexp_replace(mobile,'[^0-9]','','g') ~ '^1[0-9]{9}$' THEN '+880'||regexp_replace(mobile,'[^0-9]','','g')
              WHEN btrim(mobile) LIKE '00%' THEN '+'||substr(regexp_replace(mobile,'[^0-9]','','g'),3)
              ELSE '+'||regexp_replace(mobile,'[^0-9]','','g') END AS mob,
         email AS raw_email, mobile AS raw_mobile
  FROM users)
SELECT '1 invalid/nested identity link' AS problem, c.id AS detail FROM u c LEFT JOIN u r ON r.id=c.identity_root_id
  WHERE c.identity_root_id IS NOT NULL AND (r.id IS NULL OR r.identity_root_id IS NOT NULL)
UNION ALL
SELECT '2 multiple accounts per identity in one tenant', tenant_id||' / root '||COALESCE(identity_root_id,id)||' : '||string_agg(id,', ')
  FROM u GROUP BY COALESCE(identity_root_id,id), tenant_id HAVING count(*)>1
UNION ALL
SELECT '3 linked account conflicts with root', 'child '||c.id||' root '||r.id||
       CASE WHEN c.em IS NOT NULL AND c.em IS DISTINCT FROM r.em THEN ' [email]' ELSE '' END||
       CASE WHEN c.mob IS NOT NULL AND c.mob IS DISTINCT FROM r.mob THEN ' [mobile]' ELSE '' END||
       CASE WHEN c.password_hash IS NOT NULL AND c.password_hash IS DISTINCT FROM r.password_hash THEN ' [password]' ELSE '' END
  FROM u c JOIN u r ON r.id=c.identity_root_id
  WHERE (c.em IS NOT NULL AND c.em IS DISTINCT FROM r.em) OR (c.mob IS NOT NULL AND c.mob IS DISTINCT FROM r.mob)
     OR (c.password_hash IS NOT NULL AND c.password_hash IS DISTINCT FROM r.password_hash)
UNION ALL
SELECT '4a duplicate email across unlinked users', em||' : '||string_agg(id||'@'||tenant_id,', ')
  FROM u WHERE identity_root_id IS NULL AND em IS NOT NULL GROUP BY em HAVING count(*)>1
UNION ALL
SELECT '4b duplicate mobile across unlinked users', mob||' : '||string_agg(id||'@'||tenant_id,', ')
  FROM u WHERE identity_root_id IS NULL AND mob IS NOT NULL GROUP BY mob HAVING count(*)>1
UNION ALL
SELECT '5 missing/invalid login contact', id||' email='||COALESCE(raw_email,'∅')||' mobile='||COALESCE(raw_mobile,'∅')
  FROM u WHERE identity_root_id IS NULL AND ((mob IS NULL AND em IS NULL) OR (mob IS NOT NULL AND mob !~ '^\+[1-9][0-9]{6,14}$'))
UNION ALL
SELECT '6 schema object missing/clashing', x FROM (VALUES
  (CASE WHEN NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='users_quota_lock') THEN 'trigger users_quota_lock missing' END),
  (CASE WHEN NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='users_quota_guard') THEN 'trigger users_quota_guard missing' END),
  (CASE WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_identity_root_id_fkey') THEN 'constraint users_identity_root_id_fkey missing' END),
  (CASE WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='app_guide_requests_identity_user_id_fkey') THEN 'constraint app_guide_requests_identity_user_id_fkey missing' END),
  (CASE WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_tenant_id_fkey') THEN 'constraint users_tenant_id_fkey missing' END),
  (CASE WHEN to_regclass('users_identity_root_id_idx') IS NULL THEN 'index users_identity_root_id_idx missing' END),
  (CASE WHEN to_regclass('users_tenant_id_mobile_key') IS NULL THEN 'index users_tenant_id_mobile_key missing' END),
  (CASE WHEN to_regclass('tenant_users') IS NOT NULL THEN 'table tenant_users already exists' END),
  (CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname IN ('normalize_login_mobile','check_account_tenant')) THEN 'function normalize_login_mobile/check_account_tenant already exists' END),
  (CASE WHEN EXISTS (SELECT 1 FROM pg_views WHERE definition ~ '\musers\M' AND schemaname='public') THEN 'a view depends on users' END)
) v(x) WHERE x IS NOT NULL
ORDER BY 1, 2;
