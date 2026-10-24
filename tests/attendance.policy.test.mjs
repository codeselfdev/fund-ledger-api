import assert from 'node:assert/strict';import {test} from 'node:test';
const p=await import('../dist/modules/payroll/attendance.policy.js');
const salary=await import('../dist/modules/payroll/payroll.policy.js');
const employee={id:'e',name:'Sadia',joiningDate:new Date('2026-10-01'),probationCompletedOn:null,basic:20000,medical:0,transport:0,pfMember:false,advance:0};
const record=(date,status)=>({date:new Date(date),status});
test('explicit half days and absences deduct at gross / 30 with no duplicate leave deduction',()=>{
 const row=salary.salaryRow(employee,'2026-10',salary.DEFAULT_SETTINGS,[{type:'Unpaid',status:'approved',workingDates:['2026-10-01']}],[],[record('2026-10-01','absent'),record('2026-10-03','half_day'),record('2026-10-04','late'),record('2026-10-05','present')]);
 assert.equal(row.unpaidDays,1.5);assert.equal(row.attendanceUnpaidDays,.5);assert.equal(row.leaveUnpaidDays,1);assert.equal(row.unpaidDeduction,1500);
 assert.equal(salary.salaryRow(employee,'2026-10',salary.DEFAULT_SETTINGS,[],[]).unpaidDeduction,0);
});
test('paid leave, holidays, Fridays, before joining and other months cannot become attendance deductions',()=>{
 const leaves=[{type:'Annual',status:'approved',workingDates:['2026-10-04']}];
 const result=p.unpaidAttendance('2026-10','2026-10-03',leaves,[record('2026-10-01','absent'),record('2026-10-02','absent'),record('2026-10-04','absent'),record('2026-10-20','absent'),record('2026-11-01','half_day')],[{date:'2026-10-20'}]);assert.equal(result.total,0);
});
test('office distance and Dhaka late threshold use real coordinates and timezone',()=>{
 assert.equal(p.officeDistance(23.8,90.4,23.8,90.4),0);assert.ok(p.officeDistance(23.81,90.4,23.8,90.4)>1000);
 assert.equal(p.dhakaClock(new Date('2026-10-24T03:15:00Z')),'09:15');assert.equal(p.dhakaClock(new Date('2026-10-24T03:16:00Z')),'09:16');
});
test('strict attendance inputs reject forged timestamps, impossible shifts, duplicate holidays and missing GPS settings',()=>{
 const config={...p.DEFAULT_ATTENDANCE,latitude:23.8,longitude:90.4};assert.equal(p.attendanceSettingsSchema.safeParse(config).success,true);
 for(const patch of [{shiftStart:'25:00'},{lateAfter:'08:00'},{shiftEnd:'08:00'},{gpsRequired:false},{latitude:null},{radiusM:0},{holidays:[{date:'2026-02-30',name:'Invalid'}]},{holidays:[{date:'2026-10-20',name:'One'},{date:'2026-10-20',name:'Two'}]}])assert.equal(p.attendanceSettingsSchema.safeParse({...config,...patch}).success,false);
 const key='01234567-89ab-4cde-8123-456789abcdef';assert.equal(p.attendancePunchSchema.safeParse({action:'in',request_key:key,check_in:'2026-10-24T03:00:00Z'}).success,false);assert.equal(p.attendanceMarkSchema.safeParse({employee_id:'e',date:'2026-10-24',status:'absent',reason:'',revision:null,request_key:key}).success,false);
});
