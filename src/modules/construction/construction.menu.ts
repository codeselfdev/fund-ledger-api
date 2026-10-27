import type { Role } from '@prisma/client';
export const constructionMenuKeys = ['construction_overview', 'construction_setup', 'construction_budgets', 'construction_boq', 'construction_contractors', 'construction_suppliers', 'construction_materials', 'construction_labor', 'construction_running_bills', 'construction_funding', 'construction_changes', 'construction_reports'] as const;
const definitions = [
    ['construction_control','Site planning & control','/v1/construction/control'],
    ['construction_overview', 'Construction Financial Overview', '/v1/construction/overview'],
    ['construction_setup', 'Building & Site Setup', '/v1/construction/configuration'],
    ['construction_budgets', 'Budget Estimation', '/v1/construction/cost-heads'],
    ['construction_boq', 'BOQ & Cost Allocation', '/v1/construction/boq'],
    ['construction_contractors', 'Contractors & Contracts', '/v1/construction/contracts'],
    ['construction_suppliers', 'Suppliers & Bills', '/v1/construction/supplier-bills'],
    ['construction_materials', 'Materials & Site Usage', '/v1/construction/materials'],
    ['construction_labor', 'Daily Labor & Wages', '/v1/construction/labor'],
    ['construction_running_bills', 'Contractor Running Bills', '/v1/construction/running-bills'],
    ['construction_funding', 'Member-funded Construction', '/v1/construction/funding'],
    ['construction_changes', 'Change Orders', '/v1/construction/change-orders'],
    ['construction_reports', 'Budget & Financial Reports', '/v1/construction/overview']
] as const;
export function constructionMenus(roles: Role[]) {
    const manage = roles.some(r => ['owner', 'admin'].includes(r));
    const write = manage || roles.includes('accountant');
    if (!write && !roles.some(r => ['approver', 'auditor', 'cashier'].includes(r)))
        return [];
    return definitions.map(([key, label, api]) => ({ key, label, api, can_write: key === 'construction_overview' || key === 'construction_reports' ? false : key === 'construction_setup' ? manage : write }));
}
