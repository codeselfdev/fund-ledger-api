-- AlterEnum
ALTER TYPE "ProjectType" ADD VALUE 'construction';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "construction_settings" JSONB;

-- CreateTable
CREATE TABLE "construction_cost_heads" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "budget" INTEGER NOT NULL,
    "revised_budget" INTEGER NOT NULL,
    "forecast_remaining" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "construction_cost_heads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_boq" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "cost_head_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "rate" INTEGER NOT NULL,
    "estimated" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "construction_boq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_cost_allocations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "expense_id" TEXT NOT NULL,
    "cost_head_id" TEXT NOT NULL,
    "boq_id" TEXT,
    "amount" INTEGER NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_cost_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_contractors" (
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

    CONSTRAINT "construction_contractors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_contracts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "contractor_id" TEXT NOT NULL,
    "cost_head_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "revised_amount" INTEGER NOT NULL,
    "retention_bps" INTEGER NOT NULL DEFAULT 500,
    "certified_amount" INTEGER NOT NULL DEFAULT 0,
    "advance_paid" INTEGER NOT NULL DEFAULT 0,
    "advance_recovered" INTEGER NOT NULL DEFAULT 0,
    "retention_held" INTEGER NOT NULL DEFAULT 0,
    "retention_released" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "construction_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_running_bills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "cumulative_certified" INTEGER NOT NULL,
    "previous_certified" INTEGER NOT NULL,
    "current_certified" INTEGER NOT NULL,
    "retention" INTEGER NOT NULL,
    "advance_recovery" INTEGER NOT NULL,
    "net_payable" INTEGER NOT NULL,
    "paid_amount" INTEGER NOT NULL DEFAULT 0,
    "bill_date" DATE NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_running_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_supplier_bills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "cost_head_id" TEXT NOT NULL,
    "boq_id" TEXT,
    "purchase_id" TEXT,
    "number" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paid_amount" INTEGER NOT NULL DEFAULT 0,
    "bill_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "received_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_supplier_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_labor_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "cost_head_id" TEXT NOT NULL,
    "worker_name" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "units" DECIMAL(18,3) NOT NULL,
    "rate" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "paid_amount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_labor_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_material_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "boq_id" TEXT,
    "kind" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "entry_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "source_id" TEXT,
    "returned_quantity" INTEGER NOT NULL DEFAULT 0,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_material_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contract_id" TEXT,
    "running_bill_id" TEXT,
    "supplier_bill_id" TEXT,
    "labor_entry_id" TEXT,
    "account_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "payment_date" DATE NOT NULL,
    "reference" TEXT,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construction_change_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "cost_head_id" TEXT,
    "contract_id" TEXT,
    "budget_change" INTEGER NOT NULL DEFAULT 0,
    "contract_change" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construction_change_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "construction_cost_heads_tenant_id_project_id_status_idx" ON "construction_cost_heads"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "construction_cost_heads_project_id_name_phase_key" ON "construction_cost_heads"("project_id", "name", "phase");

-- CreateIndex
CREATE INDEX "construction_boq_tenant_id_project_id_cost_head_id_idx" ON "construction_boq"("tenant_id", "project_id", "cost_head_id");

-- CreateIndex
CREATE INDEX "construction_cost_allocations_tenant_id_project_id_expense__idx" ON "construction_cost_allocations"("tenant_id", "project_id", "expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_cost_allocations_project_id_request_key_key" ON "construction_cost_allocations"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_contractors_tenant_id_project_id_idx" ON "construction_contractors"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "construction_contracts_tenant_id_project_id_contractor_id_idx" ON "construction_contracts"("tenant_id", "project_id", "contractor_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_contracts_project_id_request_key_key" ON "construction_contracts"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_running_bills_tenant_id_project_id_contract_id_idx" ON "construction_running_bills"("tenant_id", "project_id", "contract_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "construction_running_bills_project_id_request_key_key" ON "construction_running_bills"("project_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "construction_supplier_bills_purchase_id_key" ON "construction_supplier_bills"("purchase_id");

-- CreateIndex
CREATE INDEX "construction_supplier_bills_tenant_id_project_id_status_idx" ON "construction_supplier_bills"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "construction_supplier_bills_project_id_vendor_id_number_key" ON "construction_supplier_bills"("project_id", "vendor_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "construction_supplier_bills_project_id_request_key_key" ON "construction_supplier_bills"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_labor_entries_tenant_id_project_id_work_date_idx" ON "construction_labor_entries"("tenant_id", "project_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "construction_labor_entries_project_id_request_key_key" ON "construction_labor_entries"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_material_entries_tenant_id_project_id_item_id_idx" ON "construction_material_entries"("tenant_id", "project_id", "item_id");

-- CreateIndex
CREATE UNIQUE INDEX "construction_material_entries_project_id_request_key_key" ON "construction_material_entries"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_payments_tenant_id_project_id_kind_idx" ON "construction_payments"("tenant_id", "project_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "construction_payments_project_id_request_key_key" ON "construction_payments"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "construction_change_orders_tenant_id_project_id_status_idx" ON "construction_change_orders"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "construction_change_orders_project_id_request_key_key" ON "construction_change_orders"("project_id", "request_key");

-- AddForeignKey
ALTER TABLE "construction_cost_heads" ADD CONSTRAINT "construction_cost_heads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_boq" ADD CONSTRAINT "construction_boq_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_boq" ADD CONSTRAINT "construction_boq_cost_head_id_fkey" FOREIGN KEY ("cost_head_id") REFERENCES "construction_cost_heads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_cost_allocations" ADD CONSTRAINT "construction_cost_allocations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_cost_allocations" ADD CONSTRAINT "construction_cost_allocations_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_cost_allocations" ADD CONSTRAINT "construction_cost_allocations_cost_head_id_fkey" FOREIGN KEY ("cost_head_id") REFERENCES "construction_cost_heads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_cost_allocations" ADD CONSTRAINT "construction_cost_allocations_boq_id_fkey" FOREIGN KEY ("boq_id") REFERENCES "construction_boq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_contractors" ADD CONSTRAINT "construction_contractors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_contracts" ADD CONSTRAINT "construction_contracts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_contracts" ADD CONSTRAINT "construction_contracts_contractor_id_fkey" FOREIGN KEY ("contractor_id") REFERENCES "construction_contractors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_contracts" ADD CONSTRAINT "construction_contracts_cost_head_id_fkey" FOREIGN KEY ("cost_head_id") REFERENCES "construction_cost_heads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_running_bills" ADD CONSTRAINT "construction_running_bills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_running_bills" ADD CONSTRAINT "construction_running_bills_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "construction_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_supplier_bills" ADD CONSTRAINT "construction_supplier_bills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_supplier_bills" ADD CONSTRAINT "construction_supplier_bills_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_supplier_bills" ADD CONSTRAINT "construction_supplier_bills_cost_head_id_fkey" FOREIGN KEY ("cost_head_id") REFERENCES "construction_cost_heads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_supplier_bills" ADD CONSTRAINT "construction_supplier_bills_boq_id_fkey" FOREIGN KEY ("boq_id") REFERENCES "construction_boq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_supplier_bills" ADD CONSTRAINT "construction_supplier_bills_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_labor_entries" ADD CONSTRAINT "construction_labor_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_labor_entries" ADD CONSTRAINT "construction_labor_entries_cost_head_id_fkey" FOREIGN KEY ("cost_head_id") REFERENCES "construction_cost_heads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_material_entries" ADD CONSTRAINT "construction_material_entries_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_material_entries" ADD CONSTRAINT "construction_material_entries_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_material_entries" ADD CONSTRAINT "construction_material_entries_boq_id_fkey" FOREIGN KEY ("boq_id") REFERENCES "construction_boq"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_payments" ADD CONSTRAINT "construction_payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_payments" ADD CONSTRAINT "construction_payments_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "construction_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_payments" ADD CONSTRAINT "construction_payments_running_bill_id_fkey" FOREIGN KEY ("running_bill_id") REFERENCES "construction_running_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_payments" ADD CONSTRAINT "construction_payments_supplier_bill_id_fkey" FOREIGN KEY ("supplier_bill_id") REFERENCES "construction_supplier_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_payments" ADD CONSTRAINT "construction_payments_labor_entry_id_fkey" FOREIGN KEY ("labor_entry_id") REFERENCES "construction_labor_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_payments" ADD CONSTRAINT "construction_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_change_orders" ADD CONSTRAINT "construction_change_orders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_change_orders" ADD CONSTRAINT "construction_change_orders_cost_head_id_fkey" FOREIGN KEY ("cost_head_id") REFERENCES "construction_cost_heads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construction_change_orders" ADD CONSTRAINT "construction_change_orders_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "construction_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "construction_cost_heads" ADD CONSTRAINT "construction_budget_values" CHECK (budget >= 0 AND revised_budget >= 0 AND forecast_remaining >= 0 AND status IN ('pending','approved','rejected'));
ALTER TABLE "construction_boq" ADD CONSTRAINT "construction_boq_values" CHECK (quantity > 0 AND rate >= 0 AND estimated >= 0);
ALTER TABLE "construction_cost_allocations" ADD CONSTRAINT "construction_allocation_amount" CHECK (amount > 0);
ALTER TABLE "construction_contracts" ADD CONSTRAINT "construction_contract_values" CHECK (
 amount > 0 AND revised_amount >= certified_amount AND certified_amount >= 0 AND retention_bps BETWEEN 0 AND 10000
 AND advance_paid >= advance_recovered AND advance_recovered >= 0 AND retention_held >= retention_released AND retention_released >= 0
 AND status IN ('active','suspended','closed')
);
ALTER TABLE "construction_running_bills" ADD CONSTRAINT "construction_running_bill_values" CHECK (
 current_certified > 0 AND cumulative_certified::bigint = previous_certified::bigint + current_certified AND previous_certified >= 0
 AND retention >= 0 AND advance_recovery >= 0 AND net_payable::bigint = current_certified::bigint - retention - advance_recovery
 AND paid_amount BETWEEN 0 AND net_payable AND status IN ('pending','approved','rejected')
);
ALTER TABLE "construction_supplier_bills" ADD CONSTRAINT "construction_supplier_bill_values" CHECK (amount > 0 AND paid_amount BETWEEN 0 AND amount AND status IN ('pending','approved','rejected'));
ALTER TABLE "construction_labor_entries" ADD CONSTRAINT "construction_labor_values" CHECK (units > 0 AND rate > 0 AND amount >= 0 AND paid_amount BETWEEN 0 AND amount AND status IN ('pending','approved','rejected'));
ALTER TABLE "construction_material_entries" ADD CONSTRAINT "construction_material_values" CHECK (quantity > 0 AND returned_quantity BETWEEN 0 AND quantity AND kind IN ('consume','return','waste') AND ((kind = 'return') = (source_id IS NOT NULL)));
ALTER TABLE "construction_payments" ADD CONSTRAINT "construction_payment_values" CHECK (
 amount > 0 AND kind IN ('advance','running_bill','retention','supplier_bill','labor')
 AND ((kind IN ('advance','retention') AND contract_id IS NOT NULL AND running_bill_id IS NULL AND supplier_bill_id IS NULL AND labor_entry_id IS NULL)
 OR (kind = 'running_bill' AND running_bill_id IS NOT NULL AND contract_id IS NULL AND supplier_bill_id IS NULL AND labor_entry_id IS NULL)
 OR (kind = 'supplier_bill' AND supplier_bill_id IS NOT NULL AND contract_id IS NULL AND running_bill_id IS NULL AND labor_entry_id IS NULL)
 OR (kind = 'labor' AND labor_entry_id IS NOT NULL AND contract_id IS NULL AND running_bill_id IS NULL AND supplier_bill_id IS NULL))
);
ALTER TABLE "construction_change_orders" ADD CONSTRAINT "construction_change_values" CHECK (status IN ('pending','approved','rejected') AND (budget_change <> 0 OR contract_change <> 0) AND (budget_change = 0 OR cost_head_id IS NOT NULL) AND (contract_change = 0 OR contract_id IS NOT NULL));
