CREATE TABLE "project_roles" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL, "name_key" TEXT NOT NULL, "description" TEXT NOT NULL DEFAULT '',
  "permissions" JSONB NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_roles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "project_roles_project_id_name_key_key" ON "project_roles"("project_id", "name_key");
CREATE INDEX "project_roles_tenant_id_project_id_idx" ON "project_roles"("tenant_id", "project_id");
ALTER TABLE "project_memberships" ADD COLUMN "custom_role_id" TEXT;
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_custom_role_id_fkey" FOREIGN KEY ("custom_role_id") REFERENCES "project_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
