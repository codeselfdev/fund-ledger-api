-- Business date is separate from immutable posting and payment timestamps.
ALTER TABLE "expenses"
  ADD COLUMN "expense_date" DATE,
  ADD COLUMN "vendor_phone" TEXT;

-- Prisma timestamp columns contain UTC values. Preserve the previous Dhaka
-- calendar date used by the expense charts, including midnight boundaries.
UPDATE "expenses"
SET "expense_date" = (COALESCE("paid_at", "created_at") AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka')::date;

UPDATE "expenses" AS e
SET "vendor_phone" = v."phone"
FROM "vendors" AS v
WHERE e."vendor_id" = v."id"
  AND e."tenant_id" = v."tenant_id"
  AND e."project_id" = v."project_id";
