-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "commerce_settings" JSONB;

-- AlterTable
ALTER TABLE "account_transactions" ADD COLUMN     "income_source" TEXT,
ADD COLUMN     "occurred_on" TIMESTAMP(3),
ADD COLUMN     "request_key" TEXT;

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT,
    "email" TEXT,
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_documents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_snapshot" JSONB NOT NULL,
    "kind" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "lines" JSONB NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "tax" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "paid_amount" INTEGER NOT NULL DEFAULT 0,
    "document_date" TIMESTAMP(3) NOT NULL,
    "due_date" TIMESTAMP(3),
    "note" TEXT,
    "workflow" JSONB NOT NULL,
    "events" JSONB NOT NULL,
    "source_id" TEXT,
    "request_key" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "payment_date" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "request_key" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_tenant_id_project_id_is_active_idx" ON "customers"("tenant_id", "project_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "business_documents_source_id_key" ON "business_documents"("source_id");

-- CreateIndex
CREATE INDEX "business_documents_tenant_id_project_id_kind_status_idx" ON "business_documents"("tenant_id", "project_id", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "business_documents_project_id_request_key_key" ON "business_documents"("project_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "business_documents_project_id_number_key" ON "business_documents"("project_id", "number");

-- CreateIndex
CREATE INDEX "business_payments_tenant_id_project_id_document_id_idx" ON "business_payments"("tenant_id", "project_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_payments_project_id_request_key_key" ON "business_payments"("project_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "account_transactions_project_id_request_key_key" ON "account_transactions"("project_id", "request_key");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_documents" ADD CONSTRAINT "business_documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "business_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_payments" ADD CONSTRAINT "business_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_payments" ADD CONSTRAINT "business_payments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "business_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "account_transactions" ADD COLUMN     "income_category_id" TEXT,
ADD COLUMN     "income_customer_id" TEXT;

-- CreateTable
CREATE TABLE "income_categories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "income_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "income_categories_tenant_id_project_id_is_active_idx" ON "income_categories"("tenant_id", "project_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "income_categories_project_id_name_key" ON "income_categories"("project_id", "name");

-- AddForeignKey
ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_income_category_id_fkey" FOREIGN KEY ("income_category_id") REFERENCES "income_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_income_customer_id_fkey" FOREIGN KEY ("income_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_categories" ADD CONSTRAINT "income_categories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
