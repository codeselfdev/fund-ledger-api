-- App Guide voice questions and provider token accounting.
-- Credits stay per question; these columns only measure cost per channel/model.
ALTER TABLE "app_guide_requests"
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN "speech_ms" INTEGER,
  ADD COLUMN "usage_model" TEXT,
  ADD COLUMN "input_tokens" INTEGER,
  ADD COLUMN "cached_tokens" INTEGER,
  ADD COLUMN "output_tokens" INTEGER,
  ADD COLUMN "reasoning_tokens" INTEGER;
ALTER TABLE "app_guide_requests" ADD CONSTRAINT "app_guide_requests_channel_check" CHECK ("channel" IN ('text','voice'));
CREATE INDEX "app_guide_requests_created_at_channel_idx" ON "app_guide_requests"("created_at","channel");
