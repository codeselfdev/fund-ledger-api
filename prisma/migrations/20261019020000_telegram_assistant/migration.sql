ALTER TABLE "telegram_links"
  ADD COLUMN "target_chat_id" TEXT,
  ADD COLUMN "sender_id" TEXT,
  ADD COLUMN "sender_name" TEXT;
CREATE TABLE "telegram_bot_identities" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "telegram_user_id" TEXT NOT NULL,
  "display_name" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "telegram_bot_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "telegram_bot_identities_project_id_user_id_key" ON "telegram_bot_identities"("project_id", "user_id");
CREATE UNIQUE INDEX "telegram_bot_identities_project_id_telegram_user_id_key" ON "telegram_bot_identities"("project_id", "telegram_user_id");
ALTER TABLE "telegram_bot_identities" ADD CONSTRAINT "telegram_bot_identities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
