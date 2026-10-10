CREATE TYPE "ProjectType" AS ENUM ('fund_shares', 'accounting', 'billing');
CREATE TYPE "DepositApprovalRoute" AS ENUM ('accountant', 'admin');
ALTER TABLE "projects" ADD COLUMN "project_type" "ProjectType" NOT NULL DEFAULT 'fund_shares', ADD COLUMN "portal_settings" JSONB;
ALTER TABLE "deposits" ADD COLUMN "approval_route" "DepositApprovalRoute" NOT NULL DEFAULT 'accountant';
