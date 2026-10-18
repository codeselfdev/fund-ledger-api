CREATE TABLE "subscription_payment_receipts" (
 "id" TEXT PRIMARY KEY,
 "tenant_id" TEXT NOT NULL,
 "invoice_id" TEXT NOT NULL,
 "user_id" TEXT NOT NULL,
 "file_name" TEXT NOT NULL,
 "mime_type" TEXT NOT NULL CHECK ("mime_type" IN ('image/jpeg','image/png','image/webp','application/pdf')),
 "size" INTEGER NOT NULL CHECK ("size" BETWEEN 1 AND 5000000),
 "content_hash" TEXT NOT NULL,
 "storage_key" TEXT NOT NULL,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "subscription_payment_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "subscription_payment_receipts_storage_key_key" ON "subscription_payment_receipts"("storage_key");
CREATE INDEX "subscription_payment_receipts_tenant_id_invoice_id_idx" ON "subscription_payment_receipts"("tenant_id","invoice_id");

-- Existing outstanding requests also need a control-room alert. They remain unapproved.
INSERT INTO platform_alerts(id,tenant_id,user_id,kind,event_key)
SELECT gen_random_uuid()::text,t.id,a.actor_user_id,'billing_upgrade','billing_upgrade:'||(i->>'id')
FROM tenants t
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.contact->'billing'->'invoices')='array' THEN t.contact->'billing'->'invoices' ELSE '[]'::jsonb END) i
JOIN LATERAL (SELECT actor_user_id FROM activity WHERE tenant_id=t.id AND entity_id=i->>'id' AND action='subscription.package_requested' ORDER BY created_at DESC LIMIT 1) a ON true
WHERE i->>'status' IN ('open','submitted') AND i->>'id' IS NOT NULL
ON CONFLICT (event_key) DO NOTHING;
INSERT INTO platform_alerts(id,tenant_id,user_id,kind,event_key)
SELECT gen_random_uuid()::text,t.id,a.actor_user_id,'billing_payment','billing_payment:'||(i->>'id')||':'||COALESCE(i->>'payment_request_key','legacy')
FROM tenants t
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.contact->'billing'->'invoices')='array' THEN t.contact->'billing'->'invoices' ELSE '[]'::jsonb END) i
LEFT JOIN LATERAL (SELECT actor_user_id FROM activity WHERE tenant_id=t.id AND entity_id=i->>'id' AND action='subscription.payment_submitted' ORDER BY created_at DESC LIMIT 1) a ON true
WHERE i->>'status'='submitted' AND i->>'id' IS NOT NULL
ON CONFLICT (event_key) DO NOTHING;
