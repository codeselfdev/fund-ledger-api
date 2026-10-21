-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "recurring_bill_id" TEXT,
ADD COLUMN     "recurring_due_date" DATE;

-- CreateTable
CREATE TABLE "recurring_expense_bills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "preset" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "vendor_id" TEXT,
    "category_def_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "frequency" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "next_due" DATE NOT NULL,
    "mode" TEXT NOT NULL,
    "remind_days" INTEGER NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "end_date" DATE,
    "staff" JSONB NOT NULL DEFAULT '[]',
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "reminded_for" DATE,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_expense_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_expense_periods" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "expense_id" TEXT,
    "actor_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_expense_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_expense_bills_tenant_id_project_id_deleted_at_idx" ON "recurring_expense_bills"("tenant_id", "project_id", "deleted_at");

-- CreateIndex
CREATE INDEX "recurring_expense_bills_paused_deleted_at_next_due_idx" ON "recurring_expense_bills"("paused", "deleted_at", "next_due");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_expense_periods_expense_id_key" ON "recurring_expense_periods"("expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_expense_periods_bill_id_due_date_key" ON "recurring_expense_periods"("bill_id", "due_date");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recurring_bill_id_fkey" FOREIGN KEY ("recurring_bill_id") REFERENCES "recurring_expense_bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expense_bills" ADD CONSTRAINT "recurring_expense_bills_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expense_periods" ADD CONSTRAINT "recurring_expense_periods_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "recurring_expense_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expense_periods" ADD CONSTRAINT "recurring_expense_periods_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "recurring_expense_bills" ADD COLUMN "request_key" TEXT, ADD COLUMN "request_payload" TEXT;
CREATE UNIQUE INDEX "recurring_expense_bills_project_id_request_key_key" ON "recurring_expense_bills"("project_id", "request_key");
ALTER TABLE "recurring_expense_bills" ADD CONSTRAINT "recurring_expense_bills_amount_check" CHECK (amount > 0),
  ADD CONSTRAINT "recurring_expense_bills_kind_mode_check" CHECK (kind IN ('fixed', 'variable') AND mode IN ('auto', 'remind') AND (kind <> 'variable' OR mode = 'remind')),
  ADD CONSTRAINT "recurring_expense_bills_frequency_check" CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  ADD CONSTRAINT "recurring_expense_bills_day_check" CHECK (day BETWEEN 1 AND 31),
  ADD CONSTRAINT "recurring_expense_bills_remind_check" CHECK (remind_days IN (0, 1, 3, 7));
ALTER TABLE "recurring_expense_periods" ADD CONSTRAINT "recurring_expense_periods_status_check" CHECK (status IN ('recorded', 'skipped'));
