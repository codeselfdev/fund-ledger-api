-- CreateEnum
CREATE TYPE "OnboardingProgressStatus" AS ENUM ('in_progress', 'completed');

-- CreateEnum
CREATE TYPE "OnboardingStepStatus" AS ENUM ('pending', 'done', 'skipped');

-- CreateEnum
CREATE TYPE "ApprovalFlowMode" AS ENUM ('accountant_only', 'accountant_and_approver');

-- CreateTable
CREATE TABLE "onboarding_progress" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "OnboardingProgressStatus" NOT NULL DEFAULT 'in_progress',
    "organization_step_status" "OnboardingStepStatus" NOT NULL DEFAULT 'done',
    "accountant_step_status" "OnboardingStepStatus" NOT NULL DEFAULT 'pending',
    "accounts_step_status" "OnboardingStepStatus" NOT NULL DEFAULT 'pending',
    "shareholders_step_status" "OnboardingStepStatus" NOT NULL DEFAULT 'pending',
    "income_approval_flow" "ApprovalFlowMode" NOT NULL DEFAULT 'accountant_and_approver',
    "expense_approval_flow" "ApprovalFlowMode" NOT NULL DEFAULT 'accountant_and_approver',
    "accountant_user_id" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_progress_tenant_id_key" ON "onboarding_progress"("tenant_id");

-- CreateIndex
CREATE INDEX "onboarding_progress_tenant_id_project_id_idx" ON "onboarding_progress"("tenant_id", "project_id");

-- AddForeignKey
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
