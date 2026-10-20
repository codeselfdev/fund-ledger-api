import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
const url=process.env.BUSINESS_SETUP_TEST_DATABASE_URL;
if(url&&!/127\.0\.0\.1:55439\/business_setup_test(?:\?|$)/.test(url))throw new Error('Use only the isolated business_setup_test database on localhost:55439');
test('business setup, imports, tax snapshots and postings against disposable PostgreSQL',{skip:!url},async t=>{
 Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'production',JWT_SECRET:'business-setup-synthetic-only-test-secret',UPLOAD_STORAGE:'local',UPLOAD_LOCAL_DIR:'/tmp/business-setup-test-uploads'});
 const {prisma}=await import('../dist/core/prisma/client.js'),{createApp}=await import('../dist/app.js'),{signAccessToken,hashToken}=await import('../dist/core/security/jwt.js');
 const {emptyTaxSetup}=await import('../dist/modules/business-setup/contract.js');
 const ids=[];let server;
 try{
 const tenant=await prisma.tenant.create({data:{name:'Synthetic business test',slug:'business-test-'+randomUUID(),contact:{subscription:{status:'active',package:'business',billing_cycle:'monthly',current_period_end_at:new Date(Date.now()+864000000).toISOString()}}}});ids.push(tenant.id);
 const project=await prisma.project.create({data:{tenantId:tenant.id,name:'Synthetic business',projectType:'accounting',totalShares:1}});
 const foreign=await prisma.project.create({data:{tenantId:tenant.id,name:'Unrelated business',projectType:'accounting',totalShares:1}});
 const auth={};
 for(const role of ['owner','accountant','cashier','auditor']){
  const user=await prisma.user.create({data:{tenantId:tenant.id,name:'Synthetic '+role,mobile:'+88017'+String(Math.random()).slice(2,10)}});
  await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:project.id,userId:user.id,role}});
  const session=await prisma.session.create({data:{tenantId:tenant.id,userId:user.id,activeProjectId:project.id,tokenHash:'pending',expiresAt:new Date(Date.now()+3600000)}});
  const token=signAccessToken({sessionId:session.id,userId:user.id,tenantId:tenant.id});await prisma.session.update({where:{id:session.id},data:{tokenHash:hashToken(token)}});auth[role]={token,user};
 }
 server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 let activeProject=project.id;
 async function api(path,body,method=body===undefined?'GET':'POST',role='owner',expected=200){const response=await fetch(base+'/v1'+path,{method,headers:{Authorization:'Bearer '+auth[role].token,'X-Project-Id':activeProject,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(value)}`);return value.data;}
 const schema=e=>api(`/business-setup/entities/${e}/schema`);
 const field=(patch={})=>({key:'trade_id',label:'Trade ID',type:'text',options:[],required:false,searchable:true,match:'exact',filterable:true,showInList:true,position:0,archived:false,...patch});
 async function add(e,f){const s=await schema(e);return api(`/business-setup/entities/${e}/fields`,{revision:s.revision,field:f},'POST','owner',201);}
 const query=(e,body={})=>api(`/business-setup/entities/${e}/query`,body);
 let trade,credit,group,customer,item,account;
 await t.test('field configuration is admin-only and scoped by project and entity',async()=>{
  const s=await schema('customer');await api('/business-setup/entities/customer/fields',{revision:s.revision,field:field()},'POST','accountant',403);
  trade=await add('customer',field({required:true}));credit=await add('customer',field({key:'credit',label:'Credit limit',type:'money',searchable:false,required:false,position:1}));group=await add('customer',field({key:'groups',label:'Groups',type:'multi_select',options:['Retail','Wholesale'],position:2}));
  assert.equal((await schema('dealer')).fields.length,0);
  activeProject=foreign.id;await api('/business-setup/entities/customer/schema',undefined,'GET','owner',403);activeProject=project.id;
 });
 await t.test('all customer write paths validate required, unknown and typed attributes',async()=>{
  await api('/customers',{name:'Missing attributes'},'POST','owner',400);
  customer=await api('/customers',{name:'Rahman Traders',mobile:'+8801700000001',attributes:{trade_id:'TR-001',credit:1000,groups:['Wholesale']}},'POST','owner',201);
  await api('/customers',{name:'Invalid money',attributes:{trade_id:'T2',credit:'N/A'}},'POST','owner',400);
  await api('/business-setup/entities/customer/records',{name:'Unknown key',attributes:{trade_id:'T2',foreign:'x'}},'POST','owner',400);
  await api('/business-setup/entities/customer/records',{name:'Read-only',attributes:{trade_id:'T2'}},'POST','auditor',403);
  const edited=await api('/customers/'+customer.id,{name:'Rahman Traders',mobile:customer.mobile,attributes:{credit:2000}},'PATCH');assert.equal(edited.attributes.trade_id,'TR-001');assert.equal(edited.attributes.credit,2000);
 });
 await t.test('keyword matching, numeric ranges and multichoice filters execute safely in PostgreSQL',async()=>{
  await api('/customers',{name:'Another customer',attributes:{trade_id:'TR-002'}},'POST','owner',201);
  assert.equal((await query('customer',{search:'Wholesale'})).entries.length,1);
  assert.equal((await query('customer',{search:'TR-001'})).entries.length,1);assert.equal((await query('customer',{search:'TR-00'})).entries.length,0);
  assert.equal((await query('customer',{search:"%' OR 1=1 --"})).entries.length,0);
  assert.equal((await query('customer',{filters:[{key:'credit',operator:'gte',value:1500}]})).entries.length,1);
  assert.equal((await query('customer',{filters:[{key:'groups',operator:'in',value:['Wholesale']}]})).entries.length,1);
  await api('/business-setup/entities/customer/query',{filters:[{key:'trade_id',operator:'gte',value:'a'}]},'POST','owner',400);
  const s=await schema('customer');await api('/business-setup/entities/customer/search',{revision:s.revision,builtinSearch:['name'],fields:s.fields.map(({id,searchable,match,filterable,showInList,position})=>({id,searchable,match:'starts_with',filterable,showInList,position}))},'PUT');
  assert.equal((await query('customer',{search:'tr-00'})).entries.length,2);
 });
 await t.test('archival hides fields while preserving values and rejecting key/type mutation',async()=>{
  let s=await schema('customer');let f=s.fields.find(f=>f.id===trade.id);const {id,...value}=f;
  await api('/business-setup/entities/customer/fields/'+id,{revision:s.revision,field:{...value,type:'number'}},'PATCH','owner',400);
  await api('/business-setup/entities/customer/fields/'+id,{revision:s.revision,field:{...value,archived:true}},'PATCH');
  assert.equal((await query('customer',{search:'TR-001'})).entries.length,0);
  assert.equal((await prisma.customer.findUnique({where:{id:customer.id}})).attributes.trade_id,'TR-001');
  await api('/customers/'+customer.id,{name:'Rahman Traders',attributes:{trade_id:'new'}},'PATCH','owner',400);
 });
 const col=(header,target,type='text')=>({header,target,label:header,type,options:[],searchable:false});
 let preview;
 await t.test('preview validates all rows without saving definitions or records; stale schema is rejected',async()=>{
  const s=await schema('dealer'),body={entity:'dealer',revision:s.revision,fileName:'dealers.csv',policy:'skip',columns:[col('Name','name'),col('Phone','phone','phone'),col('Credit','credit','number')],rows:[['Delta Steel','+8801700000010','bad']]};
  const invalid=await api('/business-setup/imports/preview',body,'POST','owner',201);assert.ok(invalid.issues.length);assert.equal(await prisma.vendor.count({where:{projectId:project.id}}),0);assert.equal((await schema('dealer')).fields.length,0);
  await api('/business-setup/imports/'+invalid.id+'/commit',{},'POST','owner',400);
  preview=await api('/business-setup/imports/preview',{...body,rows:[['Delta Steel','+8801700000010','1000'],['Beta Supply','+8801700000011','2000']]},'POST','owner',201);assert.equal(preview.added,2);
  await api('/business-setup/imports/'+preview.id+'/commit',{},'POST','accountant',403);
 });
 await t.test('commit creates fields and records atomically and retries never duplicate',async()=>{
  const first=await api('/business-setup/imports/'+preview.id+'/commit',{});const again=await api('/business-setup/imports/'+preview.id+'/commit',{});assert.deepEqual(first,again);assert.equal(first.added,2);assert.equal(first.fieldsCreated,1);assert.equal(await prisma.vendor.count({where:{projectId:project.id}}),2);
 });
 await t.test('local and international phone prefixes match existing records; concurrent commit retries are idempotent',async()=>{
  const s=await schema('customer');const p=await api('/business-setup/imports/preview',{entity:'customer',revision:s.revision,fileName:'local-phones.csv',policy:'update',columns:[col('Name','name'),col('Mobile','mobile','phone')],rows:[['Rahman Updated','01700000001']]},'POST','owner',201);assert.equal(p.updated,1);assert.equal(p.added,0);
  const results=await Promise.all([api('/business-setup/imports/'+p.id+'/commit',{}),api('/business-setup/imports/'+p.id+'/commit',{})]);assert.deepEqual(results[0],results[1]);assert.equal((await prisma.customer.findUnique({where:{id:customer.id}})).attributes.credit,2000);
 });
 await t.test('duplicate identity, duplicate targets and revised schemas prevent unsafe imports',async()=>{
  const s=await schema('dealer'),body={entity:'dealer',revision:s.revision,fileName:'duplicate.csv',policy:'update',columns:[col('Name','name'),col('Phone','phone','phone')],rows:[['One','+8801700000020'],['Two','+8801700000020']]};
  const duplicate=await api('/business-setup/imports/preview',body,'POST','owner',201);assert.ok(duplicate.issues.some(i=>i.message.includes('Duplicate')));await api('/business-setup/imports/'+duplicate.id+'/commit',{},'POST','owner',400);
  await api('/business-setup/imports/preview',{...body,columns:[col('Name','name'),col('Another Name','name')]},'POST','owner',400);
  const pending=await api('/business-setup/imports/preview',{...body,rows:[['New Company','+8801700000020']]},'POST','owner',201);await add('dealer',field({key:'zone',label:'Zone'}));await api('/business-setup/imports/'+pending.id+'/commit',{},'POST','owner',409);
 });
 await t.test('item imports preserve zero-padded SKUs and never overwrite existing stock',async()=>{
  item=await api('/business-setup/entities/item/records',{name:'Steel Rod',sku:'00123',quantity:10,cost_price:100,sell_price:200});
  const s=await schema('item'),body={entity:'item',revision:s.revision,fileName:'items.csv',policy:'update',columns:[col('Name','name'),col('SKU','sku'),col('Quantity','quantity','number'),col('Color','color')],rows:[['Steel Rod','00123','999','Blue']]};
  const p=await api('/business-setup/imports/preview',body,'POST','owner',201);assert.equal(p.updated,1);await api('/business-setup/imports/'+p.id+'/commit',{});assert.equal((await prisma.inventoryItem.findUnique({where:{id:item.id}})).quantity,10);assert.equal(await prisma.stockMovement.count({where:{itemId:item.id}}),1);
 });
 await t.test('legacy vendor and item APIs enforce the shared field definitions and record opening stock',async()=>{
  await add('dealer',field({key:'registration',label:'Registration',required:true}));await api('/vendors',{name:'Missing registration'},'POST','owner',400);
  const vendor=await api('/vendors',{name:'Registered dealer',attributes:{registration:'REG-01'}},'POST','owner',201);assert.equal(vendor.attributes.registration,'REG-01');
  await add('item',field({key:'manufacturer',label:'Manufacturer',required:true}));await api('/inventory/items',{name:'Missing manufacturer'},'POST','owner',400);
  const created=await api('/inventory/items',{name:'Registered item',sku:'00124',quantity:3,attributes:{manufacturer:'Sample factory'}},'POST','owner',201);assert.equal(await prisma.stockMovement.count({where:{itemId:created.id}}),1);
  const updated=await api('/inventory/items/'+created.id,{sell_price:120},'PATCH');assert.equal(updated.attributes.manufacturer,'Sample factory');
 });
 let tax=emptyTaxSetup(),saleDoc,quote;
 await t.test('admin tax setup validates defaults and server applies rates even without client amounts',async()=>{
  tax.rates=[{id:'vat',name:'VAT',rateBps:1500,kind:'add',documents:['quotation','sale','purchase'],active:true},{id:'wh',name:'Withholding',rateBps:300,kind:'withhold',documents:['purchase'],active:true}];for(const key of ['quotation','sale','purchase'])tax.defaults[key].rateId='vat';tax.defaults.purchase.withholdingId='wh';
  tax=await api('/business-setup/tax',tax,'PUT');assert.equal(tax.revision,1);await api('/business-setup/tax',tax,'PUT','accountant',403);
  const body={kind:'sale',customer_id:customer.id,document_date:'2026-10-20',lines:[{description:'Service',quantity:1,unit_price:1000}],request_key:randomUUID()};
  await api('/accounting/documents',{...body,tax_selection:{revision:tax.revision,rateId:null}},'POST','cashier',400);
  await api('/accounting/documents',{...body,tax_selection:{revision:0}},'POST','owner',409);
  await api('/accounting/documents',{...body,tax:1},'POST','owner',400);
  saleDoc=await api('/accounting/documents',body,'POST','owner',201);assert.equal(saleDoc.total,1150);assert.equal(saleDoc.taxSnapshot.tax,150);assert.equal(await prisma.businessTaxEntry.count({where:{projectId:project.id}}),0);
  quote=await api('/accounting/documents',{...body,kind:'quotation',request_key:randomUUID()},'POST','owner',201);
 });
 await t.test('issue and cancellation post and reverse tax once; quotations never post',async()=>{
  await api('/accounting/documents/'+saleDoc.id+'/status',{action:'issue'});assert.equal(await prisma.businessTaxEntry.count({where:{sourceId:saleDoc.id}}),1);
  await api('/accounting/documents/'+saleDoc.id+'/status',{action:'cancel'});const entries=await prisma.businessTaxEntry.findMany({where:{sourceId:saleDoc.id}});assert.equal(entries.length,2);assert.equal(entries.reduce((n,r)=>n+r.amount,0),0);
  await api('/accounting/documents/'+quote.id+'/status',{action:'send'});await api('/accounting/documents/'+quote.id+'/status',{action:'accept'});
  tax=await api('/business-setup/tax',{...tax,rates:tax.rates.map(r=>r.id==='vat'?{...r,rateBps:2000}:r)},'PUT');
  const converted=await api('/accounting/documents/'+quote.id+'/convert',{kind:'sale',document_date:'2026-10-20',request_key:randomUUID()},'POST','owner',201);assert.equal(converted.tax,150);assert.equal(converted.taxSnapshot.breakdown[0].rateBps,1500);
  const updated=await api('/accounting/documents/'+converted.id,{customer_id:customer.id,document_date:'2026-10-20',lines:converted.lines.map(({line_total,...l})=>l),tax_selection:{...converted.taxSnapshot.selection,revision:converted.taxSnapshot.revision}},'PATCH');assert.equal(updated.tax,150);
 });
 await t.test('purchase inclusive/exclusive tax and withholding affect payable and post only at receipt',async()=>{
  account=await prisma.account.create({data:{tenantId:tenant.id,projectId:project.id,name:'Synthetic cash',type:'cash',balance:10000}});
  const purchase=await api('/purchases',{account_id:account.id,lines:[{item_id:item.id,quantity:2,unit_cost:1000}]},'POST','owner',201);assert.equal(purchase.totalAmount,2340);assert.equal(purchase.taxSnapshot.tax,400);assert.equal(purchase.taxSnapshot.withholding,60);assert.equal(await prisma.businessTaxEntry.count({where:{sourceId:purchase.id}}),0);
  await api('/purchases/'+purchase.id+'/receive',{});assert.equal((await prisma.account.findUnique({where:{id:account.id}})).balance,7660);const entries=await prisma.businessTaxEntry.findMany({where:{sourceId:purchase.id}});assert.deepEqual(entries.map(e=>e.kind).sort(),['input','withholding_payable']);
 });
 await t.test('billing invoices and generated recurring invoices share server tax defaults and PDF snapshots',async()=>{
  const billingProject=await prisma.project.create({data:{tenantId:tenant.id,name:'Synthetic billing',projectType:'billing',totalShares:1}});await prisma.projectMembership.create({data:{tenantId:tenant.id,projectId:billingProject.id,userId:auth.owner.user.id,role:'owner'}});activeProject=billingProject.id;
  let bt=emptyTaxSetup();bt.rates=[{id:'bill-vat',name:'VAT',rateBps:500,kind:'add',documents:['sale'],active:true}];bt.defaults.sale.rateId='bill-vat';await api('/business-setup/tax',bt,'PUT');
  const c=await api('/billing/customers',{name:'Synthetic billed customer'},'POST','owner',201);
  const invoice=await api('/billing/invoices',{customer_id:c.id,invoice_date:'2026-10-20',due_date:'2026-11-20',lines:[{description:'Service',quantity:1,unit_price:1000}],request_key:randomUUID()},'POST','owner',201);assert.equal(invoice.total,1050);assert.equal(invoice.taxSnapshot.tax,50);assert.equal(await prisma.businessTaxEntry.count({where:{sourceId:invoice.id}}),1);
  const response=await fetch(base+'/v1/billing/invoices/'+invoice.id+'/invoice.pdf',{headers:{Authorization:'Bearer '+auth.owner.token,'X-Project-Id':activeProject}});assert.equal(response.status,200);assert.match(Buffer.from(await response.arrayBuffer()).toString('utf8',0,5),/%PDF-/);
  const plan=await api('/billing/plans',{name:'Monthly service',category:'general_business',mode:'fixed',amount:1000,interval_months:1,due_days:10},'POST','owner',201);
  const assignment=await api('/billing/assignments',{customer_id:c.id,plan_id:plan.id,label:'Monthly subscription',start_date:'2026-10-01'},'POST','owner',201);
  const generated=await api('/billing/assignments/'+assignment.id+'/invoice',{period_start:'2026-10-01'},'POST','owner',201);assert.equal(generated.total,1050);assert.equal(generated.taxSnapshot.tax,50);
  activeProject=project.id;
 });
 await t.test('mixed historical line rates survive removing and adding lines after current rates change',async()=>{
  tax={...tax,rates:[...tax.rates,{id:'reduced',name:'Reduced VAT',rateBps:500,kind:'add',documents:['sale'],active:true}],defaults:{...tax.defaults,sale:{...tax.defaults.sale,level:'line'}}};tax=await api('/business-setup/tax',tax,'PUT');
  const created=await api('/accounting/documents',{kind:'sale',customer_id:customer.id,document_date:'2026-10-20',lines:[{description:'First',quantity:1,unit_price:1000},{description:'Second',quantity:1,unit_price:1000}],tax_selection:{revision:tax.revision,lineRateIds:['reduced','reduced']},request_key:randomUUID()},'POST','owner',201);
  tax=await api('/business-setup/tax',{...tax,rates:tax.rates.map(r=>r.id==='vat'?{...r,rateBps:2500}:r)},'PUT');
  const edited=await api('/accounting/documents/'+created.id,{customer_id:customer.id,document_date:'2026-10-20',lines:[{description:'Second',quantity:1,unit_price:1000},{description:'New line',quantity:1,unit_price:1000}],tax_selection:{...created.taxSnapshot.selection,lineRateIds:['reduced','vat'],revision:created.taxSnapshot.revision}},'PATCH');assert.equal(edited.tax,250);assert.equal(edited.taxSnapshot.breakdown.find(r=>r.rateId==='vat').rateBps,2000);
 });
 await t.test('legacy fixed-tax drafts keep their historical amount after tax setup changes',async()=>{
  const old=await prisma.businessDocument.create({data:{tenantId:tenant.id,projectId:project.id,customerId:customer.id,customerSnapshot:{name:customer.name},kind:'quotation',number:'LEGACY-'+randomUUID(),lines:[{description:'Old service',quantity:1,unit_price:1000,line_total:1000}],subtotal:1000,tax:37,total:1037,documentDate:new Date('2026-10-01'),workflow:{quotations:true,orders:true,allow_skip:true},events:[],requestKey:randomUUID(),createdById:auth.owner.user.id}});
  const edited=await api('/accounting/documents/'+old.id,{customer_id:customer.id,document_date:'2026-10-01',lines:[{description:'Old service',quantity:1,unit_price:1000}],tax:37},'PATCH');assert.equal(edited.tax,37);assert.equal(edited.total,1037);assert.equal(edited.taxSnapshot,null);
 });
 await t.test('direct inventory sales post inclusive tax and reverse it on cancellation',async()=>{
  const sale=await api('/sales',{account_id:account.id,lines:[{item_id:item.id,quantity:1,unit_price:1200}],tax_selection:{revision:tax.revision,inclusive:true}},'POST','owner',201);assert.equal(sale.totalAmount,1200);assert.equal(sale.taxSnapshot.tax,240);
  await api('/sales/'+sale.id+'/cancel',{});assert.equal((await prisma.businessTaxEntry.findMany({where:{sourceId:sale.id}})).reduce((n,r)=>n+r.amount,0),0);
 });
 await t.test('expired previews lose their raw contact payload',async()=>{
  await prisma.businessImport.updateMany({where:{tenantId:tenant.id,status:'preview'},data:{expiresAt:new Date(0)}});
  const {expireBusinessImports}=await import('../dist/modules/business-setup/retention.js');await expireBusinessImports();
  const expired=await prisma.businessImport.findMany({where:{tenantId:tenant.id,status:'expired'}});assert.ok(expired.length);assert.ok(expired.every(p=>JSON.stringify(p.payload)==='{}'&&JSON.stringify(p.preview)==='{}'));
 });
 }finally{
  if(server)await new Promise(r=>server.close(r));
  for(const tenantId of ids){await prisma.businessDocument.updateMany({where:{tenantId},data:{sourceId:null}});for(const model of ['businessTaxEntry','businessPayment','businessDocument','billingAllocation','billingAdjustment','billingPayment','billingInvoice','billingAssignment','billingPlan','billingUnit','customer'])await prisma[model].deleteMany({where:{tenantId}});await prisma.tenant.delete({where:{id:tenantId}});}
  await prisma.$disconnect();
 }
});
