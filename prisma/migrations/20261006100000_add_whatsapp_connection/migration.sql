CREATE TABLE "whatsapp_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "waba_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "display_phone_number" TEXT,
    "verified_name" TEXT,
    "graph_api_version" TEXT NOT NULL DEFAULT 'v22.0',
    "encrypted_access_token" TEXT NOT NULL,
    "group_id" TEXT,
    "group_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_verified_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_connections_project_id_key" ON "whatsapp_connections"("project_id");
CREATE INDEX "whatsapp_connections_tenant_id_project_id_idx" ON "whatsapp_connections"("tenant_id", "project_id");

ALTER TABLE "whatsapp_connections"
ADD CONSTRAINT "whatsapp_connections_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
