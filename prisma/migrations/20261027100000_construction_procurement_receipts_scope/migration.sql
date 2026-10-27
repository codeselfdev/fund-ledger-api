-- AlterTable
ALTER TABLE "purchases" ADD COLUMN     "construction_cost_head_id" TEXT,
ADD COLUMN     "construction_managed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "construction_required_by" DATE;

-- AlterTable
ALTER TABLE "construction_supplier_bills" ADD COLUMN     "procurement_invoice_id" TEXT;

-- AlterTable
ALTER TABLE "construction_change_orders" ADD COLUMN     "scope_change_id" TEXT;

-- AlterTable
ALTER TABLE "construction_control_versions" ADD COLUMN     "scope_change_id" TEXT;

-- CreateTable
CREATE TABLE "construction_requisitions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "cost_head_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "required_by" DATE NOT NULL,
    "urgency" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "approver_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_requisitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_supplier_quotes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "charges" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "delivery_date" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "terms" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_supplier_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_procurement_awards" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "requisition_id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "purchase_id" TEXT,
    "location_id" TEXT,
    "note" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_procurement_awards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_deliveries" (
    "revision" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "challan_number" TEXT NOT NULL,
    "delivery_date" DATE NOT NULL,
    "location_id" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "checkedLines" JSONB,
    "evidence" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_purchase_invoices" (
    "revision" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "purchase_id" TEXT NOT NULL,
    "supplier_bill_id" TEXT,
    "number" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "lines" JSONB NOT NULL,
    "charges" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_purchase_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_scope_changes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "cost_head_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "approver_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "created_by_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_scope_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "construction_requisitions_tenant_id_project_id_idx" ON "construction_requisitions"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_requisitions_project_id_request_key_key" ON "construction_requisitions"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_supplier_quotes_tenant_id_project_id_idx" ON "construction_supplier_quotes"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_supplier_quotes_project_id_request_key_key" ON "construction_supplier_quotes"("project_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "construction_supplier_quotes_project_id_requisition_id_vend_key" ON "construction_supplier_quotes"("project_id", "requisition_id", "vendor_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "construction_procurement_awards_purchase_id_key" ON "construction_procurement_awards"("purchase_id");

-- CreateIndex
CREATE INDEX "construction_procurement_awards_tenant_id_project_id_idx" ON "construction_procurement_awards"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_procurement_awards_project_id_request_key_key" ON "construction_procurement_awards"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_deliveries_tenant_id_project_id_idx" ON "construction_deliveries"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_deliveries_project_id_request_key_key" ON "construction_deliveries"("project_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "construction_delivery_revision_key" ON "construction_deliveries"("project_id", "purchase_id", "challan_number", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "construction_purchase_invoices_supplier_bill_id_key" ON "construction_purchase_invoices"("supplier_bill_id");

-- CreateIndex
CREATE INDEX "construction_purchase_invoices_tenant_id_project_id_idx" ON "construction_purchase_invoices"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_purchase_invoices_project_id_request_key_key" ON "construction_purchase_invoices"("project_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "construction_invoice_revision_key" ON "construction_purchase_invoices"("project_id", "purchase_id", "number", "revision");

-- CreateIndex
CREATE INDEX "construction_scope_changes_tenant_id_project_id_idx" ON "construction_scope_changes"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_scope_changes_project_id_request_key_key" ON "construction_scope_changes"("project_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "construction_supplier_bills_procurement_invoice_id_key" ON "construction_supplier_bills"("procurement_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_change_orders_scope_change_id_key" ON "construction_change_orders"("scope_change_id");

-- AddForeignKey
ALTER TABLE "construction_requisitions" ADD CONSTRAINT "construction_requisitions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_supplier_quotes" ADD CONSTRAINT "construction_supplier_quotes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_procurement_awards" ADD CONSTRAINT "construction_procurement_awards_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_deliveries" ADD CONSTRAINT "construction_deliveries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_purchase_invoices" ADD CONSTRAINT "construction_purchase_invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_scope_changes" ADD CONSTRAINT "construction_scope_changes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE construction_requisitions ADD CONSTRAINT construction_requisitions_review_check CHECK (status IN ('pending','approved','rejected','ordered') AND approver_id<>created_by_id AND (decided_by_id IS NULL OR (decided_by_id=approver_id AND decided_by_id<>created_by_id)));

ALTER TABLE construction_procurement_awards ADD CONSTRAINT construction_procurement_awards_review_check CHECK (status IN ('pending','approved','rejected') AND approver_id<>created_by_id AND (decided_by_id IS NULL OR (decided_by_id=approver_id AND decided_by_id<>created_by_id)));

ALTER TABLE construction_deliveries ADD CONSTRAINT construction_deliveries_review_check CHECK (status IN ('pending','approved','rejected') AND approver_id<>created_by_id AND (decided_by_id IS NULL OR (decided_by_id=approver_id AND decided_by_id<>created_by_id)));

ALTER TABLE construction_purchase_invoices ADD CONSTRAINT construction_purchase_invoices_review_check CHECK (status IN ('pending','approved','rejected') AND approver_id<>created_by_id AND (decided_by_id IS NULL OR (decided_by_id=approver_id AND decided_by_id<>created_by_id)));

ALTER TABLE construction_scope_changes ADD CONSTRAINT construction_scope_changes_review_check CHECK (status IN ('pending','approved','rejected') AND approver_id<>created_by_id AND (decided_by_id IS NULL OR (decided_by_id=approver_id AND decided_by_id<>created_by_id)));

ALTER TABLE construction_requisitions ADD CONSTRAINT construction_requisition_urgency CHECK (urgency IN ('routine','urgent','critical'));
ALTER TABLE construction_supplier_quotes ADD CONSTRAINT construction_quote_amount CHECK (charges>=0 AND total>=charges);
ALTER TABLE construction_purchase_invoices ADD CONSTRAINT construction_invoice_amount CHECK (charges>=0 AND amount>=charges);
ALTER TABLE purchases ADD CONSTRAINT construction_purchase_head_check CHECK (NOT construction_managed OR (construction_cost_head_id IS NOT NULL AND vendor_id IS NOT NULL));
