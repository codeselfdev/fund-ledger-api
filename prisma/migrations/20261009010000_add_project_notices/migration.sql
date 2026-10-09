CREATE TABLE "project_notices" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "image_file_id" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_notices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "project_notices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "project_notices_tenant_id_project_id_expires_at_deleted_at_idx" ON "project_notices"("tenant_id", "project_id", "expires_at", "deleted_at");
-- Preserve prior project-wide manual announcements in notice history. Scoped broadcasts remain notifications.
INSERT INTO "project_notices" ("id", "tenant_id", "project_id", "title", "body", "expires_at", "created_by_id", "created_at", "updated_at")
SELECT 'legacy_' || md5(jsonb_build_array(n.tenant_id, n.project_id, n.actor_user_id, n.title, n.body, n.created_at)::text),
  n.tenant_id, n.project_id, n.title, n.body, n.created_at + interval '7 days', n.actor_user_id, n.created_at, n.created_at
FROM "notifications" n
WHERE n.type = 'announcement.manual' AND n.entity_type = 'announcement' AND n.project_id IS NOT NULL AND n.actor_user_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM activity a WHERE a.action = 'notification.broadcasted' AND a.project_id = n.project_id AND a.tenant_id = n.tenant_id AND a.actor_user_id = n.actor_user_id
    AND a.after->>'title' = n.title AND a.created_at BETWEEN n.created_at - interval '10 seconds' AND n.created_at + interval '5 minutes'
    AND COALESCE(jsonb_array_length(a.after->'target_roles'), 0) = 0 AND COALESCE(jsonb_array_length(a.after->'target_member_ids'), 0) = 0)
GROUP BY n.tenant_id, n.project_id, n.title, n.body, n.actor_user_id, n.created_at;
