import test from 'node:test';
import assert from 'node:assert/strict';
const {financialSummary,financialSummaryQuery}=await import('../dist/modules/ai-service/financial-summary.js');
const scope={tenantId:'org',projectId:'p'},period={from:'2026-10-01',to:'2026-10-23'};
function scoped(query){assert.equal(query.where.tenantId,'org');assert.equal(query.where.projectId,'p');}
test('expense summary projects aggregate category and payment totals without transaction/sales detail',async()=>{
 const queries=[],db={expense:{groupBy:async query=>{scoped(query);queries.push(query);return query.by.includes('status')?[{status:'paid',_sum:{amount:300},_count:1},{status:'approved',_sum:{amount:200},_count:1}]:[{category:'services',categoryDefId:'meals',_sum:{amount:300},_count:1},{category:'materials',categoryDefId:null,_sum:{amount:200},_count:1}];}},expenseCategoryDef:{findMany:async query=>{scoped(query);return[{id:'meals',name:'Meals'}];}}};
 const result=await financialSummary(db,scope,{kind:'expense',...period});assert.equal(result.total,500);assert.equal(result.count,2);assert.equal(result.paid,300);assert.equal(result.awaiting_payment,200);assert.equal(result.breakdown[0].label,'Meals');
 assert.deepEqual(queries[0].where.status.in,['approved','paid']);assert.equal(queries[0].where.OR[0].expenseDate.gte.toISOString(),'2026-10-01T00:00:00.000Z');assert.equal(queries[0].where.OR[1].createdAt.gte.toISOString(),'2026-09-30T18:00:00.000Z');assert.doesNotMatch(JSON.stringify(result),/customer|products|profit|vendor|revenue/);
});
test('income summary counts only manual income credits and returns category and account totals',async()=>{
 const db={accountTransaction:{groupBy:async query=>{scoped(query);assert.equal(query.where.referenceType,'income');assert.equal(query.where.direction,'money_in');return query.by.includes('accountId')?[{accountId:'bank',_sum:{amount:700},_count:2}]:[{incomeCategoryId:'rent',_sum:{amount:500},_count:1},{incomeCategoryId:null,incomeSource:'Store rent',_sum:{amount:200},_count:1}];}},incomeCategory:{findMany:async query=>{scoped(query);return[{id:'rent',name:'Rent'}];}},account:{findMany:async query=>{scoped(query);return[{id:'bank',name:'Main Bank'}];}}};
 const result=await financialSummary(db,scope,{kind:'income',...period});assert.equal(result.total,700);assert.equal(result.count,2);assert.equal(result.accounts[0].label,'Main Bank');assert.equal(result.breakdown[1].label,'Store rent');assert.equal(result.transactions,undefined);
 assert.equal(financialSummaryQuery.safeParse({kind:'income',from:'2026-02-30',to:'2026-10-23'}).success,false);assert.equal(financialSummaryQuery.safeParse({kind:'expense',from:'2026-11-01',to:'2026-10-23'}).success,false);
});

test('large category breakdowns reconcile to the total after combining lower-value groups as Other',async()=>{
 const groups=Array.from({length:8},(_,i)=>({category:'services',categoryDefId:'c'+i,_sum:{amount:(i+1)*100},_count:1}));
 const db={expense:{groupBy:async query=>query.by.includes('status')?[{status:'paid',_sum:{amount:3600},_count:8}]:groups},expenseCategoryDef:{findMany:async()=>groups.map((row,i)=>({id:row.categoryDefId,name:'Category '+i}))}};
 const result=await financialSummary(db,scope,{kind:'expense',...period});assert.equal(result.total,3600);assert.equal(result.breakdown.length,5);assert.equal(result.breakdown.at(-1).label,'Other');assert.equal(result.breakdown.reduce((total,row)=>total+row.total,0),result.total);
});
