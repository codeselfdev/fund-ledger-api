import type { Role } from "@prisma/client";

export const STAFF_ROLES: Role[] = ["accountant", "approver", "auditor", "admin"];
export const ALL_ROLES: Role[] = ["owner", "admin", "member", "cashier", "accountant", "approver", "auditor"];
export const MANAGEMENT_ROLES: Role[] = ["owner", "admin"];

export type RoleGate = Role | "any" | "staff";

export function expandRoleGate(gate: RoleGate): Role[] {
  if (gate === "any") return ALL_ROLES;
  if (gate === "staff") return STAFF_ROLES;
  return [gate];
}

export function hasAnyRole(actual: Role[], gates: RoleGate[]) {
  const allowed = new Set(gates.flatMap(expandRoleGate));
  return actual.some((role) => allowed.has(role));
}
