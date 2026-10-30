import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {contractorWorkSchema,workforceSummary,verifiedOutput} from '../dist/modules/construction/construction-workforce.engine.js';
const item=randomUUID(),contract={id:'contract',workItems:[{id:item,name:'Electrical points',quantity:100,rate:100,unit:'points'}],workTerms:{start_date:'2026-01-01',end_date:'2026-01-10'}};
const log=(day,quantity,status='approved',workers=5)=>({id:day,version:3,workDate:new Date(day+'T00:00:00Z'),status,content:{contractor_work:[{id:randomUUID(),contract_id:'contract',crew:[{trade:'Electrician',workers}],outputs:quantity?[{work_item_id:item,quantity}]:[],note:'',delay_reason:''}]}});
test('workforce tracks attendance separately from verified output and excludes drafts, rejected reports and future dates',()=>{
 const logs=[log('2026-01-01',10),log('2026-01-02',20,'pending'),log('2026-01-03',50,'draft'),log('2026-01-03',40,'rejected'),log('2026-01-04',30)];const row=workforceSummary(contract,logs,'2026-01-03');assert.equal(row.worker_days,10);assert.equal(row.items[0].reported_quantity,30);assert.equal(row.items[0].verified_quantity,10);assert.equal(row.verified_percent,10);assert.equal(row.forecast_finish,null);assert.equal(row.schedule_status,'insufficient_data');
});
test('finish estimates use calendar-day pace and remain unknown with sparse or missing item output',()=>{
 const logs=[log('2026-01-01',10),log('2026-01-02',10)];let row=workforceSummary(contract,logs,'2026-01-02');assert.equal(row.forecast_finish,'2026-01-10');assert.equal(row.schedule_status,'on_track');row=workforceSummary(contract,logs,'2026-01-04');assert.equal(row.forecast_finish,'2026-01-20');assert.equal(row.schedule_status,'at_risk');assert.equal(workforceSummary(contract,logs,'2026-02-01').forecast_finish,null);assert.equal(workforceSummary({...contract,workItems:[...contract.workItems,{id:randomUUID(),name:'Another item',unit:'job',quantity:1,rate:100}]},logs,'2026-01-02').forecast_finish,null);
});
test('work completed is separate from an overdue deadline and uses rate-weighted quantities rather than mixed units',()=>{
 assert.equal(workforceSummary(contract,[log('2026-01-01',20)],'2026-01-11').schedule_status,'overdue');assert.equal(workforceSummary(contract,[log('2026-01-01',100)],'2026-01-11').schedule_status,'complete');assert.equal(workforceSummary({...contract,workItems:[]},[],'2026-01-02').verified_percent,null);
});
test('source quantities use fixed thousandths and preserve the exact reviewed log version',()=>{
 const logs=[log('2026-01-01',0.1),log('2026-01-02',0.2)];const result=verifiedOutput('contract',logs,'2026-01-02');assert.equal(result.quantities[item],0.3);assert.equal(result.sources[item][0].version,3);assert.equal(verifiedOutput('other',logs,'2026-01-02').quantities[item],undefined);
});
test('crew records cannot contain wage rates or duplicate outputs',()=>{
 const row=log('2026-01-01',1).content.contractor_work[0];assert.ok(contractorWorkSchema.safeParse(row).success);assert.equal(contractorWorkSchema.safeParse({...row,rate:500}).success,false);assert.equal(contractorWorkSchema.safeParse({...row,outputs:[row.outputs[0],row.outputs[0]]}).success,false);
});
