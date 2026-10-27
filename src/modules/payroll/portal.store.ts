import { randomUUID } from 'node:crypto';
import { conflict, notFound } from '../../core/http/api-error.js';
import type { PayrollAuth, Tx } from './payroll.service.js';
export interface PortalRecord<T = Record<string, unknown>> { id: string; employee_id: string | null; kind: string; record_key: string; data: T; revision: number }
export async function records<T = Record<string, unknown>>(tx: Tx, a: PayrollAuth, kind?: string): Promise<PortalRecord<T>[]> {
  return kind ? tx.$queryRaw<PortalRecord<T>[]>`SELECT id, employee_id, kind, record_key, data, revision FROM payroll_portal_records WHERE tenant_id=${a.tenantId} AND project_id=${a.projectId} AND kind=${kind} ORDER BY created_at,id` : tx.$queryRaw<PortalRecord<T>[]>`SELECT id, employee_id, kind, record_key, data, revision FROM payroll_portal_records WHERE tenant_id=${a.tenantId} AND project_id=${a.projectId} ORDER BY created_at,id`;
}
export async function record<T>(tx: Tx, a: PayrollAuth, kind: string, key: string, required = true) {
  const rows = await tx.$queryRaw<PortalRecord<T>[]>`SELECT id, employee_id, kind, record_key, data, revision FROM payroll_portal_records WHERE tenant_id=${a.tenantId} AND project_id=${a.projectId} AND kind=${kind} AND record_key=${key}`;
  if (!rows[0] && required) throw notFound('Portal record not found in this project');
  return rows[0] ?? null;
}
export async function saveRecord<T>(tx: Tx, a: PayrollAuth, kind: string, key: string, data: T, employeeId: string | null = null, expected: number | null = null) {
  const id = randomUUID(), payload = JSON.stringify(data);
  const rows = expected === null
    ? await tx.$queryRaw<PortalRecord<T>[]>`INSERT INTO payroll_portal_records (id,tenant_id,project_id,employee_id,kind,record_key,data) VALUES (${id},${a.tenantId},${a.projectId},${employeeId},${kind},${key},${payload}::jsonb) ON CONFLICT (project_id,kind,record_key) DO NOTHING RETURNING id,employee_id,kind,record_key,data,revision`
    : await tx.$queryRaw<PortalRecord<T>[]>`UPDATE payroll_portal_records SET data=${payload}::jsonb, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=${a.tenantId} AND project_id=${a.projectId} AND kind=${kind} AND record_key=${key} AND revision=${expected} RETURNING id,employee_id,kind,record_key,data,revision`;
  if (!rows[0]) throw conflict('This record changed. Refresh before saving.');
  return rows[0];
}
export const mapped = <T>(r: PortalRecord<T>) => ({ ...r.data, id: r.record_key, revision: r.revision });
