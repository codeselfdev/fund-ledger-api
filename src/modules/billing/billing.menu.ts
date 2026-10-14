import type { Role } from '@prisma/client';
export const billingMenuKeys = ['billing_overview', 'customers', 'billing_units', 'billing_subscriptions', 'billing_plans', 'billing_invoices', 'billing_collections', 'billing_outstanding', 'billing_adjustments', 'billing_approvals', 'billing_meters', 'billing_ledger', 'billing_reports', 'billing_notifications'] as const;
const definitions = [
    ['billing_overview', 'Billing Overview', '/v1/billing/overview'],
    ['customers', 'Customers', '/v1/billing/customers'],
    ['billing_units', 'Units & Connections', '/v1/billing/units'],
    ['billing_subscriptions', 'Subscriptions & Assignments', '/v1/billing/assignments'],
    ['billing_plans', 'Billing Plans', '/v1/billing/plans'],
    ['billing_invoices', 'Invoices', '/v1/billing/invoices'],
    ['billing_collections', 'Payment Collections', '/v1/billing/payments'],
    ['billing_outstanding', 'Outstanding Dues', '/v1/billing/invoices?outstanding=true'],
    ['billing_adjustments', 'Adjustments', '/v1/billing/adjustments'],
    ['billing_approvals', 'Billing Approvals', '/v1/billing/adjustments?status=pending'],
    ['billing_meters', 'Meter Readings', '/v1/billing/meter-readings'],
    ['billing_ledger', 'Customer Ledger', '/v1/billing/customers'],
    ['billing_reports', 'Billing Reports', '/v1/billing/reports'],
    ['billing_notifications', 'Reminders & Receipts', '/v1/billing/messages'],
] as const;
export function billingMenus(roles: Role[]) {
    const manage = roles.some(r => ['owner', 'admin'].includes(r));
    const write = manage || roles.includes('accountant');
    const collect = write || roles.includes('cashier');
    const approve = manage || roles.includes('approver');
    const read = collect || approve || roles.includes('auditor');
    if (!read)
        return [];
    return definitions.map(([key, label, api]) => ({ key, label, api,
        can_write: key === 'billing_approvals' ? approve : key === 'billing_collections' ? collect : key === 'billing_reports' || key === 'billing_ledger' || key === 'billing_overview' || key === 'billing_outstanding' ? false : write
    }));
}
