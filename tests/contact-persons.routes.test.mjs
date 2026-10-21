import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import express from 'express';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET='contact-persons-isolated-test';
const {prisma}=await import('../dist/core/prisma/client.js');
const {contactPersonsRouter}=await import('../dist/modules/contact-persons/contact-persons.routes.js');
const {quotationPerson,quotationPersonPdfLines}=await import('../dist/modules/contact-persons/contact-persons.service.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
let db,server,base,next,failAudit;
const auth={tenantId:'t',projectId:'p',userId:'u',roles:['admin']};
function match(row,where={}){
 return !!row&&Object.entries(where).every(([key,value])=>{
  if(value===undefined)return true;
  if(key==='OR')return value.some(w=>match(row,w));
  if(key==='customerLinks'||key==='dealerLinks')return db[key].some(link=>link.contactPersonId===row.id&&match(link,value.some));
  if(value&&typeof value==='object'&&'contains'in value)return String(row[key]??'').toLowerCase().includes(value.contains.toLowerCase());
  return row[key]===value;
 });
}
function model(table){return {
 findFirst:async({where})=>structuredClone(db[table].find(row=>match(row,where))??null),
 findMany:async({where,skip=0,take=100})=>db[table].filter(row=>match(row,where)).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)).slice(skip,skip+take).map(row=>structuredClone(row)),
 create:async({data})=>{if(table==='activity'&&failAudit)throw new Error('Audit unavailable');const row={id:'id-'+(++next),isActive:true,...data};db[table].push(row);return structuredClone(row);},
 update:async({where,data})=>{const row=db[table].find(row=>match(row,where));for(const[key,value]of Object.entries(data))if(value!==undefined)row[key]=value;return structuredClone(row);},
 upsert:async({create})=>{const old=db[table].find(row=>row.contactPersonId===create.contactPersonId&&(row.customerId??row.dealerId)===(create.customerId??create.dealerId));if(!old)db[table].push(create);return old??create;},
 deleteMany:async({where})=>{const old=db[table].length;db[table]=db[table].filter(row=>!match(row,where));return {count:old-db[table].length};},
};}
before(()=>{
 for(const[key,table]of Object.entries({contactPerson:'people',customerContactPerson:'customerLinks',dealerContactPerson:'dealerLinks',customer:'customers',vendor:'dealers',project:'projects',activity:'activity'}))Object.assign(prisma[key],model(table));
 prisma.$transaction=async fn=>{const old=structuredClone(db);try{return await fn(prisma);}catch(error){db=old;throw error;}};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.auth={...auth,roles:[req.header('x-role')??'admin'],projectId:req.header('x-project')??'p'};next();});app.use('/contacts',contactPersonsRouter);app.use(errorHandler);
 return new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{base=`http://127.0.0.1:${server.address().port}`;resolve();});});
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
beforeEach(()=>{next=0;failAudit=false;db={people:[],customerLinks:[],dealerLinks:[],activity:[],projects:[{id:'p',tenantId:'t',projectType:'accounting'},{id:'billing',tenantId:'t',projectType:'billing'}],customers:[{id:'c',tenantId:'t',projectId:'p',isActive:true},{id:'c2',tenantId:'t',projectId:'p',isActive:true},{id:'foreign',tenantId:'other',projectId:'foreign',isActive:true},{id:'billing-c',tenantId:'t',projectId:'billing',isActive:true}],dealers:[{id:'d',tenantId:'t',projectId:'p',isActive:true}]};});
async function api(path='',body,method=body===undefined?'GET':'POST',role='admin',project='p'){const response=await fetch(base+'/contacts'+path,{method,headers:{'Content-Type':'application/json','x-role':role,'x-project':project},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};}
const create=(link={entity:'customer',record_id:'c'})=>api('',{name:'Rahman',mobile:'01700000001',designation:'Buyer',email:'r@example.com',link});
test('one customer has multiple people and a person can be reused across customers and dealers',async()=>{
 const first=await create();assert.equal(first.status,201);const person=first.body.data;assert.equal(person.mobile,'+8801700000001');
 await create();assert.equal((await api('?entity=customer&record_id=c')).body.data.entries.length,2);
 for(const link of [{entity:'customer',record_id:'c2'},{entity:'dealer',record_id:'d'}]){assert.equal((await api(`/${person.id}/links`,link)).status,200);assert.equal((await api(`/${person.id}/links`,link)).status,200);}
 assert.equal(db.customerLinks.length,3);assert.equal(db.dealerLinks.length,1);
 assert.equal((await api('?entity=dealer&record_id=d')).body.data.entries[0].id,person.id);
});
test('foreign records and foreign contacts cannot be linked or read through a scoped parent',async()=>{
 assert.equal((await create({entity:'customer',record_id:'foreign'})).status,404);assert.equal(db.people.length,0);
 db.people.push({id:'foreign-person',tenantId:'other',projectId:'foreign',name:'Private',isActive:true});
 assert.equal((await api('/foreign-person/links',{entity:'customer',record_id:'c'})).status,404);
 assert.equal((await api('?entity=customer&record_id=foreign')).status,404);
 assert.equal((await api()).body.data.entries.length,0);
 assert.equal((await api('/foreign-person',{name:'Leaked'},'PATCH')).status,404);
});
test('unlinking removes only that relation and saved quotation snapshots remain usable',async()=>{
 const person=(await create()).body.data;await api(`/${person.id}/links`,{entity:'dealer',record_id:'d'});
 const saved=await quotationPerson(prisma,auth,'c',person.id);
 assert.equal((await api(`/${person.id}/links/customer/c`,undefined,'DELETE')).status,200);
 assert.equal(db.customerLinks.length,0);assert.equal(db.dealerLinks.length,1);assert.equal(db.people.length,1);
 assert.equal((await quotationPerson(prisma,auth,'c',person.id,{customerId:'c',...saved})).quotationPersonSnapshot.name,'Rahman');
 await assert.rejects(quotationPerson(prisma,auth,'c',person.id),/linked to this customer/);
});
test('quotations reject unrelated and archived people, preserve history, and allow explicit clearing',async()=>{
 const person=(await create()).body.data;const saved=await quotationPerson(prisma,auth,'c',person.id);
 await assert.rejects(quotationPerson(prisma,auth,'c2',person.id),/linked to this customer/);
 db.people[0].name='Renamed';db.people[0].isActive=false;
 await assert.rejects(quotationPerson(prisma,auth,'c',person.id),/linked to this customer/);
 const old={customerId:'c',...saved};assert.equal((await quotationPerson(prisma,auth,'c',undefined,old)).quotationPersonSnapshot.name,'Rahman');
 assert.equal((await quotationPerson(prisma,auth,'c',null,old)).quotationPersonId,null);
 assert.equal((await quotationPerson(prisma,auth,'c2',undefined,old)).quotationPersonId,null);
 assert.deepEqual(quotationPersonPdfLines(saved.quotationPersonSnapshot),['Quotation person: Rahman (Buyer)','+8801700000001 | r@example.com']);
});
test('read-only roles cannot mutate contacts and cashiers cannot change dealer or billing-customer links',async()=>{
 for(const role of ['auditor','approver','staff','member'])assert.equal((await api('',{name:'Blocked'},'POST',role)).status,403);
 const person=(await create()).body.data;
 assert.equal((await api(`/${person.id}/links`,{entity:'dealer',record_id:'d'},'POST','cashier')).status,403);
 await api(`/${person.id}/links`,{entity:'dealer',record_id:'d'});
 assert.equal((await api(`/${person.id}`,{name:'Blocked edit'},'PATCH','cashier')).status,403);
 assert.equal((await api('',{name:'Blocked',link:{entity:'customer',record_id:'billing-c'}},'POST','cashier','billing')).status,403);
});
test('validation, paging and a failed audit do not leave partial contacts or links',async()=>{
 for(const body of [{name:'A'},{name:'Valid',email:'invalid'},{name:'Valid',mobile:'abc'}])assert.equal((await api('',body)).status,400);
 assert.equal((await api('?entity=customer')).status,400);assert.equal((await api('?offset=-1')).status,400);
 await create();await create();const page=(await api('?limit=1&search=Rah')).body.data;assert.equal(page.entries.length,1);assert.equal(page.nextOffset,1);assert.equal((await api('?limit=1&offset=1')).body.data.nextOffset,null);
 failAudit=true;const log=console.error;console.error=()=>{};try{assert.equal((await create()).status,500);}finally{console.error=log;}
 assert.equal(db.people.length,2);assert.equal(db.customerLinks.length,2);
});
