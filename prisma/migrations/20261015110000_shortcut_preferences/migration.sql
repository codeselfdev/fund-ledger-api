-- CreateTable
CREATE TABLE "shortcut_preferences" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "pinned" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shortcut_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shortcut_preferences_tenant_id_project_id_user_id_key" ON "shortcut_preferences"("tenant_id", "project_id", "user_id");

-- AddForeignKey
ALTER TABLE "shortcut_preferences" ADD CONSTRAINT "shortcut_preferences_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shortcut_preferences" ADD CONSTRAINT "shortcut_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep the eight-pin and revision invariants even for direct database writes.
ALTER TABLE "shortcut_preferences" ADD CONSTRAINT "shortcut_preferences_pins_check" CHECK (jsonb_typeof("pinned") = 'array' AND jsonb_array_length("pinned") <= 8);
ALTER TABLE "shortcut_preferences" ADD CONSTRAINT "shortcut_preferences_version_check" CHECK ("version" > 0);
