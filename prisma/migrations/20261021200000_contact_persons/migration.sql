-- AlterTable
ALTER TABLE "business_documents" ADD COLUMN     "quotation_person_id" TEXT,
ADD COLUMN     "quotation_person_snapshot" JSONB;

-- CreateTable
CREATE TABLE "contact_persons" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT,
    "mobile" TEXT,
    "email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contact_persons" (
    "customer_id" TEXT NOT NULL,
    "contact_person_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,

    CONSTRAINT "customer_contact_persons_pkey" PRIMARY KEY ("customer_id","contact_person_id")
);

-- CreateTable
CREATE TABLE "dealer_contact_persons" (
    "dealer_id" TEXT NOT NULL,
    "contact_person_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,

    CONSTRAINT "dealer_contact_persons_pkey" PRIMARY KEY ("dealer_id","contact_person_id")
);

-- CreateIndex
CREATE INDEX "contact_persons_tenant_id_project_id_is_active_name_idx" ON "contact_persons"("tenant_id", "project_id", "is_active", "name");

-- CreateIndex
CREATE INDEX "customer_contact_persons_tenant_id_project_id_contact_perso_idx" ON "customer_contact_persons"("tenant_id", "project_id", "contact_person_id");

-- CreateIndex
CREATE INDEX "dealer_contact_persons_tenant_id_project_id_contact_person__idx" ON "dealer_contact_persons"("tenant_id", "project_id", "contact_person_id");

-- AddForeignKey
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_quotation_person_id_fkey" FOREIGN KEY ("quotation_person_id") REFERENCES "contact_persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_persons" ADD CONSTRAINT "contact_persons_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact_persons" ADD CONSTRAINT "customer_contact_persons_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contact_persons" ADD CONSTRAINT "customer_contact_persons_contact_person_id_fkey" FOREIGN KEY ("contact_person_id") REFERENCES "contact_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_contact_persons" ADD CONSTRAINT "dealer_contact_persons_dealer_id_fkey" FOREIGN KEY ("dealer_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dealer_contact_persons" ADD CONSTRAINT "dealer_contact_persons_contact_person_id_fkey" FOREIGN KEY ("contact_person_id") REFERENCES "contact_persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

