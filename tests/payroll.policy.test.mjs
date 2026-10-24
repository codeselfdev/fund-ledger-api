import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.DATABASE_URL ??= 'postgresql://unused:unused@localhost:55439/payroll_test';
process.env.JWT_SECRET ??= 'disposable-payroll-tests';
const p = await import('../dist/modules/payroll/payroll.policy.js');
const { projectTypeSchema } = await import('../dist/core/projects/project-settings.js');
const { access } = await import('../dist/modules/payroll/payroll.service.js');
const employee = { id:'employee', name:'Sadia', joiningDate:new Date('2021-01-01T00:00:00Z'), probationCompletedOn:new Date('2021-04-01T00:00:00Z'), basic:32000, medical:3000, transport:2500, pfMember:true, advance:0 };
test('payroll project type and strict independent financial roles', () => {
 assert.equal(projectTypeSchema.parse('payroll_pf'),'payroll_pf');assert.equal(p.mobile('e:01711482930@example.com'),'');
 const a=roles=>access({roles});
 assert.equal(a(['owner']).check,false);assert.equal(a(['accountant']).approve,false);assert.equal(a(['auditor']).pay,false);assert.equal(a(['member']).staff,false);
});
test('salary rows round to whole taka, include approved unpaid dates and preserve bill IDs', () => {
 const row=p.salaryRow(employee,'2026-10',p.DEFAULT_SETTINGS,[{type:'Unpaid',status:'approved',workingDates:['2026-10-29','2026-10-31','2026-11-01']}],[{id:'bill',amount:650}]);
 assert.equal(row.gross,53500);assert.equal(row.pf,3200);assert.equal(row.companyPF,3200);assert.equal(row.unpaidDays,2);assert.equal(row.unpaidDeduction,3567);assert.deepEqual(row.billIds,['bill']);assert.equal(row.net,row.gross-3567-3200-row.tax+650);
 const half=p.salaryRow(employee,'2026-10',{...p.DEFAULT_SETTINGS,basis:'gross',rate:7.5,match:'half'},[],[]);
 assert.equal(half.pf,4013);assert.equal(half.companyPF,2007);
});
test('probation and one-year PF eligibility are explicit rather than backdated contributions', () => {
 assert.equal(p.salaryRow({...employee,probationCompletedOn:null},'2026-10',p.DEFAULT_SETTINGS,[],[]).pf,0);
 assert.equal(p.salaryRow({...employee,joiningDate:new Date('2026-02-01')},'2026-10',{...p.DEFAULT_SETTINGS,eligibility:'one_year'},[],[]).pf,0);
 assert.equal(p.salaryRow(employee,'2026-10',{...p.DEFAULT_SETTINGS,match:'off'},[],[]).companyPF,0);
});
test('working days skip Fridays and vesting uses completed anniversaries', () => {
 assert.deepEqual(p.workingDates('2026-10-29',3),['2026-10-29','2026-10-31','2026-11-01']);
 assert.equal(p.completedYears('2021-10-25','2026-10-24'),4);assert.equal(p.completedYears('2021-10-24','2026-10-24'),5);
 assert.deepEqual([2,3,4,5].map(y=>p.vested(y,'graded')),[0,50,50,100]);
});
test('schema rejects money fractions, malformed dates, duplicate import identities and unexpected fields', () => {
 assert.equal(p.billSchema.safeParse({employee_id:'x',category:'Food',amount:1.5,date:'2026-10-24',note:'',receipt_file_id:'file',request_key:'01234567-89ab-4cde-8123-456789abcdef'}).success,false);
 assert.equal(p.monthSchema.safeParse('2026-13').success,false);
 const row={name:'One',mobile:'01711482930',basic:'32000',medical:'0',transport:'0',designation:'Officer',department:'Finance',pfMember:true,joiningDate:'2026-02-30'};
 assert.equal(p.importSchema.safeParse({rows:[row],match_by:'mobile',request_key:'01234567-89ab-4cde-8123-456789abcdef'}).success,false);
 assert.equal(p.importSchema.safeParse({rows:[{...row,joiningDate:'2026-11-01'},{...row,mobile:'+8801711482930',joiningDate:'2026-11-01'}],match_by:'mobile',request_key:'01234567-89ab-4cde-8123-456789abcdef'}).success,false);
});
