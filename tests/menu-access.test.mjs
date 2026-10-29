import { normalizedAccountRelations } from './helpers/normalized-fixtures.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'isolated-menu-access-test';
const { prisma } = await import('../dist/core/prisma/client.js');
const { enforceMenuAccess } = await import('../dist/core/security/menu-access.middleware.js');
const { mergePermissions } = await import('../dist/core/security/menu-access.js');
const { filterPayrollWorkspace } = await import('../dist/modules/payroll/payroll.menu-access.js');
const { summarizeProjectMemberships } = await import('../dist/core/security/project-access.js');
const { availableForAccess } = await import('../dist/modules/shortcuts/shortcuts.access.js');
const rw = { read: true, write: true }, read = { read: true, write: false };
prisma.project.findFirst = async () => ({ projectType: 'accounting' });
prisma.businessDocument.findFirst = async ({ where }) => where.projectId === 'project' && where.id === 'sale' ? { kind: 'sale' } : null;
prisma.upload.findFirst = async () => ({ purpose: 'payroll_receipt' });
const req = (path, method = 'GET', permissions = {}, builtinRoles = [], body = {}) => ({ originalUrl: path, method, query: {}, body, auth: { tenantId: 'tenant', projectId: 'project', userId: 'user', roles: ['auditor'], builtinRoles, menuPermissions: permissions, customRoleOnly: !builtinRoles.length } });
after(() => prisma.$disconnect());
test('read access cannot mutate, inspect forbidden menus, manage access, or reach assistant bypasses', async () => {
  const request = req('/v1/expenses', 'GET', { expenses: read });
  await enforceMenuAccess(request); assert.deepEqual(request.auth.roles, ['auditor']);
  for (const [path, method] of [['/v1/expenses','POST'], ['/v1/incomes','GET'], ['/v1/project-roles','GET'], ['/v1/memberships','POST'], ['/v1/ai-service/chat','POST'], ['/v1/unknown','GET']]) {
    await assert.rejects(enforceMenuAccess(req(path, method, { expenses: read })), /access.*not allowed/i);
  }
});
test('write grants are scoped to one route request and never become a membership-wide admin role', async () => {
  const writeRequest = req('/v1/expenses/expense/approve', 'POST', { expenses: rw });
  await enforceMenuAccess(writeRequest); assert.deepEqual(writeRequest.auth.roles, ['admin']);
  await assert.rejects(enforceMenuAccess(req('/v1/accounts/a/adjust', 'POST', { expenses: rw })), /not allowed/);
  const freshRead = req('/v1/expenses', 'GET', { expenses: rw }); await enforceMenuAccess(freshRead); assert.deepEqual(freshRead.auth.roles, ['auditor']);
});
test('document access resolves stored kind, and conversion requires both source and target write', async () => {
  await assert.rejects(enforceMenuAccess(req('/v1/accounting/documents/sale', 'GET', { quotation: read })), /not allowed/);
  await enforceMenuAccess(req('/v1/accounting/documents/sale', 'GET', { receivables: read }));
  await assert.rejects(enforceMenuAccess(req('/v1/accounting/documents/sale/convert', 'POST', { sale: rw }, [], { kind: 'order' })), /both document menus/);
  await enforceMenuAccess(req('/v1/accounting/documents/sale/convert', 'POST', { sale: rw, order: rw }, [], { kind: 'order' }));
  await assert.rejects(enforceMenuAccess(req('/v1/accounting/documents/foreign', 'GET', { sale: read })), /not found/);
});
test('attachment reads follow their purpose and multipart uploads require a write grant', async () => {
  await assert.rejects(enforceMenuAccess(req('/v1/uploads/file/view', 'GET', { payroll_attendance: read })), /not allowed/);
  await enforceMenuAccess(req('/v1/uploads/file/view', 'GET', { payroll_bills: read }));
  await assert.rejects(enforceMenuAccess(req('/v1/uploads', 'POST', { expenses: read })), /not allowed/);
});
test('independent built-in roles retain existing policy while custom grants add only their menu', async () => {
  const standard = req('/v1/project-roles', 'GET', { income: read }, ['owner']);
  await enforceMenuAccess(standard); assert.ok(standard.auth.roles.includes('admin'));
  const mixed = req('/v1/project-roles', 'GET', { income: read }, ['accountant']);
  await enforceMenuAccess(mixed); assert.deepEqual(mixed.auth.roles, ['accountant']);
  const granted = req('/v1/incomes', 'POST', { income: rw }, ['member']);
  await enforceMenuAccess(granted); assert.deepEqual(granted.auth.roles, ['admin']);
});
test('empty permissions fail closed and only personal routes remain available', async () => {
  await assert.rejects(enforceMenuAccess(req('/v1/expenses', 'GET', {})), /not allowed/);
  await enforceMenuAccess(req('/v1/auth/me', 'GET', {}));
  await enforceMenuAccess(req('/v1/notifications/device-token', 'POST', {}));
});
test('project summaries keep custom grants scoped and distinguish the storage role from independent access', () => {
  const role = { id: 'role', name: 'Clerk', description: '', permissions: { income: rw }, revision: 1 };
  const rows = summarizeProjectMemberships([{ tenantId:'t', projectId:'p', role:'auditor', memberId:null, customRoleId:role.id, customRole:role, project:{name:'A',projectType:'accounting',isActive:true} }, { tenantId:'t', projectId:'q', role:'member', memberId:'m', project:{name:'B',projectType:'fund_shares',isActive:true} }]);
  assert.deepEqual(rows[0].builtin_roles, []); assert.equal(rows[0].custom_roles[0].name, 'Clerk'); assert.deepEqual(rows[1].custom_roles, []); assert.deepEqual(rows[1].builtin_roles, ['member']);
});
test('shortcuts and quick-add reveal only allowed custom menus and writable actions', () => {
  const config = availableForAccess('accounting', { roles: [], customRoleOnly: true, menuPermissions: { income: read, expenses: rw } });
  assert.deepEqual(config.tools.map(t => t.key).sort(), ['expenses','income']);
  assert.deepEqual(config.quick_add.map(t => t.key), ['add_expense']);
});
const payroll = { month:'2026-10', today:'2026-10-25', settings:{}, attendance:{settings:{},records:[{employeeId:'e'}]}, employees:[{id:'e',basic:100,medical:20,transport:10,pf:{own:5,company:5,profit:1},leaveLeft:{Annual:20,Sick:14,Casual:10}}], me:null, run:{rows:[{net:100}]}, leaves:[{status:'pending'}], bills:[{amount:20}] };
test('attendance-only and Overview payroll reads exclude salaries, PF balances, bills and leave details', () => {
  const attendance = filterPayrollWorkspace(payroll, { payroll_attendance: read });
  assert.equal(attendance.employees[0].basic,0); assert.equal(attendance.employees[0].pf.own,0); assert.equal(attendance.run,null); assert.deepEqual(attendance.bills,[]); assert.deepEqual(attendance.leaves,[]); assert.equal(attendance.attendance.records.length,1);
  const overview = filterPayrollWorkspace(payroll, { overview: read });
  assert.equal(overview.overview.netTotal,100); assert.equal(overview.run,null); assert.equal(overview.employees[0].basic,0); assert.deepEqual(overview.attendance.records,[]);
  const salary = filterPayrollWorkspace(payroll, { payroll_run: read }); assert.equal(salary.run.rows[0].net,100); assert.equal(salary.employees[0].pf.own,0);
});
test('permission unions never turn a read grant into a write grant', () => {
  assert.deepEqual(mergePermissions([{permissions:{income:read}},{permissions:{expenses:rw}}]),{income:read,expenses:rw});
});
test('authentication reloads the scoped role on every request and never treats its auditor storage row as independent access', async () => {
  const { authenticate } = await import('../dist/core/security/auth.middleware.js');
  const { signAccessToken } = await import('../dist/core/security/jwt.js');
  const token = signAccessToken({ sessionId:'session',userId:'user',tenantId:'tenant' });
  let permissions = { expenses: read };
  prisma.session.findFirst = async () => (normalizedAccountRelations({ id:'session',userId:'user',tenantId:'tenant',activeProjectId:'project',impersonatorSessionId:null,user:{id:'user',isActive:true,lastActiveAt:new Date()} }));
  prisma.projectMembership.findMany = async ({ where }) => {
    assert.equal(where.projectId,'project'); assert.equal(where.tenantId,'tenant'); assert.equal(where.userId,'user'); assert.equal(where.isActive,true);
    return [{role:'auditor',customRoleId:'role',customRole:{id:'role',tenantId:'tenant',projectId:'project',permissions},memberId:null}];
  };
  const request = () => ({originalUrl:'/v1/expenses',method:'GET',query:{},body:{},header:name=>name==='authorization'?`Bearer ${token}`:name==='x-project-id'?'project':undefined});
  const run = async r => { let error; await authenticate(r,{},e=>{error=e;}); if(error)throw error; return r.auth; };
  const auth = await run(request()); assert.deepEqual(auth.builtinRoles,[]); assert.equal(auth.customRoleOnly,true); assert.deepEqual(auth.roles,['auditor']);
  permissions = { income: read };
  await assert.rejects(run(request()), /not allowed/);
});
test('supporting account lists remain readable for ledger and deposit writers without granting account changes', async () => {
  await enforceMenuAccess(req('/v1/accounts','GET',{ledger:read}));
  await enforceMenuAccess(req('/v1/accounts','GET',{deposits:rw}));
  await assert.rejects(enforceMenuAccess(req('/v1/accounts/a/adjust','POST',{deposits:rw})),/not allowed/);
});
test('a composite Billing subscriber needs each affected menu and cannot bypass invoice permissions', async () => {
  await assert.rejects(enforceMenuAccess(req('/v1/billing/subscribers','POST',{customers:rw},[],{start:'this_month'})),/requires Write/);
  await enforceMenuAccess(req('/v1/billing/subscribers','POST',{customers:rw,billing_units:rw,billing_subscriptions:rw},[],{start:'next_month'}));
  await assert.rejects(enforceMenuAccess(req('/v1/billing/subscribers','POST',{customers:rw,billing_units:rw,billing_subscriptions:rw},[],{start:'this_month'})),/requires Write/);
});
test('Construction inbox approval does not permit creating or paying the source records', async () => {
  const original=prisma.project.findFirst; prisma.project.findFirst=async()=>({projectType:'construction'});
  try {
    await enforceMenuAccess(req('/v1/construction/running-bills/bill/decision','POST',{construction_approvals:rw}));
    await assert.rejects(enforceMenuAccess(req('/v1/construction/running-bills','POST',{construction_approvals:rw})),/not allowed/);
    await assert.rejects(enforceMenuAccess(req('/v1/construction/payments','POST',{construction_approvals:rw})),/not allowed/);
  } finally {prisma.project.findFirst=original;}
});

test('Construction phase plans use budget access and cannot be changed through approval-only permissions',async()=>{
 await enforceMenuAccess(req('/v1/construction/phases','GET',{construction_budgets:read}));
 await assert.rejects(enforceMenuAccess(req('/v1/construction/phases/p','PUT',{construction_budgets:read})),/not allowed/);
 await enforceMenuAccess(req('/v1/construction/phases/p','PUT',{construction_budgets:rw}));
 await enforceMenuAccess(req('/v1/construction/phases/assignees','GET',{construction_budgets:rw}));
 await assert.rejects(enforceMenuAccess(req('/v1/construction/phases/p','PUT',{construction_approvals:rw})),/not allowed/);
});

test('Construction structure lookup is available to site users while structure editing stays with Budgets',async()=>{
 await enforceMenuAccess(req('/v1/construction/structure','GET',{construction_site_log:read}));
 await enforceMenuAccess(req('/v1/construction/structure','GET',{construction_boq:read}));
 await assert.rejects(enforceMenuAccess(req('/v1/construction/tasks','POST',{construction_site_log:rw})),/not allowed/);
 await assert.rejects(enforceMenuAccess(req('/v1/construction/locations/location','PUT',{construction_budgets:read})),/not allowed/);
 await enforceMenuAccess(req('/v1/construction/work-packages','POST',{construction_budgets:rw}));
 await assert.rejects(enforceMenuAccess(req('/v1/construction/structure','GET',{construction_payments:rw})),/not allowed/);
});


test('site control decisions need their own menu and evidence is readable with site control access',async()=>{
 const original=prisma.project.findFirst,upload=prisma.upload.findFirst;prisma.project.findFirst=async()=>({projectType:'construction'});prisma.upload.findFirst=async()=>({purpose:'construction_site'});
 try {
  await enforceMenuAccess(req('/v1/construction/control','GET',{construction_control:read}));
  await assert.rejects(enforceMenuAccess(req('/v1/construction/control/versions/id/decision','POST',{construction_approvals:rw})),/not allowed/);
  await assert.rejects(enforceMenuAccess(req('/v1/construction/control/measurements/id/decision','POST',{construction_control:read})),/not allowed/);
  await enforceMenuAccess(req('/v1/construction/control/versions/id/decision','POST',{construction_control:rw}));
  await enforceMenuAccess(req('/v1/uploads/file/view','GET',{construction_control:read}));
 }finally{prisma.project.findFirst=original;prisma.upload.findFirst=upload;}
});


test('contractor work and measured bills keep source-menu writes, inbox reviews, payments and evidence access separate',async()=>{
 const original=prisma.project.findFirst;prisma.project.findFirst=async()=>({projectType:'construction'});try{
  await enforceMenuAccess(req('/v1/construction/contracts/options','GET',{construction_contractors:read}));
  await enforceMenuAccess(req('/v1/construction/running-bills/options','GET',{construction_running_bills:read}));
  await assert.rejects(enforceMenuAccess(req('/v1/construction/contracts/measured','POST',{construction_contractors:read})),/not allowed/);
  await enforceMenuAccess(req('/v1/construction/contracts/measured','POST',{construction_contractors:rw}));
  await assert.rejects(enforceMenuAccess(req('/v1/construction/running-bills/measured','POST',{construction_contractors:rw})),/not allowed/);
  await enforceMenuAccess(req('/v1/construction/contracts/c/decision','POST',{construction_approvals:rw}));
  await assert.rejects(enforceMenuAccess(req('/v1/construction/contracts/measured','POST',{construction_approvals:rw})),/not allowed/);
  await assert.rejects(enforceMenuAccess(req('/v1/construction/payments','POST',{construction_contractors:rw,construction_running_bills:rw})),/not allowed/);
 }finally{prisma.project.findFirst=original;}
});
