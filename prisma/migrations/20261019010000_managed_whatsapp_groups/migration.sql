ALTER TABLE "whatsapp_connections"
  ADD COLUMN "managed_by_fund_nesta" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "group_setup_status" TEXT,
  ADD COLUMN "group_setup_error" TEXT,
  ADD COLUMN "group_create_request_id" TEXT,
  ADD COLUMN "group_invite_link" TEXT;
CREATE UNIQUE INDEX "whatsapp_connections_group_create_request_id_key" ON "whatsapp_connections"("group_create_request_id");
CREATE TABLE "whatsapp_group_creation_events" (
  "id" TEXT NOT NULL,
  "waba_id" TEXT NOT NULL,
  "phone_number_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "group_id" TEXT,
  "invite_link" TEXT,
  "failed" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_group_creation_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "wa_group_creation_event_route_request_key" ON "whatsapp_group_creation_events"("waba_id", "phone_number_id", "request_id");
