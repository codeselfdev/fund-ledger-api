ALTER TABLE "sessions"
  ADD COLUMN "verified_email" TEXT,
  ADD COLUMN "impersonator_user_id" TEXT,
  ADD COLUMN "impersonator_session_id" TEXT,
  ADD COLUMN "impersonation_reason" TEXT,
  ADD COLUMN "impersonation_policy_hash" TEXT;
CREATE INDEX "sessions_impersonator_session_id_idx" ON "sessions"("impersonator_session_id");
