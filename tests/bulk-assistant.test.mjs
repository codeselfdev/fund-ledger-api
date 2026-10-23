import assert from 'node:assert/strict';
import {test,before,after,beforeEach} from 'node:test';
import {randomUUID} from 'node:crypto';
import express from 'express';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'synthetic-bulk-assistant-test-secret'});
const {prisma}=await import('../dist/core/prisma/client.js');
const {bulkAssistantRouter}=await import('../dist/modules/ai-service/bulk.routes.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
let state,type,roles,flow,failAt,server,base;
const auth={tenantId:'tenant',projectId:'project',userId:'user'};
const scoped=w=>{assert.equal(w.tenantId,'tenant');assert.equal(w.projectId,'project');};
before(async()=>{
 prisma.$queryRaw=async()=>[];
 prisma.$transaction=async fn=>{const before=structuredClone(state);try{return await fn(prisma);}catch(e){state=before;throw e;}};
 prisma.project.findFirst=async({where})=>{assert.equal(where.id,'project');assert.equal(where.tenantId,'tenant');return{projectType:type,stockManagementEnabled:false};};
 prisma.tenant.findUniqueOrThrow=async()=>({currency:'BDT'});
 prisma.onboardingProgress.findUnique=async()=>({incomeApprovalFlow:flow,expenseApprovalFlow:'accountant_and_approver'});
 prisma.businessConfiguration.findFirst=async()=>null;prisma.businessField.findMany=async()=>[];
 for(const [name,key]of [['customer','customers'],['vendor','dealers'],['inventoryItem','items']]){
  prisma[name].findMany=async({where})=>{scoped(where);return structuredClone(state[key]);};
  prisma[name].findFirst=async({where})=>{scoped(where);return state[key].find(r=>where.id?r.id===where.id:r.name===where.name)??null;};
  prisma[name].create=async({data})=>{scoped(data);if(failAt===state[key].length+1)throw Error('Simulated storage failure');const row={id:`${key}-${state[key].length}`,quantity:0,...data};state[key].push(row);return row;};
 }
 prisma.inventoryItem.update=async({where,data})=>{const row=state.items.find(item=>item.id===where.id);assert.ok(row);Object.assign(row,data);return row;};
 prisma.inventoryCategory.findMany=async({where})=>{scoped(where);return state.categories.filter(category=>category.isActive);};
 prisma.inventoryCategory.findFirst=async({where})=>{scoped(where);return state.categories.find(category=>category.id===where.id&&category.isActive)??null;};
 prisma.account.findFirst=prisma.account.findFirstOrThrow=async({where})=>{scoped(where);return state.accounts.find(a=>a.id===where.id)??null;};
 prisma.account.findMany=async({where})=>{scoped(where);return state.accounts;};
 prisma.account.updateMany=async({where,data})=>{scoped(where);const a=state.accounts.find(a=>a.id===where.id);if(!a||where.balance.gte!=null&&a.balance<where.balance.gte||where.balance.lte!=null&&a.balance>where.balance.lte)return{count:0};a.balance+=(data.balance.increment??0)-(data.balance.decrement??0);return{count:1};};
 for(const name of ['incomeCategory','expenseCategoryDef']){prisma[name].findMany=async()=>[];prisma[name].findFirst=async({where})=>{scoped(where);return null;};}
 prisma.accountTransaction.create=async({data})=>{scoped(data);if(failAt===state.transactions.length+1)throw Error('Simulated ledger failure');const row={id:`transaction-${state.transactions.length}`,...data};state.transactions.push(row);return row;};
 prisma.expense.create=async({data})=>{scoped(data);const row={id:`expense-${state.expenses.length}`,...data};state.expenses.push(row);return row;};
 prisma.activity.findFirst=async({where})=>{scoped(where);return state.activities.find(a=>a.id===where.id)??null;};
 prisma.activity.create=async({data})=>{scoped(data);state.activities.push(data);return data;};
 prisma.upload.findFirst=async({where})=>{scoped(where);return where.id==='proof'?{id:'proof'}:null;};
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.auth={...auth,roles};next();});app.use('/bulk',bulkAssistantRouter);app.use(errorHandler);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/bulk`;
});
beforeEach(()=>{type='billing';roles=['accountant'];flow='accountant_only';failAt=0;state={categories:[],customers:[],dealers:[],items:[],expenses:[],transactions:[],activities:[],accounts:[{id:'bank',name:'Bank',balance:100000}]};});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await prisma.$disconnect();});
const request=(path,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
const batch=(operation,rows)=>({operation,fields:{rows}});
async function preview(b){const r=await request('/preview',b);assert.equal(r.status,200,await r.clone().text());return(await r.json()).data;}
async function commit(b,targets,key=randomUUID()){return request('/actions',{...b,targets,request_key:key,verified_source_records:true});}
const income=amount=>({account_id:'bank',amount,source:'Consulting',income_date:'2026-10-01'});
const expense=amount=>({account_id:'bank',amount,title:'Rent',category:'services',expense_date:'2026-10-01'});
test('all four projects support customers, existing dealers and items, and previews create no records',async()=>{
 for(const p of ['fund_shares','accounting','billing','construction'])for(const[op,key]of [['bulk_customers','customers'],['bulk_dealers','dealers'],['bulk_items','items']]){type=p;state[key]=[];const b=batch(op,[{name:'ABC'},{name:'DEF'}]),plan=await preview(b);assert.equal(plan.project_type,p);assert.equal(state[key].length,0);assert.equal((await commit(b,plan)).status,200);assert.equal(state[key].length,2);}
});
test('all financial rows save together and incomes credit the correct running balances exactly once',async()=>{
 const b=batch('bulk_incomes',[income(100),income(250)]),plan=await preview(b),key=randomUUID();assert.equal(plan.total_amount,350);assert.equal(plan.entries[1].balance_after,100350);assert.equal(state.transactions.length,0);
 assert.equal((await commit(b,plan,key)).status,200);assert.equal(state.accounts[0].balance,100350);assert.equal(state.transactions.length,2);
 assert.equal((await commit(b,plan,key)).status,200);assert.equal(state.transactions.length,2);
});
test('accountants create expenses awaiting disbursement while administrators pay the entire batch',async()=>{
 const b=batch('bulk_expenses',[expense(100),{...expense(200),title:'Utilities'}]);let plan=await preview(b);assert.equal(plan.entries[0].status,'approved');assert.equal((await commit(b,plan)).status,200);assert.equal(state.accounts[0].balance,100000);assert.ok(state.expenses.every(e=>e.status==='approved'));
 roles=['admin'];plan=await preview(b);assert.equal(plan.entries[0].status,'paid');assert.equal((await commit(b,plan)).status,200);assert.equal(state.accounts[0].balance,99700);assert.equal(state.transactions.length,2);
});
test('duplicate records and transactions, invalid dates and foreign references block the entire batch',async()=>{
 for(const b of [batch('bulk_customers',[{name:'Same'},{name:'Same'}]),batch('bulk_dealers',[{name:'A',phone:'01711-000001'},{name:'B',phone:'+8801711000001'}]),batch('bulk_incomes',[income(10),income(10)]),batch('bulk_incomes',[income(10),{...income(20),account_id:'foreign'}]),batch('bulk_incomes',[{...income(10),income_date:'2026-02-30'}]),batch('bulk_items',[{name:'Cement',quantity:1}])]){assert.equal((await request('/preview',b)).status,400);assert.equal(state.transactions.length,0);assert.equal(state.customers.length,0);}
});
test('storage failure on a later row rolls back earlier records, ledger entries, balances and audit rows',async()=>{
 const b=batch('bulk_incomes',[income(100),income(200)]),plan=await preview(b);failAt=2;assert.equal((await commit(b,plan)).status,500);assert.equal(state.accounts[0].balance,100000);assert.equal(state.transactions.length,0);assert.equal(state.activities.length,0);
 const c=batch('bulk_customers',[{name:'Customer A'},{name:'Customer B'}]),p=await preview(c);assert.equal((await commit(c,p)).status,500);assert.equal(state.customers.length,0);
});
test('changed settings, balances, duplicate identities and tampered previews invalidate review before mutation',async()=>{
 const b=batch('bulk_incomes',[income(100)]),plan=await preview(b);state.accounts[0].balance++;assert.equal((await commit(b,plan)).status,409);assert.equal(state.transactions.length,0);
 const c=batch('bulk_customers',[{name:'Customer A'}]),p=await preview(c);state.customers.push({id:'old',name:'Customer A'});assert.equal((await commit(c,p)).status,400);assert.equal(state.customers.length,1);
 const d=batch('bulk_incomes',[income(200)]),q=await preview(d);q.entries[0].amount=1;assert.equal((await commit(d,q)).status,409);assert.equal(state.transactions.length,0);
});
test('unprivileged roles, income approval restrictions and missing attestation never write',async()=>{
 const b=batch('bulk_incomes',[income(100)]),plan=await preview(b);
 const r=await request('/actions',{...b,targets:plan,request_key:randomUUID(),verified_source_records:false});assert.equal(r.status,400);
 for(const role of ['member','cashier','auditor']){roles=[role];assert.equal((await request('/preview',b)).status,403);}
 roles=['accountant'];flow='accountant_and_approver';assert.equal((await request('/preview',b)).status,403);assert.equal(state.transactions.length,0);
});

test('income and expense batches work across all four projects with the same balance rules',async()=>{
 for(const p of ['fund_shares','accounting','billing','construction']){type=p;const before=state.accounts[0].balance,b=batch('bulk_incomes',[income(100)]),plan=await preview(b);assert.equal((await commit(b,plan)).status,200);assert.equal(state.accounts[0].balance,before+100);roles=['admin'];const e=batch('bulk_expenses',[expense(40)]),review=await preview(e);assert.equal((await commit(e,review)).status,200);assert.equal(state.accounts[0].balance,before+60);roles=['accountant'];}
});
test('insufficient total funds, income overflow, oversized batches and foreign proof files fail without partial entries',async()=>{
 roles=['admin'];let b=batch('bulk_expenses',[expense(60000),{...expense(50000),title:'Transport'}]);assert.equal((await request('/preview',b)).status,400);assert.equal(state.expenses.length,0);assert.equal(state.accounts[0].balance,100000);
 b=batch('bulk_incomes',[income(2147483647)]);assert.equal((await request('/preview',b)).status,400);
 b=batch('bulk_customers',Array.from({length:51},(_,i)=>({name:`Customer ${i}`})));assert.equal((await request('/preview',b)).status,400);
 b=batch('bulk_expenses',[expense(100)]);const plan=await preview(b);const response=await request('/actions',{...b,targets:plan,request_key:randomUUID(),verified_source_records:true,source_file_ids:['foreign']});assert.equal(response.status,404);assert.equal(state.expenses.length,0);assert.equal(state.accounts[0].balance,100000);
});


test('reviewed product descriptions, prices and codes persist for a single screenshot item and multi-row import',async()=>{
 const rows=[{name:'USB cable',description:'Braided USB-C, 2 m, 100 W',sku:'0007',unit:'pcs',cost_price:150,sell_price:250},{name:'Router',description:'Dual-band AC1200',cost_price:1800,sell_price:2500}];
 const b=batch('bulk_items',rows),plan=await preview(b);assert.equal(state.items.length,0);assert.equal(plan.entries[0].description,rows[0].description);
 const key=randomUUID();assert.equal((await commit(b,plan,key)).status,200);assert.equal(state.items.length,2);assert.equal(state.items[0].description,rows[0].description);assert.equal(state.items[0].costPrice,150);assert.equal(state.items[0].sellPrice,250);assert.equal(state.items[0].sku,'0007');assert.equal(state.items[0].quantity,0);
 assert.equal((await commit(b,plan,key)).status,200);assert.equal(state.items.length,2);
 const single=batch('bulk_items',[{name:'Adapter',description:'HDMI to USB-C',sell_price:400}]),review=await preview(single);assert.equal((await commit(single,review)).status,200);assert.equal(state.items[2].description,'HDMI to USB-C');
});
test('a product batch rolls back every item when a later product cannot be saved',async()=>{
 const b=batch('bulk_items',[{name:'Cable',description:'USB-C',sell_price:200},{name:'Router',description:'AC1200',sell_price:2000}]),plan=await preview(b);failAt=2;
 assert.equal((await commit(b,plan)).status,500);assert.equal(state.items.length,0);assert.equal(state.activities.length,0);
});

test('product categories are scoped, revalidated and persisted; suggestions never create categories or suppliers',async()=>{
 state.categories=[{id:'cables',name:'Cables',isActive:true}];
 const cat=await (await request('/catalog')).json();assert.deepEqual(cat.data.item_categories,state.categories);
 const row={name:'USB-C cable',category_id:'cables',suggested_category:'Accessories',suggested_supplier:'ABC Supplier',inference_notes:'Category inferred from box',attributes:{}};
 const b=batch('bulk_items',[row]),plan=await preview(b);assert.equal(plan.entries[0].category_name,'Cables');assert.equal(state.items.length,0);assert.equal(state.dealers.length,0);
 assert.equal((await commit(b,plan)).status,200);assert.equal(state.items[0].categoryId,'cables');assert.equal(state.items[0].suggested_category,undefined);assert.equal(state.categories.length,1);assert.equal(state.dealers.length,0);
 const suggestion=batch('bulk_items',[{name:'Mouse',suggested_category:'Computer accessories',suggested_supplier:'Optional supplier'}]);const p=await preview(suggestion);assert.equal((await commit(suggestion,p)).status,200);assert.equal(state.items[1].categoryId,undefined);assert.equal(state.categories.length,1);assert.equal(state.dealers.length,0);
 assert.equal((await request('/preview',batch('bulk_items',[{name:'Adapter',category_id:'foreign'}]))).status,400);
 assert.equal((await request('/preview',batch('bulk_items',[{name:'Adapter',create_category:'Silent creation'}]))).status,400);
});
test('a changed or deactivated item category invalidates confirmation without creating items',async()=>{
 state.categories=[{id:'cables',name:'Cables',isActive:true}];
 const b=batch('bulk_items',[{name:'Cable',category_id:'cables'}]),plan=await preview(b);
 state.categories[0].name='Other';assert.equal((await commit(b,plan)).status,409);assert.equal(state.items.length,0);
 state.categories[0].name='Cables';state.categories[0].isActive=false;assert.equal((await commit(b,plan)).status,400);assert.equal(state.items.length,0);
});
