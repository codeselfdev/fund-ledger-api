import type { MenuPermissions } from '../../core/security/menu-access.js';
import type { workspace } from './payroll.service.js';
export function filterPayrollWorkspace(data: Awaited<ReturnType<typeof workspace>>, permissions: MenuPermissions) {
  const read = (key: string) => !!permissions[key]?.read;
  const salary = read('payroll_employees') || read('payroll_run');
  const pf = read('payroll_pf');
  const employees = data.employees.map(employee => ({ ...employee,
    ...(!salary ? { basic: 0, medical: 0, transport: 0 } : {}),
    ...(!pf ? { pf: { own: 0, company: 0, profit: 0, loanOutstanding: 0, vestedPercent: 0, payable: 0 } } : {}),
    ...(!read('payroll_leave') ? { leaveLeft: { Annual: 0, Sick: 0, Casual: 0 } } : {}),
  }));
  return { ...data,
    overview: permissions.overview?.read ? { employeeCount: data.employees.length, netTotal: data.run?.rows.reduce((sum, row) => sum + row.net, 0) ?? 0, pfTotal: data.employees.reduce((sum, employee) => sum + employee.pf.own + employee.pf.company + employee.pf.profit, 0), pendingLeaves: data.leaves.filter(leave => leave.status === 'pending').length } : null,
    employees, me: data.me ? employees.find(employee => employee.id === data.me!.id) ?? null : null,
    run: read('payroll_run') ? data.run : null,
    leaves: read('payroll_leave') ? data.leaves : [],
    bills: read('payroll_bills') ? data.bills : [],
    attendance: read('payroll_attendance') ? data.attendance : { ...data.attendance, records: [] },
  };
}
