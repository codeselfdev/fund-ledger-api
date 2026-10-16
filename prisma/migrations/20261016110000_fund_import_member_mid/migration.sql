ALTER TABLE "members" ADD COLUMN "mid" TEXT;
DROP INDEX IF EXISTS "members_tenant_id_project_id_mobile_key";
CREATE INDEX "members_tenant_id_project_id_mobile_idx" ON "members"("tenant_id", "project_id", "mobile");
CREATE UNIQUE INDEX "members_tenant_id_project_id_mid_key" ON "members"("tenant_id", "project_id", "mid");
