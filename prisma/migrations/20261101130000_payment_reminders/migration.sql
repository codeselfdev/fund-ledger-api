-- Automatic payment reminders: project settings and per-deadline rules.
-- Additive only; automatic sends reuse member_reminders so one reminder a day includes manual Remind.
ALTER TABLE "member_reminders" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE "payment_reminder_settings" (
  "project_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "preferred_time" TEXT NOT NULL DEFAULT '10:00',
  "sending_days" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 6]::INTEGER[],
  "off_day_rule" TEXT NOT NULL DEFAULT 'before',
  "treat_holidays" BOOLEAN NOT NULL DEFAULT true,
  "pause_for_promises" BOOLEAN NOT NULL DEFAULT true,
  "updated_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_reminder_settings_pkey" PRIMARY KEY ("project_id"),
  CONSTRAINT "payment_reminder_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payment_reminder_settings_time_check" CHECK ("preferred_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "payment_reminder_settings_off_day_check" CHECK ("off_day_rule" IN ('before', 'after', 'skip'))
);
CREATE INDEX "payment_reminder_settings_enabled_idx" ON "payment_reminder_settings"("enabled");

CREATE TABLE "payment_reminder_rules" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "days" INTEGER NOT NULL DEFAULT 0,
  "own_time" TEXT,
  "repeat_every" INTEGER,
  "repeat_count" INTEGER,
  "message" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_reminder_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_reminder_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "payment_reminder_rules_kind_check" CHECK ("kind" IN ('before', 'due', 'after')),
  CONSTRAINT "payment_reminder_rules_days_check" CHECK (("kind" = 'due' AND "days" = 0) OR ("kind" <> 'due' AND "days" BETWEEN 1 AND 60)),
  CONSTRAINT "payment_reminder_rules_time_check" CHECK ("own_time" IS NULL OR "own_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "payment_reminder_rules_repeat_check" CHECK (("repeat_every" IS NULL AND "repeat_count" IS NULL) OR ("kind" = 'after' AND "repeat_every" BETWEEN 1 AND 30 AND "repeat_count" BETWEEN 2 AND 10)),
  CONSTRAINT "payment_reminder_rules_message_check" CHECK (char_length("message") BETWEEN 1 AND 240)
);
CREATE UNIQUE INDEX "payment_reminder_rules_project_id_kind_days_key" ON "payment_reminder_rules"("project_id", "kind", "days");
CREATE INDEX "payment_reminder_rules_tenant_id_project_id_idx" ON "payment_reminder_rules"("tenant_id", "project_id");
