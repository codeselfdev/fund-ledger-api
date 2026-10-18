ALTER TABLE "users"
  ADD COLUMN "last_login_at" TIMESTAMP(3),
  ADD COLUMN "last_login_platform" TEXT,
  ADD COLUMN "last_active_at" TIMESTAMP(3);

CREATE TABLE "sms_daily_usage" (
  "scope" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0 CHECK ("count" BETWEEN 0 AND 2),
  CONSTRAINT "sms_daily_usage_pkey" PRIMARY KEY ("scope", "day")
);
