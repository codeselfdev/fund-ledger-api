import type { RequestHandler } from 'express';
import { prisma } from '../prisma/client.js';
import { forbidden } from '../http/api-error.js';
/** Legacy fund endpoints expose shared accounts/audit feeds. Payroll employees use the scoped payroll workspace instead. */
export const payrollFinancialPrivacy: RequestHandler = async (req, _res, next) => {
  try {
    const a = req.auth;
    if (!a?.projectId || a.roles.some(r => ['owner', 'admin', 'accountant', 'approver', 'cashier', 'auditor'].includes(r))) return next();
    const path = req.originalUrl.split('?')[0];
    if (!/^\/v1\/(?:accounts|expenses|ledger|activity|incomes|dashboard|reports|assistant)(?:\/|$)/.test(path)) return next();
    const project = await prisma.project.findFirst({ where: { id: a.projectId, tenantId: a.tenantId }, select: { projectType: true } });
    if (project?.projectType === 'payroll_pf') throw forbidden('Employees can view their own salary, bills and PF through the payroll workspace');
    return next();
  } catch (e) { return next(e); }
};
