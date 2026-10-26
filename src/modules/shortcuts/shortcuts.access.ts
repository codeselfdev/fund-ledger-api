import { availableCatalog, defaultPins, visiblePins } from './shortcuts.policy.js';
import type { MenuPermissions } from '../../core/security/menu-access.js';
type Access = { roles: string[]; customRoleOnly?: boolean; menuPermissions?: MenuPermissions };
const quickMenus: Record<string, string> = { add_member: 'members', add_customer: 'customers', add_sale: 'sale', add_invoice: 'billing_invoices', add_collection: 'billing_collections', add_income: 'income', add_expense: 'expenses', add_notice: 'notices', payroll_add_bill: 'payroll_bills', payroll_apply_leave: 'payroll_leave' };
export function availableForAccess(type: string, access: Access) {
  if (!access.menuPermissions) return availableCatalog(type, access.roles);
  const catalog = availableCatalog(type, ['admin']);
  if (!access.customRoleOnly) {
    const builtin = availableCatalog(type, access.roles);
    return { ...catalog, tools: catalog.tools.filter(tool => builtin.tools.some(t => t.key === tool.key) || (tool.key === 'quick_sale' ? access.menuPermissions!.sale?.write : access.menuPermissions![tool.key]?.read)), quick_add: catalog.quick_add.filter(tool => builtin.quick_add.some(t => t.key === tool.key) || access.menuPermissions![quickMenus[tool.key]]?.write) };
  }
  return { ...catalog, tools: catalog.tools.filter(tool => (tool.key === 'quick_sale' ? access.menuPermissions!.sale?.write : access.menuPermissions![tool.key]?.read)), quick_add: catalog.quick_add.filter(tool => access.menuPermissions![quickMenus[tool.key]]?.write) };
}
export function pinsForAccess(type: string, access: Access, settings: unknown) {
  return visiblePins(defaultPins(type, access.customRoleOnly ? ['admin'] : access.roles, settings), availableForAccess(type, access).tools.map(tool => tool.key));
}
