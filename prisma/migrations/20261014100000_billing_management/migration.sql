-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "billing_settings" JSONB;

-- CreateTable
CREATE TABLE "billing_plans" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "interval_months" INTEGER NOT NULL DEFAULT 1,
    "installment_count" INTEGER,
    "due_days" INTEGER NOT NULL DEFAULT 10,
    "grace_days" INTEGER NOT NULL DEFAULT 0,
    "late_fee_type" TEXT NOT NULL DEFAULT 'none',
    "late_fee_value" INTEGER NOT NULL DEFAULT 0,
    "escalation_bps" INTEGER NOT NULL DEFAULT 0,
    "escalation_months" INTEGER NOT NULL DEFAULT 12,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_units" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_assignments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "unit_id" TEXT,
    "label" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_meter_readings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "previous" INTEGER NOT NULL,
    "current" INTEGER NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_meter_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_invoices" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "assignment_id" TEXT,
    "period_start" DATE,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "customer_snapshot" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "tax" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "paid_amount" INTEGER NOT NULL DEFAULT 0,
    "credit_amount" INTEGER NOT NULL DEFAULT 0,
    "debit_amount" INTEGER NOT NULL DEFAULT 0,
    "late_fee_amount" INTEGER NOT NULL DEFAULT 0,
    "late_fee_applied_at" TIMESTAMP(3),
    "policy" JSONB NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "note" TEXT,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "remaining_amount" INTEGER NOT NULL,
    "refunded_amount" INTEGER NOT NULL DEFAULT 0,
    "method" TEXT NOT NULL,
    "payment_date" DATE NOT NULL,
    "reference" TEXT,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_allocations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_adjustments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "invoice_id" TEXT,
    "payment_id" TEXT,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_runs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "assignment_ids" JSONB NOT NULL,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_messages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "lease_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "billing_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_plans_tenant_id_project_id_is_active_idx" ON "billing_plans"("tenant_id", "project_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "billing_plans_project_id_name_key" ON "billing_plans"("project_id", "name");

-- CreateIndex
CREATE INDEX "billing_units_tenant_id_project_id_idx" ON "billing_units"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_units_project_id_name_key" ON "billing_units"("project_id", "name");

-- CreateIndex
CREATE INDEX "billing_assignments_tenant_id_project_id_status_idx" ON "billing_assignments"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "billing_assignments_project_id_customer_id_idx" ON "billing_assignments"("project_id", "customer_id");

-- CreateIndex
CREATE INDEX "billing_meter_readings_tenant_id_project_id_idx" ON "billing_meter_readings"("tenant_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_meter_readings_assignment_id_period_start_key" ON "billing_meter_readings"("assignment_id", "period_start");

-- CreateIndex
CREATE INDEX "billing_invoices_tenant_id_project_id_customer_id_status_du_idx" ON "billing_invoices"("tenant_id", "project_id", "customer_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "billing_invoices_project_id_request_key_key" ON "billing_invoices"("project_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "billing_invoices_project_id_number_key" ON "billing_invoices"("project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "billing_invoices_assignment_id_period_start_key" ON "billing_invoices"("assignment_id", "period_start");

-- CreateIndex
CREATE INDEX "billing_payments_tenant_id_project_id_customer_id_idx" ON "billing_payments"("tenant_id", "project_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_project_id_request_key_key" ON "billing_payments"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "billing_allocations_tenant_id_project_id_invoice_id_idx" ON "billing_allocations"("tenant_id", "project_id", "invoice_id");

-- CreateIndex
CREATE INDEX "billing_adjustments_tenant_id_project_id_status_idx" ON "billing_adjustments"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_adjustments_project_id_request_key_key" ON "billing_adjustments"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "billing_runs_status_created_at_idx" ON "billing_runs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_runs_project_id_request_key_key" ON "billing_runs"("project_id", "request_key");

-- CreateIndex
CREATE INDEX "billing_messages_status_created_at_idx" ON "billing_messages"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_messages_project_id_dedupe_key_key" ON "billing_messages"("project_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_units" ADD CONSTRAINT "billing_units_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_assignments" ADD CONSTRAINT "billing_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_assignments" ADD CONSTRAINT "billing_assignments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_assignments" ADD CONSTRAINT "billing_assignments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "billing_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_assignments" ADD CONSTRAINT "billing_assignments_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "billing_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_meter_readings" ADD CONSTRAINT "billing_meter_readings_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "billing_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "billing_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "billing_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_adjustments" ADD CONSTRAINT "billing_adjustments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_adjustments" ADD CONSTRAINT "billing_adjustments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_adjustments" ADD CONSTRAINT "billing_adjustments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_adjustments" ADD CONSTRAINT "billing_adjustments_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "billing_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_runs" ADD CONSTRAINT "billing_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_messages" ADD CONSTRAINT "billing_messages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Financial invariants also apply to writes outside the API.
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plan_values" CHECK (
  amount > 0 AND interval_months BETWEEN 1 AND 12 AND due_days >= 0 AND grace_days >= 0
  AND mode IN ('fixed', 'usage', 'one_time', 'installment')
  AND (mode <> 'installment' OR (installment_count > 0 AND amount >= installment_count))
  AND late_fee_type IN ('none', 'fixed', 'percentage') AND late_fee_value >= 0
  AND (late_fee_type <> 'percentage' OR late_fee_value <= 10000)
);
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoice_values" CHECK (
  total >= 0 AND subtotal >= 0 AND discount >= 0 AND discount <= subtotal AND tax >= 0
  AND total::bigint = subtotal::bigint - discount + tax
  AND paid_amount >= 0 AND credit_amount >= 0 AND debit_amount >= 0 AND late_fee_amount >= 0
  AND total::bigint + debit_amount + late_fee_amount - credit_amount BETWEEN paid_amount AND 2147483647
  AND status IN ('issued', 'cancelled') AND due_date >= invoice_date
);
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payment_values" CHECK (
  amount > 0 AND remaining_amount >= 0 AND refunded_amount >= 0
  AND remaining_amount::bigint + refunded_amount <= amount
  AND method IN ('cash', 'bank', 'bkash', 'nagad', 'card', 'cheque')
);
ALTER TABLE "billing_allocations" ADD CONSTRAINT "billing_allocation_amount" CHECK (amount > 0);
ALTER TABLE "billing_meter_readings" ADD CONSTRAINT "billing_meter_values" CHECK (previous >= 0 AND current >= previous);
ALTER TABLE "billing_assignments" ADD CONSTRAINT "billing_assignment_values" CHECK (
  status IN ('active', 'suspended', 'disconnected', 'ended') AND (end_date IS NULL OR end_date >= start_date)
);
ALTER TABLE "billing_adjustments" ADD CONSTRAINT "billing_adjustment_values" CHECK (
  amount >= 0 AND status IN ('pending', 'approved', 'rejected')
  AND kind IN ('credit_note', 'debit_note', 'waiver', 'write_off', 'cancel', 'refund')
  AND ((kind = 'refund' AND payment_id IS NOT NULL AND invoice_id IS NULL)
    OR (kind <> 'refund' AND invoice_id IS NOT NULL AND payment_id IS NULL))
);
