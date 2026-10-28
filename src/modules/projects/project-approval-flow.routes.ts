import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { badRequest, forbidden, notFound } from '../../core/http/api-error.js';
import { ok } from '../../core/http/response.js';
import { requireAuthContext } from '../../core/security/auth.context.js';
import { validateBody } from '../../core/validation/validate.js';
import { writeAudit } from '../../core/audit/audit.service.js';

const mode = z.enum(['accountant_only', 'accountant_and_approver']);
export const approvalFlowSchema = z.object({ income: mode, expense: mode }).strict();
export const projectApprovalFlowRouter = Router({ mergeParams: true });
const select = { incomeApprovalFlow: true, expenseApprovalFlow: true } as const;
const response = (row: { incomeApprovalFlow: string; expenseApprovalFlow: string } | null) => ({
  scope: 'organization',
  income: row?.incomeApprovalFlow ?? 'accountant_only',
  expense: row?.expenseApprovalFlow ?? 'accountant_and_approver',
});

projectApprovalFlowRouter.use(asyncHandler(async (req, _res, next) => {
  const auth = requireAuthContext(req);
  const projectId = req.params.id;
  const access = await prisma.projectMembership.findFirst({ where: {
    tenantId: auth.tenantId, projectId, userId: auth.userId, isActive: true,
    role: { in: ['owner', 'admin'] },
  } });
  if (!access) throw forbidden();
  const project = await prisma.project.findFirst({ where: { id: projectId, tenantId: auth.tenantId, isActive: true } });
  if (!project) throw notFound('Project not found');
  if (project.projectType !== 'fund_shares') throw badRequest('These approval rules belong to Fund / Shares projects');
  next();
}));

projectApprovalFlowRouter.get('/', asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return ok(res, response(await prisma.onboardingProgress.findUnique({ where: { tenantId: auth.tenantId }, select })));
}));

projectApprovalFlowRouter.put('/', validateBody(approvalFlowSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = approvalFlowSchema.parse(req.body);
  const saved = await prisma.$transaction(async tx => {
    const before = await tx.onboardingProgress.findUnique({ where: { tenantId: auth.tenantId }, select });
    const data = { incomeApprovalFlow: body.income, expenseApprovalFlow: body.expense };
    const row = await tx.onboardingProgress.upsert({
      where: { tenantId: auth.tenantId }, update: data,
      // Untracked legacy organizations are already onboarded. Do not start a new checklist.
      create: { tenantId: auth.tenantId, projectId: req.params.id, ...data,
        status: 'completed', organizationStepStatus: 'done', accountantStepStatus: 'skipped',
        accountsStepStatus: 'done', shareholdersStepStatus: 'skipped', completedAt: new Date() },
      select,
    });
    await writeAudit({ tenantId: auth.tenantId, projectId: req.params.id, actorUserId: auth.userId,
      action: 'organization.approval_flow_updated', entityType: 'onboarding_progress', entityId: auth.tenantId,
      before: response(before), after: response(row) }, tx);
    return row;
  });
  return ok(res, response(saved));
}));
