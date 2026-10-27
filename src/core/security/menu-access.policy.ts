import { payrollPersonalRoute } from './payroll-personal-routes.js';
/** All paths are absolute API paths. Unknown endpoints stay closed for custom-only access. */
export function routeMenuKeys(path: string, method: string, query: Record<string, unknown> = {}, body: Record<string, unknown> = {}): string[] | null {
  const parts = path.split('/').filter(Boolean), root = parts[1], action = parts[2] ?? '';
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const map: Record<string, string> = { incomes: 'income', expenses: 'expenses', 'expense-categories': 'expenses', accounts: 'accounts', transfers: 'accounts', ledger: 'ledger', members: 'members', schedules: 'schedules', 'recurring-schedules': 'recurring', dues: 'schedules', deposits: 'deposits', receipts: 'deposits', notices: 'notices', polls: 'polls', events: 'events', activity: 'activity', customers: 'customers', vendors: 'dealers', purchases: 'purchases', sales: 'commerce', inventory: 'inventory', 'inventory-categories': 'inventory', 'fixed-assets': 'assets', reports: 'reports', 'business-setup': 'business_setup', 'contact-persons': 'customers' };
  if (root === 'accounting') {
    if (['dashboard', 'overview'].includes(action)) return ['overview'];
    if (['workflow', 'document-settings'].includes(action)) return write ? ['business_setup'] : ['quotation', 'order', 'sale', 'receivables'];
    if (['document-item-fields', 'referrals'].includes(action)) return ['quotation', 'order', 'sale'];
    if (action === 'documents') {
      const kind = query.kind ?? body.kind;
      if (parts.includes('payments') || query.receivable === 'true') return ['receivables'];
      return typeof kind === 'string' && ['quotation', 'order', 'sale'].includes(kind) ? [kind] : [];
    }
    return [];
  }
  if (root === 'billing') {
    if (['home', 'overview'].includes(action)) return ['overview'];
    if (action === 'configuration') return write ? ['business_setup'] : ['overview', 'billing_plans', 'billing_invoices', 'billing_units', 'billing_subscriptions', 'billing_meters', 'billing_late_fees', 'billing_adjustments', 'billing_approvals', 'billing_collections', 'billing_outstanding', 'billing_bulk', 'billing_ledger', 'billing_reports', 'billing_notifications', 'billing_complaints'];
    if (action === 'customers') return [parts.includes('apply-advance') ? 'billing_adjustments' : parts.length > 3 ? 'billing_ledger' : 'customers'];
    if (action === 'complaints') return ['billing_complaints'];
    if (action === 'subscribers') return [];
    if (action === 'assignments' && parts.includes('invoice')) return ['billing_invoices'];
    if (action === 'adjustments' && parts.includes('decision')) return ['billing_approvals'];
    const billing: Record<string, string> = { plans: 'billing_plans', units: 'billing_units', assignments: 'billing_subscriptions', invoices: 'billing_invoices', payments: 'billing_collections', adjustments: 'billing_adjustments', 'meter-readings': 'billing_meters', 'invoice-runs': 'billing_bulk', 'late-fees': 'billing_late_fees', reminders: 'billing_notifications', messages: 'billing_notifications', reports: 'billing_reports' };
    if (action === 'invoices' && !write) return ['billing_invoices', 'billing_outstanding', 'billing_adjustments', 'billing_collections'];
    if (action === 'adjustments' && !write) return ['billing_adjustments', 'billing_approvals'];
    return billing[action] ? [billing[action]] : [];
  }
  if (root === 'construction') {
    if (action === 'structure' && !write) return ['construction_budgets','construction_boq','construction_site_log','construction_materials','construction_labor'];
    const construction: Record<string, string> = { control:'construction_control', locations: 'construction_budgets', 'work-packages': 'construction_budgets', tasks: 'construction_budgets', phases: 'construction_budgets', configuration: 'construction_setup', overview: 'construction_reports', 'cost-heads': 'construction_budgets', boq: 'construction_boq', allocations: 'construction_boq', contractors: 'construction_contractors', contracts: 'construction_contractors', suppliers: 'construction_suppliers', 'supplier-bills': 'construction_suppliers', materials: 'construction_materials', labor: 'construction_labor', 'running-bills': 'construction_running_bills', funding: 'construction_funding', 'change-orders': 'construction_changes', payments: 'construction_payments', 'site-logs': 'construction_site_log', wastage: 'construction_wastage' };
    return construction[action] ? [construction[action]] : [];
  }
  if (root === 'payroll') {
    if (action === 'portal') {
      const portal: Record<string,string> = { employees:'payroll_employees', departments:'payroll_org', designations:'payroll_org', projects:'payroll_projects', tasks:'payroll_tasks', documents:'payroll_documents', location:'payroll_location', 'location-requests':'payroll_location', 'work-split':'payroll_tasks' };
      if (parts[3] === 'employees' && parts[5] === 'location-request') return ['payroll_location'];
      return parts[3] === 'workspace' ? ['payroll_employees','payroll_org','payroll_projects','payroll_tasks','payroll_documents','payroll_location'] : [portal[parts[3]] ?? '__denied__'];
    }
    const payroll: Record<string, string> = { settings: 'payroll_settings', employees: 'payroll_employees', import: 'payroll_employees', runs: 'payroll_run', leave: 'payroll_leave', bills: 'payroll_bills', attendance: 'payroll_attendance' };
    if (action === 'workspace') return ['overview', 'payroll_employees', 'payroll_run', 'payroll_leave', 'payroll_bills', 'payroll_pf', 'payroll_attendance', 'payroll_settings'];
    return payroll[action] ? [payroll[action]] : [];
  }
  if (root === 'notifications' && action === 'broadcast') return ['notifications'];
  if (root === 'penalty-policy') return ['schedules'];
  if (root === 'schedules' && !write) return ['schedules', 'recurring'];
  if (root === 'members' && action === 'import-fund') return [];
  if (root === 'notifications' && action === 'campaigns') return ['notifications'];
  if (root === 'dashboard') return ['overview'];
  if (map[root]) return [map[root]];
  return null;
}
export function personalAccessPath(path: string, method: string) {
  if (payrollPersonalRoute(path, method)) return true;
  if (path === '/v1/app-guide/status' && method === 'GET' || path === '/v1/app-guide/ask' && method === 'POST') return true;
  return /^\/v1\/auth\/(?:me|logout|switch-project)$/.test(path)
    || /^\/v1\/shortcuts(?:\/(?:preferences|reset))?$/.test(path)
    || /^\/v1\/(?:notifications|notifications\/[^/]+\/(?:read|seen)|notifications\/read-all|notifications\/device-token|device-tokens)$/.test(path)
    || (method === 'GET' && /^\/v1\/projects(?:\/[^/]+)?$/.test(path));
}
