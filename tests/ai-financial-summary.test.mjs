import test from 'node:test';
import assert from 'node:assert/strict';
const {financialSummary,financialSummaryQuery}=await import('../dist/modules/ai-service/financial-summary.js');
const scope={tenantId:'org',projectId:'p'},period={from:'2026-10-01',to:'2026-10-23'};
function scoped(query){assert.equal(query.where.tenantId,'org');assert.equal(query.where.projectId,'p');}
test('expense summary projects aggregate category and payment totals without transaction/sales detail',async()=>{
 const queries=[],db={expense:{groupBy:async query=>{scoped(query);queries.push(query);return query.by.includes('status')?[{status:'paid',_sum:{amount:300},_count:1},{status:'approved',_sum:{amount:200},_count:1}]:[{category:'services',categoryDefId:'meals',_sum:{amount:300},_count:1},{category:'materials',categoryDefId:null,_sum:{amount:200},_count:1}];}},expenseCategoryDef:{findMany:async query=>{scoped(query);return[{id:'meals',name:'Meals'}];}}};
 const result=await financialSummary(db,scope,{kind:'expense',date_basis:'expense_date',...period});assert.equal(result.total,500);assert.equal(result.count,2);assert.equal(result.paid,300);assert.equal(result.awaiting_payment,200);assert.equal(result.breakdown[0].label,'Meals');
 assert.deepEqual(queries[0].where.status.in,['approved','paid']);assert.equal(queries[0].where.OR[0].expenseDate.gte.toISOString(),'2026-10-01T00:00:00.000Z');assert.equal(queries[0].where.OR[2].createdAt.gte.toISOString(),'2026-09-30T18:00:00.000Z');assert.doesNotMatch(JSON.stringify(result),/customer|products|profit|vendor|revenue/);
});
test('income summary counts only manual income credits and returns category and account totals',async()=>{
 const db={accountTransaction:{groupBy:async query=>{scoped(query);assert.equal(query.where.referenceType,'income');assert.equal(query.where.direction,'money_in');return query.by.includes('accountId')?[{accountId:'bank',_sum:{amount:700},_count:2}]:[{incomeCategoryId:'rent',_sum:{amount:500},_count:1},{incomeCategoryId:null,incomeSource:'Store rent',_sum:{amount:200},_count:1}];}},incomeCategory:{findMany:async query=>{scoped(query);return[{id:'rent',name:'Rent'}];}},account:{findMany:async query=>{scoped(query);return[{id:'bank',name:'Main Bank'}];}}};
 const result=await financialSummary(db,scope,{kind:'income',...period});assert.equal(result.total,700);assert.equal(result.count,2);assert.equal(result.accounts[0].label,'Main Bank');assert.equal(result.breakdown[1].label,'Store rent');assert.equal(result.transactions,undefined);
 assert.equal(financialSummaryQuery.safeParse({kind:'expense',...period,account_name:'Cashbox'}).success,false);assert.equal(financialSummaryQuery.safeParse({kind:'income',...period,date_basis:'payment_date'}).success,false);
 assert.equal(financialSummaryQuery.safeParse({kind:'income',from:'2026-02-30',to:'2026-10-23'}).success,false);assert.equal(financialSummaryQuery.safeParse({kind:'expense',from:'2026-11-01',to:'2026-10-23'}).success,false);
});

test('large category breakdowns reconcile to the total after combining lower-value groups as Other',async()=>{
 const groups=Array.from({length:8},(_,i)=>({category:'services',categoryDefId:'c'+i,_sum:{amount:(i+1)*100},_count:1}));
 const db={expense:{groupBy:async query=>query.by.includes('status')?[{status:'paid',_sum:{amount:3600},_count:8}]:groups},expenseCategoryDef:{findMany:async()=>groups.map((row,i)=>({id:row.categoryDefId,name:'Category '+i}))}};
 const result=await financialSummary(db,scope,{kind:'expense',...period});assert.equal(result.total,3600);assert.equal(result.breakdown.length,5);assert.equal(result.breakdown.at(-1).label,'Other');assert.equal(result.breakdown.reduce((total,row)=>total+row.total,0),result.total);
});


function recordsFixture(){
 const expenses=[
  {tenantId:'org',projectId:'p',status:'paid',amount:8800,category:'services',categoryDefId:null,expenseDate:new Date('2026-09-15'),paidAt:new Date('2026-10-23T17:00:00Z'),createdAt:new Date('2026-09-15')},
  {tenantId:'org',projectId:'p',status:'paid',amount:500,category:'services',categoryDefId:null,expenseDate:new Date('2026-10-05'),paidAt:new Date('2026-10-05T10:00:00Z'),createdAt:new Date('2026-10-05')},
  {tenantId:'org',projectId:'p',status:'approved',amount:200,category:'materials',categoryDefId:null,expenseDate:new Date('2026-10-05'),paidAt:null,createdAt:new Date('2026-10-05')},
 ];
 const accounts=[{...scope,id:'cash',name:'Cashbox'},{...scope,id:'bank',name:'Bank'},{tenantId:'org',projectId:'foreign',id:'foreign',name:'Foreign account'}];
 const income=[['cash',700],['bank',300],['foreign',999]].map(([accountId,amount])=>({...scope,projectId:accountId==='foreign'?'foreign':'p',accountId,amount,direction:'money_in',referenceType:'income',incomeCategoryId:null,incomeSource:'Rent',occurredOn:new Date('2026-10-10'),createdAt:new Date('2026-10-10')}));
 const matches=(row,where)=>Object.entries(where).every(([key,value])=>key==='OR'?value.some(clause=>matches(row,clause)):value&&typeof value==='object'&&!(value instanceof Date)?('in' in value?value.in.includes(row[key]):'equals' in value?String(row[key]).toLowerCase()===value.equals.toLowerCase():row[key]!=null&&(!value.gte||row[key]>=value.gte)&&(!value.lt||row[key]<value.lt)):row[key]===value);
 const aggregate=records=>async({where,by})=>{const grouped=new Map();for(const row of records.filter(row=>matches(row,where))){const key=JSON.stringify(by.map(field=>row[field]));const result=grouped.get(key)??{...Object.fromEntries(by.map(field=>[field,row[field]])),_sum:{amount:0},_count:0};result._sum.amount+=row.amount;result._count++;grouped.set(key,result);}return [...grouped.values()];};
 return{expenses,income,accounts,db:{expense:{groupBy:aggregate(expenses)},expenseCategoryDef:{findMany:async()=>[]},accountTransaction:{groupBy:aggregate(income)},incomeCategory:{findMany:async()=>[]},account:{findMany:async({where})=>accounts.filter(row=>matches(row,where))}}};
}
test('payment-date summary reconciles the dashboard 9300 while receipt dates keep the earlier 8800 out',async()=>{
 const {db,expenses}=recordsFixture();
 const paid=await financialSummary(db,scope,{kind:'expense',...period});assert.equal(paid.total,9300);assert.equal(paid.paid,9300);assert.equal(paid.count,2);assert.equal(paid.awaiting_payment,0);assert.equal(paid.date_basis,'payment_date');
 const receipts=await financialSummary(db,scope,{kind:'expense',date_basis:'expense_date',...period});assert.equal(receipts.total,700);assert.equal(receipts.paid,500);assert.equal(receipts.awaiting_payment,200);
 // Bangladesh midnight and legacy records without a paidAt retain dashboard semantics.
 expenses.push({...expenses[0],amount:100,paidAt:new Date('2026-09-30T18:00:00Z')},{...expenses[0],amount:50,paidAt:null,createdAt:new Date('2026-10-23T17:59:59Z')},{...expenses[0],amount:900,paidAt:new Date('2026-10-23T18:00:00Z')});
 assert.equal((await financialSummary(db,scope,{kind:'expense',...period})).total,9450);
});
test('account income summaries filter both totals and breakdowns to a unique project account',async()=>{
 const {db,accounts}=recordsFixture();
 const all=await financialSummary(db,scope,{kind:'income',...period});assert.equal(all.total,1000);
 for(const filter of [{account_name:'cashbox'},{account_id:'cash'}]){const selected=await financialSummary(db,scope,{kind:'income',...period,...filter});assert.equal(selected.total,700);assert.equal(selected.count,1);assert.equal(selected.account.name,'Cashbox');assert.equal(selected.accounts.length,1);assert.equal(selected.accounts[0].label,'Cashbox');}
 for(const account_name of ['Missing','Foreign account'])await assert.rejects(financialSummary(db,scope,{kind:'income',...period,account_name}),/No matching account/);
 accounts.push({...scope,id:'cash2',name:'Cashbox'});await assert.rejects(financialSummary(db,scope,{kind:'income',...period,account_name:'Cashbox'}),/More than one/);
});
