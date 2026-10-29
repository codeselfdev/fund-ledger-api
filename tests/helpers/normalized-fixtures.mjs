/** Domain fixtures store account and subscription DTOs; this adapter exposes normalized Prisma rows. */
export function matches(row,where={}) {
 if(!row)return false;
 return Object.entries(where).every(([key,value])=>{
  if(value===undefined)return true;if(key==='OR')return value.some(part=>matches(row,part));if(key==='AND')return(Array.isArray(value)?value:[value]).every(part=>matches(row,part));if(key==='NOT')return!(Array.isArray(value)?value:[value]).some(part=>matches(row,part));
  const actual=row[key];if(value instanceof Date)return +actual===+value;
  if(value&&typeof value==='object'){
   if('equals'in value)return value.mode==='insensitive'?String(actual??'').toLowerCase()===String(value.equals).toLowerCase():actual===value.equals;
   if('in'in value)return value.in.includes(actual);if('notIn'in value)return !value.notIn.includes(actual);
   if('not'in value)return actual!==value.not;if('gt'in value)return actual>value.gt;if('gte'in value)return actual>=value.gte;if('lt'in value)return actual<value.lt;if('lte'in value)return actual<=value.lte;
   if('contains'in value)return String(actual??'').toLowerCase().includes(String(value.contains).toLowerCase());if('endsWith'in value)return String(actual??'').endsWith(value.endsWith);
   if('some'in value)return(actual??[]).some(item=>matches(item,value.some));if('none'in value)return!(actual??[]).some(item=>matches(item,value.none));
   return matches(actual,value);
  }return actual===value;
 });
}
export function subscriptionRow(tenantId,data){
 if(!data)return null;const date=value=>value?new Date(value):null;
 return {tenantId,package:data.package??(data.current_period_end_at?'starter':'free'),status:data.status??'active',billingCycle:data.billing_cycle??'yearly',revision:data.revision??1,
  trialStartsAt:date(data.trial_starts_at),trialEndsAt:date(data.trial_ends_at),currentPeriodStartAt:date(data.current_period_start_at),currentPeriodEndAt:date(data.current_period_end_at),quotaResetAt:date(data.quota_reset_at),createdAt:date(data.updated_at)??new Date(),updatedAt:date(data.updated_at)??new Date()};
}
export function installNormalizedFixtures(db,{users,tenants,memberships=()=>[],projects=()=>[],createAccount,updateAccount,receipts=()=>[]}){
 for(const model of ['user','tenantUser','tenant','tenantSubscription','subscriptionHistory','subscriptionInvoice','subscriptionPaymentReceipt','session'])db[model]??={};
 let lastUsers,invoiceRows=[],historyRows=[];
 const ensure=()=>{if(lastUsers!==users()){lastUsers=users();invoiceRows=[];historyRows=[];}};
 const globalRow=row=>row&&({...row,id:row.identityRootId??row.id,isActive:row.isActive!==false,email:row.email?.trim().toLowerCase()??null,mobile:row.mobile&&/^01\d{9}$/.test(row.mobile)?'+880'+row.mobile.slice(1):row.mobile&&/^[ge]:/.test(row.mobile)?null:row.mobile??null});
 const identityRows=()=>{ensure();return users().filter(row=>!row.identityRootId).map(globalRow);};
 const withSubscription=row=>row&&({...row,subscription:subscriptionRow(row.id,row.subscription)});
 const accountRow=row=>{
  if(!row)return null;const root=users().find(user=>user.id===(row.identityRootId??row.id))??row;
  return {...row,userId:row.identityRootId??row.id,isActive:row.isActive!==false,identity:globalRow(root),tenant:withSubscription(tenants().find(t=>t.id===row.tenantId)),
   memberships:memberships().filter(m=>m.userId===row.id&&m.isActive!==false&&projects().find(p=>p.id===m.projectId)?.isActive!==false).map(m=>({...m,project:projects().find(p=>p.id===m.projectId),member:null,customRole:null}))};
 };
 const accounts=()=>{ensure();return users().filter(row=>row.tenantId).map(accountRow);};
 db.user.findMany=async({where={}}={})=>identityRows().filter(row=>matches(row,where));
 db.user.findUnique=db.user.findFirst=async args=>(await db.user.findMany(args))[0]??null;
 db.user.findUniqueOrThrow=async args=>{const row=await db.user.findUnique(args);if(!row)throw Error('Global identity missing');return row;};
 db.user.create=async({data})=>globalRow(await createAccount(data));
 db.user.update=async({where,data})=>globalRow(await updateAccount(where,data));
 db.tenantUser.findMany=async({where={}}={})=>accounts().filter(row=>matches(row,where));
 db.tenantUser.findFirst=db.tenantUser.findUnique=async args=>(await db.tenantUser.findMany(args))[0]??null;
 db.tenantUser.findUniqueOrThrow=async args=>{const row=await db.tenantUser.findFirst(args);if(!row)throw Error('Account missing');return row;};
 db.tenantUser.count=async args=>(await db.tenantUser.findMany(args)).length;
 db.tenantUser.create=async({data})=>{
  const global=users().find(row=>row.id===data.userId);if(!global)throw Error('Global identity missing for membership');
  if(!global.tenantId)return accountRow(await updateAccount({id:global.id},{...data,userId:undefined,identityRootId:null}));
  return accountRow(await createAccount({...global,...data,id:undefined,userId:undefined,identityRootId:global.id}));
 };
 db.tenantUser.update=async({where,data})=>accountRow(await updateAccount(where,data));
 db.tenantUser.updateMany=async({where,data})=>{const rows=accounts().filter(row=>matches(row,where));for(const row of rows)await updateAccount({id:row.id},data);return{count:rows.length};};
 for(const name of ['findUnique','findUniqueOrThrow','findFirst'])db.tenant[name]=async({where})=>withSubscription(tenants().find(row=>matches(row,where)))??null;
 db.tenant.findMany=async({where={}}={})=>tenants().filter(row=>matches(row,where)).map(withSubscription);
 db.tenantSubscription.findUnique=async({where})=>subscriptionRow(where.tenantId,tenants().find(row=>row.id===where.tenantId)?.subscription);
 db.tenantSubscription.upsert=async({where,create,update})=>{
  const tenant=tenants().find(row=>row.id===where.tenantId);const data=tenant.subscription?update:create,iso=value=>value?.toISOString()??null;
  tenant.subscription={status:data.status,package:data.package,billing_cycle:data.billingCycle,trial_starts_at:iso(data.trialStartsAt),trial_ends_at:iso(data.trialEndsAt),current_period_start_at:iso(data.currentPeriodStartAt),current_period_end_at:iso(data.currentPeriodEndAt),quota_reset_at:iso(data.quotaResetAt),revision:data.revision,updated_at:new Date().toISOString()};
  return subscriptionRow(tenant.id,tenant.subscription);
 };
 db.subscriptionHistory.create=async({data})=>{ensure();const row={id:'history-'+historyRows.length,createdAt:new Date(),...data};historyRows.push(row);return row;};
 db.subscriptionHistory.findMany=async({where})=>historyRows.filter(row=>matches(row,where));
 db.subscriptionInvoice.findMany=async({where})=>{ensure();return invoiceRows.filter(row=>matches(row,where));};
 db.subscriptionInvoice.upsert=async({where,create,update})=>{ensure();const row=invoiceRows.find(row=>matches(row,where.tenantId_id));if(row){Object.assign(row,update);return row;}invoiceRows.push(create);return create;};
 db.subscriptionPaymentReceipt.findMany=async({where})=>receipts().filter(row=>matches(row,where));
 const sessionFind=db.session.findFirst;
 db.session.findFirst=async args=>{const session=typeof sessionFind==='function'?await sessionFind(args):null;return session?{...session,user:accountRow(users().find(row=>row.id===session.userId))??normalizedAccountRelations(session).user}:null;};
 return {accountRow};
}
/** Session/role fixtures explicitly include the global identity loaded by authentication. */
export function normalizedAccountRelations(record){
 if(!record)return record;
 const result={...record};
 for(const key of ['user','recipient','requester','actor','createdBy','sentBy','resolvedBy','responsibleUser']){
  const row=record[key];if(!row||row.identity)continue;
  result[key]={...row,tenantId:row.tenantId??record.tenantId,identity:{name:row.name??'Fixture user',email:row.email?.trim().toLowerCase()??null,mobile:row.mobile&&/^01\d{9}$/.test(row.mobile)?'+880'+row.mobile.slice(1):row.mobile&&/^[ge]:/.test(row.mobile)?null:row.mobile??null,isActive:row.isActive!==false}};
 }
 return result;
}
/** Adapt existing read-only account DTO stubs to the identity join, without database fallback. */
export function installAccountReadFixtures(db){
 installAccountRelationFixtures(db);
 const original={};for(const key of ['findMany','findFirst','findUnique','findUniqueOrThrow','update','updateMany','count','groupBy']){const fn=db.user?.[key];if(typeof fn==='function'&&fn.constructor.name==='AsyncFunction')original[key]=fn;}
 if(!Object.keys(original).length)return;
 const flatten=(where={})=>{
  const next={};for(const[key,value]of Object.entries(where)){
   if(['OR','AND','NOT'].includes(key))next[key]=Array.isArray(value)?value.map(flatten):flatten(value);
   else if(key==='identity')Object.assign(next,value);
   else if(key==='userId')next.OR=[{id:value},{identityRootId:value}];
   else if(key==='tenantId_mobile')Object.assign(next,value);
   else next[key]=value;
  }return next;
 };
 const raw=(row,args)=>row&&({...row,userId:row.identityRootId??row.userId??row.id,isActive:row.isActive!==false,identity:{...row,id:row.identityRootId??row.id,isActive:row.isActive!==false}});
 const methods={};
 const first=original.findFirst??original.findUniqueOrThrow??original.findUnique;
 methods.findFirst=async args=>first?raw(await first({...args,where:flatten(args.where)}),args):(await methods.findMany(args))[0]??null;
 if(original.findMany)methods.findMany=async args=>(await original.findMany({...args,where:flatten(args.where)})).map(row=>raw(row,args));
 else methods.findMany=async args=>{const row=await methods.findFirst(args);return row?[row]:[];};
 methods.findUnique=methods.findUniqueOrThrow=methods.findFirst;
 for(const key of ['update','updateMany','count','groupBy'])if(original[key])methods[key]=async args=>{const result=await original[key]({...args,where:flatten(args.where)});return key==='update'?raw(result,args):result;};
 Object.assign(db.tenantUser??(db.tenantUser={}),methods);
}
/** Materialize relational entitlement rows from existing domain subscription DTO fixtures. */
export function normalizedTenantProjection(value){
 if(!value||typeof value!=='object'||value instanceof Date||Buffer.isBuffer(value))return value;
 if(Array.isArray(value))return value.map(normalizedTenantProjection);
 const result=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalizedTenantProjection(item)]));
 if('contact'in result){const domain=result.contact?.subscription??result.subscription;if(!domain||!('billingCycle'in domain))result.subscription=subscriptionRow(result.id,domain);}
 return result;
}
export function installSubscriptionReadFixtures(db){
 for(const model of ['tenant','project'])for(const method of ['findUnique','findUniqueOrThrow','findFirst','findFirstOrThrow','findMany']){
  const original=db[model]?.[method];if(typeof original==='function'&&original.constructor.name==='AsyncFunction'&&!original.normalizedTenantFixture){
   const wrapped=async args=>normalizedTenantProjection(await original(args));wrapped.normalizedTenantFixture=true;db[model][method]=wrapped;
  }
 }
}
export function normalizedJoinedAccounts(value){
 if(!value||typeof value!=='object'||value instanceof Date||Buffer.isBuffer(value))return value;
 if(Array.isArray(value))return value.map(normalizedJoinedAccounts);
 return normalizedAccountRelations(Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalizedJoinedAccounts(item)])));
}
export function installAccountRelationFixtures(db){
 for(const model of ['session','notification','supportMessage','projectMembership','memberCallLog','memberReminder','constructionPhase'])for(const method of ['findFirst','findUnique','findUniqueOrThrow','findMany','create','update']){
  const original=db[model]?.[method];if(typeof original==='function'&&original.constructor.name==='AsyncFunction'&&!original.normalizedAccountFixture){
   const wrapped=async args=>normalizedJoinedAccounts(await original(args));wrapped.normalizedAccountFixture=true;db[model][method]=wrapped;
  }
 }
}
/** Interactive Prisma transactions intentionally do not expose nested $transaction. */
export function fixtureTransactionClient(db){return new Proxy(db,{get(target,key){return key==='$transaction'?undefined:Reflect.get(target,key);},has(target,key){return key==='$transaction'?false:Reflect.has(target,key);}});}
