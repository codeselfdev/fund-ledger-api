/** These handlers authenticate project membership and enforce employee ownership themselves.
 * Management, approval, payroll payments and project configuration never use this exception. */
export function payrollPersonalRoute(path: string, method: string) {
  if (method === 'GET') return path === '/v1/payroll/workspace' || path === '/v1/payroll/portal/workspace';
  if (method === 'POST') return ['/v1/payroll/leave','/v1/payroll/bills','/v1/payroll/attendance/punch','/v1/payroll/portal/tasks','/v1/payroll/portal/location'].includes(path) || /^\/v1\/payroll\/portal\/documents\/[^/]+$/.test(path);
  if (method === 'PATCH') return /^\/v1\/payroll\/portal\/tasks\/[^/]+$/.test(path);
  if (method === 'PUT') return ['/v1/payroll/portal/work-split','/v1/payroll/portal/location/consent'].includes(path);
  return false;
}
