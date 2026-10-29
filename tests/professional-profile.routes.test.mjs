import assert from 'node:assert/strict';
import {before,after,beforeEach,test} from 'node:test';
import express from 'express';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';process.env.JWT_SECRET='profile-isolated';
const {prisma}=await import('../dist/core/prisma/client.js');
const {userProfileRouter}=await import('../dist/modules/profile/user-profile.routes.js');
const {errorHandler}=await import('../dist/core/http/error-handler.js');
let user,audit,server,base,failAudit;
before(()=>{
 prisma.tenantUser.findFirst=async({where})=>user.id===where.id&&(!where.tenantId||user.tenantId===where.tenantId)?{...structuredClone(user),userId:'global-user',isActive:true,identity:{name:user.name,email:user.email,mobile:user.mobile,isActive:true}}:null;
 prisma.tenantUser.update=async({data})=>{Object.assign(user,data);return {...structuredClone(user),userId:'global-user',isActive:true,identity:{name:user.name,email:user.email,mobile:user.mobile,isActive:true}};};
 prisma.user.update=async({data})=>{Object.assign(user,data);return structuredClone(user);};
 prisma.activity.create=async({data})=>{if(failAudit)throw Error('Audit unavailable');audit.push(data);return data;};
 prisma.$transaction=async fn=>{const old=structuredClone(user);try{return await fn(prisma);}catch(e){user=old;throw e;}};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.header('x-user'))req.auth={userId:req.header('x-user'),tenantId:req.header('x-tenant')??'t',projectId:null,roles:[]};next();});app.use('/profile',userProfileRouter);app.use(errorHandler);
 return new Promise(r=>{server=app.listen(0,'127.0.0.1',()=>{base=`http://127.0.0.1:${server.address().port}`;r();});});
});
after(async()=>{await new Promise(r=>server.close(r));await prisma.$disconnect();});
beforeEach(()=>{user={id:'u',tenantId:'t',name:'Amina',mobile:'+8801711000009',email:'login@example.com',professionalProfile:null};audit=[];failAudit=false;});
async function call(body,headers={'x-user':'u'}){const r=await fetch(base+'/profile',{method:body?'PATCH':'GET',headers:{'Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};}
const valid={revision:0,name:'Amina Rahman',designation:'Sales manager',mobile:'+447700900123',email:'sales@example.com'};
test('self profile requires authentication and never returns another user or tenant',async()=>{assert.equal((await call(undefined,{})).status,401);assert.equal((await call(undefined,{'x-user':'other'})).status,404);assert.equal((await call(undefined,{'x-user':'u','x-tenant':'other'})).status,404);assert.equal((await call()).body.data.email,'login@example.com');});
test('professional details save atomically without replacing verified login contacts',async()=>{const r=await call(valid);assert.equal(r.status,200);assert.equal(r.body.data.revision,1);assert.equal(user.name,'Amina Rahman');assert.equal(user.mobile,'+8801711000009');assert.equal(user.email,'login@example.com');assert.equal(audit[0].before.name,'Amina');assert.equal(audit[0].after.designation,'Sales manager');assert.equal((await call(valid)).status,409);});
test('profile validates contact formats and rejects identity or role injection',async()=>{for(const extra of [{mobile:'12345'},{email:'broken'},{name:'A'},{designation:'x'.repeat(121)},{user_id:'other'},{role:'admin'}])assert.equal((await call({...valid,...extra})).status,400);assert.equal(audit.length,0);});
test('audit failure rolls back all profile changes',async()=>{failAudit=true;const old=structuredClone(user),log=console.error;console.error=()=>{};try{assert.equal((await call(valid)).status,500);}finally{console.error=log;}assert.deepEqual(user,old);});
