import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL??='postgresql://unused:unused@localhost:55439/payroll_test';process.env.JWT_SECRET??='disposable-payroll-tests';
const p=await import('../dist/modules/payroll/portal.policy.js');
const pay=await import('../dist/modules/payroll/portal.pay.js');
const {workspaceAccess}=await import('../dist/modules/payroll/payroll.service.js');
const {portalGrant}=await import('../dist/modules/payroll/portal.service.js');
const {payrollPersonalRoute}=await import('../dist/core/security/payroll-personal-routes.js');
const {routeMenuKeys}=await import('../dist/core/security/menu-access.policy.js');
const terms={...pay.defaultTerms({basic:30000,medical:3000,transport:2000,pfMember:true})};
const profile={terms,promotions:[],grade:3,designationId:'executive'};
test('personal route exceptions never include HR configuration, other employee profiles, decisions or payments',()=>{
 for(const path of ['/v1/payroll/portal/employees','/v1/payroll/portal/employees/another','/v1/payroll/portal/employees/another/promote','/v1/payroll/portal/projects','/v1/payroll/portal/departments','/v1/payroll/portal/designations','/v1/payroll/runs/id/disburse','/v1/payroll/bills/id/approve','/v1/payroll/settings'])for(const method of ['GET','POST','PATCH','PUT','DELETE'])assert.equal(payrollPersonalRoute(path,method),false,`${method} ${path}`);
 assert.equal(payrollPersonalRoute('/v1/payroll/portal/tasks/id','PATCH'),true);
 assert.equal(payrollPersonalRoute('/v1/payroll/portal/workspace','GET'),true);
 assert.equal(payrollPersonalRoute('/v1/payroll/portal/documents','POST'),false);
 assert.deepEqual(routeMenuKeys('/v1/payroll/portal/employees','POST'),['payroll_employees']);
 assert.deepEqual(routeMenuKeys('/v1/payroll/portal/projects','POST'),['payroll_projects']);
});
test('HR and live location require independent explicit grants; synthetic middleware admin cannot widen a custom role',()=>{
 for(const role of ['member','cashier','accountant','approver']){assert.equal(portalGrant({roles:[role]},'payroll_employees'),false);assert.equal(portalGrant({roles:[role]},'payroll_location'),false);}
 assert.equal(portalGrant({roles:['auditor']},'payroll_location'),false);
 assert.equal(portalGrant({roles:['owner']},'payroll_location',true),true);
 const custom={roles:['admin'],builtinRoles:[],menuPermissions:{payroll_tasks:{read:true,write:true}}};
 assert.equal(portalGrant(custom,'payroll_employees',true),false);assert.equal(portalGrant(custom,'payroll_tasks',true),true);
});
test('project allocation catches peak concurrent load and allows sequential assignments',()=>{
 const base={id:'new',status:'active',startDate:'2026-11-01',endDate:'2026-12-31',team:[{employeeId:'one',percent:50}]};
 const others=[{...base,id:'a',startDate:'2026-11-01',endDate:'2026-11-30',team:[{employeeId:'one',percent:50}]},{...base,id:'b',startDate:'2026-12-01',endDate:'2026-12-31',team:[{employeeId:'one',percent:50}]}];
 assert.equal(p.allocationIssue(base,others),null);others[1].startDate='2026-11-15';assert.match(p.allocationIssue(base,others),/exceed 100/);
});
test('compensation honors effective dates, joining dates, contract end and completed hourly punches',()=>{
 const promoted={...profile,promotions:[{basic:60000,grade:4,designationId:'senior',effectiveDate:'2026-11-16'}]};
 assert.equal(pay.monthlyEmployment('2020-01-01',promoted,'2026-10',[]).basic,30000);
 assert.equal(pay.monthlyEmployment('2020-01-01',promoted,'2026-11',[]).basic,45000);
 assert.equal(pay.monthlyEmployment('2020-01-01',promoted,'2026-12',[]).basic,60000);
 const contract={...profile,terms:{...terms,type:'contractual',monthlyFee:30000,contractStart:'2026-11-01',contractEnd:'2026-11-15',pfMember:false}};
 assert.equal(pay.monthlyEmployment('2026-11-01',contract,'2026-11',[]).basic,15000);assert.equal(pay.monthlyEmployment('2026-11-01',contract,'2026-12',[]).basic,0);
 const hourly={...profile,terms:{...terms,type:'part_time',hourlyRate:500,pfMember:false}},records=[{date:new Date('2026-11-01'),status:'present',checkIn:new Date('2026-11-01T03:00Z'),checkOut:new Date('2026-11-01T06:30Z')},{date:new Date('2026-11-02'),status:'present',checkIn:new Date('2026-11-02T03:00Z'),checkOut:null}];
 const result=pay.monthlyEmployment('2026-11-01',hourly,'2026-11',records);assert.equal(result.basic,1750);assert.equal(result.payableHours,3.5);assert.equal(result.houseRent,0);assert.equal(result.pfMember,false);
});
test('strict inputs reject forged employee/time fields, invalid dates and incomplete employment terms',()=>{
 assert.equal(p.locationConsentSchema.safeParse({consent:true,employeeId:'other',request_key:'01234567-89ab-4cde-8123-456789abcdef'}).success,false);
 assert.equal(p.termsSchema.safeParse({...terms,type:'contractual',contractStart:'2026-11-10',contractEnd:'2026-11-01',monthlyFee:20000}).success,false);
 assert.equal(p.splitSchema.safeParse({date:'2026-02-30',revision:null,allocations:[{projectId:'one',percent:100}],request_key:'01234567-89ab-4cde-8123-456789abcdef'}).success,false);
 assert.equal(p.termsSchema.safeParse({...terms,type:'part_time',hourlyRate:100,pfMember:true}).success,false);
});

test('personal payroll reads never turn synthetic custom-role auditor access into team salary access',()=>{const a={roles:['auditor'],builtinRoles:[],menuPermissions:{payroll_tasks:{read:true,write:true}}};assert.equal(workspaceAccess(a).staff,false);assert.equal(workspaceAccess(a).member,true);assert.equal(workspaceAccess({...a,menuPermissions:{payroll_run:{read:true,write:false}}}).staff,true);});
test('location requests: managers need the Live location grant; only the answer route is personal',()=>{
 assert.deepEqual(routeMenuKeys('/v1/payroll/portal/employees/emp-1/location-request','POST'),['payroll_location']);
 assert.deepEqual(routeMenuKeys('/v1/payroll/portal/location-requests/req-1','PUT'),['payroll_location']);
 assert.equal(payrollPersonalRoute('/v1/payroll/portal/employees/emp-1/location-request','POST'),false);
 assert.equal(payrollPersonalRoute('/v1/payroll/portal/location-requests/req-1','PUT'),true);
 assert.equal(payrollPersonalRoute('/v1/payroll/portal/location-requests/req-1/extra','PUT'),false);
 assert.equal(p.locationRequestAnswerSchema.safeParse({accept:true,revision:0,request_key:'7f6c2b0e-4c1a-4d7e-9a51-3f2e8d1b6a90'}).success,true);
 assert.equal(p.locationRequestSchema.safeParse({request_key:'7f6c2b0e-4c1a-4d7e-9a51-3f2e8d1b6a90',employeeId:'x'}).success,false);
});
