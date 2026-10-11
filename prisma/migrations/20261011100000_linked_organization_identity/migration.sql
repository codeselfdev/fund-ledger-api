ALTER TABLE "users" ADD COLUMN "identity_root_id" TEXT;
CREATE INDEX "users_identity_root_id_idx" ON "users"("identity_root_id");
ALTER TABLE "users" ADD CONSTRAINT "users_identity_root_id_fkey" FOREIGN KEY ("identity_root_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
