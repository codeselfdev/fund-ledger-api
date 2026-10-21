CREATE TABLE "billing_complaints" (
 "id" TEXT NOT NULL PRIMARY KEY, "tenant_id" TEXT NOT NULL, "project_id" TEXT NOT NULL, "customer_id" TEXT NOT NULL,
 "category" TEXT NOT NULL, "description" TEXT NOT NULL, "urgent" BOOLEAN NOT NULL DEFAULT false,
 "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open','progress','resolved')),
 "assigned_to" TEXT, "resolved_at" TIMESTAMP(3), "request_key" TEXT NOT NULL, "request_hash" TEXT NOT NULL,
 "created_by_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "billing_complaints_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "billing_complaints_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "billing_complaints_project_id_request_key_key" ON "billing_complaints"("project_id", "request_key");
CREATE INDEX "billing_complaints_tenant_id_project_id_status_urgent_created_idx" ON "billing_complaints"("tenant_id", "project_id", "status", "urgent", "created_at");
