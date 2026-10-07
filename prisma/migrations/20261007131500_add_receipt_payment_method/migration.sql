ALTER TABLE "receipts" ADD COLUMN "method" "PaymentMethod";

UPDATE "receipts" AS receipt
SET "method" = deposit."method"
FROM "deposits" AS deposit
WHERE receipt."deposit_id" = deposit."id";

ALTER TABLE "receipts" ALTER COLUMN "method" SET NOT NULL;
