import type { Request } from 'express';
import { prisma } from '../prisma/client.js';
import { forbidden, notFound } from '../http/api-error.js';
import { effectiveProjectRoles } from './project-access.js';
import { menuGrant } from './menu-access.js';
import { uploadMenuKeys } from './upload-menu-access.js';
import { personalAccessPath, routeMenuKeys } from './menu-access.policy.js';

export async function enforceMenuAccess(req: Request) {
  if (/^\/v1\/institute(?:\/|$)/.test(req.originalUrl ?? "")) return;
  const a = req.auth;
  if (!a?.projectId || !a.menuPermissions) return;
  // A separately assigned built-in role retains its existing route policy.
  a.roles = effectiveProjectRoles(a.builtinRoles ?? []);
  const builtInAdmin = a.roles.some(role => role === 'owner' || role === 'admin');
  if (builtInAdmin) return;
  const path = req.originalUrl.split('?')[0].replace(/\/+$/, ''), write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (personalAccessPath(path, req.method)) return;
  const project = await prisma.project.findFirst({ where: { id: a.projectId, tenantId: a.tenantId }, select: { projectType: true } });
  let keys = routeMenuKeys(path, req.method, req.query, req.body ?? {});
  if (path === '/v1/billing/overview') keys = ['billing_reports'];
  if (path === '/v1/construction/overview') keys = ['overview', 'construction_reports'];
  if (path === '/v1/accounting/overview') keys = ['overview', 'quotation', 'order', 'sale', 'receivables'];
  if (keys?.some(key => ['inventory', 'purchases', 'dealers'].includes(key)) && project?.projectType === 'fund_shares') keys = ['commerce'];
  if (project?.projectType === 'construction' && keys?.includes('inventory')) keys = ['construction_materials'];
  if (project?.projectType === 'construction' && keys?.some(key => ['purchases', 'dealers'].includes(key))) keys = ['construction_suppliers'];
  if (project?.projectType === 'construction' && keys?.some(key => ['members', 'schedules', 'recurring', 'deposits'].includes(key))) keys.push('construction_funding');
  if (project?.projectType === 'construction' && write && /\/decision$/.test(path) && path.startsWith('/v1/construction/') && !path.startsWith('/v1/construction/control/')) keys?.push('construction_approvals');
  if (path === '/v1/billing/subscribers' && write) {
    const required = ['customers', 'billing_units', 'billing_subscriptions', ...(req.body?.start === 'this_month' ? ['billing_invoices'] : [])];
    if (required.every(key => a.menuPermissions![key]?.write)) keys = ['customers'];
    else if (a.customRoleOnly) throw forbidden('Creating a subscriber requires Write for Customers, Units and Subscriptions, plus Invoices for this month');
  }
  // A document's stored kind, rather than a client-supplied kind, controls access.
  const documentId = path.match(/^\/v1\/accounting\/documents\/([^/]+)(?:\/|$)/)?.[1];
  if (documentId && documentId !== 'preview') {
    const doc = await prisma.businessDocument.findFirst({ where: { id: decodeURIComponent(documentId), tenantId: a.tenantId, projectId: a.projectId }, select: { kind: true } });
    if (!doc) throw notFound('Document not found');
    if (!path.endsWith('/payments')) keys = !write && doc.kind === 'sale' ? ['sale', 'receivables'] : [doc.kind];
    if (path.endsWith('/convert')) {
      const target = req.body?.kind;
      if (!menuGrant(a.menuPermissions, [doc.kind], true) || typeof target !== 'string' || !menuGrant(a.menuPermissions, [target], true)) {
        if (a.customRoleOnly) throw forbidden('Write access to both document menus is required');
        return;
      }
    }
  }
  if (path.startsWith('/v1/uploads')) {
    if (write && req.method === 'POST' && path === '/v1/uploads') {
      // Multipart purpose is checked after parsing and before storage in the upload handler.
      if (Object.values(a.menuPermissions).some(access => access.write)) return;
    } else if (!write) {
      const id = path.match(/^\/v1\/uploads\/([^/]+)\/view$/)?.[1];
      const upload = id ? await prisma.upload.findFirst({ where: { id: decodeURIComponent(id), tenantId: a.tenantId, projectId: a.projectId }, select: { purpose: true } }) : null;
      keys = upload ? uploadMenuKeys(upload.purpose) : [];
    }
  }
  if (!write && path === '/v1/accounts' && a.menuPermissions.ledger?.read) keys = ['ledger'];
  // Shared account lists are needed to choose a payment account, but cannot change accounts.
  if (!write && path === '/v1/accounts' && Object.entries(a.menuPermissions).some(([key, access]) => access.write && ['income', 'expenses', 'deposits', 'construction_funding', 'assets', 'sale', 'receivables', 'billing_collections', 'construction_payments', 'payroll_run', 'payroll_bills'].includes(key))) keys = Object.keys(a.menuPermissions).filter(key => a.menuPermissions![key].write);
  const granted = keys && menuGrant(a.menuPermissions, keys, write);
  if (granted) {
    // Existing domain handlers keep their validation, scoped lookups, transaction and self-approval checks.
    // Elevation lives only on this single permission-checked request, never on a token or membership.
    a.roles = write ? ['admin'] : Array.from(new Set([...a.roles, 'auditor']));
    a.menuRouteGranted = true;
    return;
  }
  if (a.customRoleOnly) throw forbidden(write ? 'Write access is not allowed for this menu' : 'Read access is not allowed for this menu');
}
