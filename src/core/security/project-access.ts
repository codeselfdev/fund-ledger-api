import type { Role } from "@prisma/client";

const priority: Role[] = ["owner", "admin", "accountant", "approver", "auditor", "cashier", "teacher", "employee", "member"];

export function effectiveProjectRoles(roles: Role[]): Role[] {
  const result = Array.from(new Set(roles));
  if (result.includes("owner") && !result.includes("admin")) result.push("admin");
  return result;
}

interface ProjectMembershipRow {
  tenantId: string;
  projectId: string;
  role: Role;
  customRoleId?: string | null;
  customRole?: { id: string; name: string; description: string; permissions: unknown; revision: number } | null;
  memberId: string | null;
  project: { name: string; projectType: "fund_shares" | "accounting" | "billing" | "construction" | "payroll_pf" | "institute"; isActive: boolean };
}

/** One access entry per project, retaining all assigned roles and only explicit member links. */
export function summarizeProjectMemberships(rows: ProjectMembershipRow[]) {
  const projects = new Map<string, {
    tenant_id: string; project_id: string; project_name: string; project_type: ProjectMembershipRow["project"]["projectType"];
    role: Role; roles: Role[]; builtin_roles: Role[]; custom_roles: NonNullable<ProjectMembershipRow["customRole"]>[]; member_id: string | null;
  }>();
  for (const row of rows) {
    if (!row.project.isActive) continue;
    const entry = projects.get(row.projectId) ?? {
      tenant_id: row.tenantId, project_id: row.projectId, project_name: row.project.name, project_type: row.project.projectType,
      role: row.role, roles: [], builtin_roles: [], custom_roles: [], member_id: null
    };
    if (!entry.roles.includes(row.role)) entry.roles.push(row.role);
    if (row.customRole && !entry.custom_roles.some(role => role.id === row.customRole!.id)) entry.custom_roles.push(row.customRole);
    if (!row.customRoleId && !entry.builtin_roles.includes(row.role)) entry.builtin_roles.push(row.role);
    if (row.role === "member" && row.memberId) entry.member_id = row.memberId;
    entry.role = priority.find(role => entry.roles.includes(role)) ?? row.role;
    projects.set(row.projectId, entry);
  }
  return Array.from(projects.values());
}
