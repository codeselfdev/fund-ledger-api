import { menuAccessCatalog } from './menu-access.catalog.js';
export type MenuPermissions = Record<string, { read: boolean; write: boolean }>;
export const accessMenus = (type: string) => menuAccessCatalog.filter(menu => (menu.project_types as readonly string[]).includes(type));
export function mergePermissions(roles: readonly { permissions: unknown }[]): MenuPermissions {
  const result: MenuPermissions = {};
  for (const role of roles) {
    if (!role.permissions || typeof role.permissions !== 'object' || Array.isArray(role.permissions)) continue;
    for (const [key, value] of Object.entries(role.permissions)) {
      if (!value || typeof value !== 'object') continue;
      const access = value as { read?: unknown; write?: unknown }, old = result[key];
      result[key] = { read: !!(old?.read || access.read === true || access.write === true), write: !!(old?.write || access.write === true) };
    }
  }
  return result;
}
export const menuGrant = (permissions: MenuPermissions, keys: readonly string[], write: boolean) => keys.some(key => permissions[key]?.[write ? 'write' : 'read'] === true);

export const menuReadDependencies: Record<string, string[]> = { construction_approvals: ['construction_contractors', 'construction_budgets', 'construction_running_bills', 'construction_suppliers', 'construction_labor', 'construction_changes', 'construction_site_log'] };
