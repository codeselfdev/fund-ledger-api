-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "document_prefix" VARCHAR(3),
ADD COLUMN     "document_prefix_revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "document_settings" JSONB;

-- AlterTable
ALTER TABLE "business_documents" ADD COLUMN     "presentation_snapshot" JSONB,
ADD COLUMN     "referrer_id" TEXT,
ADD COLUMN     "referrer_snapshot" JSONB,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "document_number_sequences" (
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL,

    CONSTRAINT "document_number_sequences_pkey" PRIMARY KEY ("tenant_id","kind","period")
);

-- AddForeignKey
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "contact_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_number_sequences" ADD CONSTRAINT "document_number_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

