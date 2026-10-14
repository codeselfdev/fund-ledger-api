-- Additive: legacy cash and bank accounts retain their balances and identity.
ALTER TABLE "accounts"
  ADD COLUMN "bank_name" TEXT,
  ADD COLUMN "account_name" TEXT,
  ADD COLUMN "account_number" TEXT,
  ADD COLUMN "branch_name" TEXT;
