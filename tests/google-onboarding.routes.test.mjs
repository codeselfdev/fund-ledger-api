import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import express from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../dist/core/prisma/client.js';
import { onboardingRouter } from '../dist/modules/onboarding/onboarding.routes.js';
import { authRouter } from '../dist/modules/auth/auth.routes.js';
import { buildGoogleAuthorizationUrl } from '../dist/modules/auth/google-oauth.service.js';
import { verifyAccessToken } from '../dist/core/security/jwt.js';
import { env } from '../dist/config/env.js';
let server, url, users, tenants, projects, memberships, progresses, email, verified, validToken, writes, otpWrites;
let clientId = 0;
const nativeFetch = globalThis.fetch;
const mobile = '+8801711000009', token = 'isolated-google-token-for-tests';
const matches = (row, where = {}) => Object.entries(where).every(([key,value]) => {
 if (key === 'OR') return value.some(part => matches(row,part));
 if (value && typeof value === 'object') {
  if ('equals' in value) return String(row[key] ?? '').toLowerCase() === value.equals.toLowerCase();
  if ('in' in value) return value.in.includes(row[key]);
  if ('endsWith' in value) return row[key]?.endsWith(value.endsWith);
  if (key === 'tenant') return matches(tenants.find(t=>t.id===row.tenantId) ?? {},value);
  return true;
 }
 return row[key] === value;
});
const loginUser = row => row && { ...row, tenant:tenants.find(t=>t.id===row.tenantId), memberships:memberships.filter(m=>m.userId===row.id).map(m=>({...m,project:projects.find(p=>p.id===m.projectId),member:null})) };
before(async () => {
 process.env.FIREBASE_SERVICE_ACCOUNT_JSON = ''; process.env.FCM_SERVICE_ACCOUNT_JSON = '';
 env.googleOAuth.clientSecret = 'isolated-test-secret';
 globalThis.fetch = async (input, options) => {
  if (String(input).startsWith('https://oauth2.googleapis.com/tokeninfo')) return new Response(JSON.stringify({ aud:'953182652005-5q814sgq7bhvki19pj8lkhen1ek7dk57.apps.googleusercontent.com',sub:'google-test-user',email,name:'Google Owner',email_verified:verified }),{status:validToken?200:401});
  if (String(input)==='https://oauth2.googleapis.com/token') return new Response(JSON.stringify({id_token:token}),{status:200});
  return nativeFetch(input,options);
 };
 prisma.$transaction = async fn => fn(prisma);
 prisma.user.findMany = async ({where}) => users.filter(row=>matches(row,where)).map(loginUser);
 prisma.user.findFirst = async ({where}) => loginUser(users.find(row=>matches(row,where))) ?? null;
 prisma.user.findUniqueOrThrow = async ({where}) => { const row=loginUser(users.find(row=>matches(row,where))); if(!row)throw Error('User missing');return row; };
 prisma.user.create = async ({data}) => {writes++;const row={id:`user-${users.length}`,isActive:true,identityRootId:null,...data};users.push(row);return row;};
 prisma.tenant.findUnique = async ({where}) => tenants.find(row=>matches(row,where)) ?? null;
 prisma.tenant.findUniqueOrThrow = async ({where}) => tenants.find(row=>matches(row,where));
 prisma.tenant.create = async ({data}) => {writes++;const row={id:`tenant-${tenants.length}`,...data};tenants.push(row);return row;};
 prisma.project.create = async ({data}) => {writes++;const row={id:`project-${projects.length}`,isActive:true,...data};projects.push(row);return row;};
 prisma.project.findFirst = async ({where}) => projects.find(row=>matches(row,where)) ?? null;
 prisma.projectMembership.create = async ({data}) => {writes++;const row={id:`role-${memberships.length}`,isActive:true,memberId:null,...data};memberships.push(row);return row;};
 prisma.projectMembership.findMany = async ({where}) => memberships.filter(row=>matches(row,where)).map(row=>({...row,project:projects.find(p=>p.id===row.projectId)}));
 prisma.onboardingProgress.create = async ({data}) => {writes++;progresses.push(data);return data;};
 prisma.onboardingProgress.findUnique = async ({where}) => progresses.find(row=>matches(row,where)) ?? null;
 prisma.member.findFirst = async () => null;
 prisma.session.create = async ({data}) => ({id:'fixture-session',...data});prisma.session.update = async()=>({});
 prisma.activity.create = async ({data}) => data;
 prisma.otpCode.create = async () => {otpWrites++;return {};};
 prisma.otpCode.findFirst = async () => ({id:'old-otp',codeHash:await bcrypt.hash('123456',4)});prisma.otpCode.update=async()=>({});
 const app=express();app.set('trust proxy',1);app.use(express.json());app.use('/onboarding',onboardingRouter);app.use('/auth',authRouter);
 app.use((error,_req,res,_next)=>res.status(error.statusCode??500).json({error:error.message,fields:error.fields}));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(()=>{
 clientId++;writes=0;otpWrites=0;email='new@example.com';verified=true;validToken=true;
 users=[{id:'existing-user',tenantId:'existing-tenant',name:'Existing Owner',mobile,email:'existing@example.com',isActive:true,identityRootId:null}];
 tenants=[{id:'existing-tenant',slug:'existing',name:'Existing organization',contact:null}];
 projects=[{id:'existing-project',tenantId:'existing-tenant',name:'Existing project',projectType:'fund_shares',isActive:true,totalShares:20}];
 memberships=[{id:'existing-role',tenantId:'existing-tenant',projectId:'existing-project',userId:'existing-user',role:'owner',memberId:null,isActive:true}];progresses=[];
});
after(async()=>{globalThis.fetch=nativeFetch;await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
async function request(path,body) { const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':`192.0.2.${clientId}`},body:JSON.stringify(body)});return{status:response.status,body:await response.json()}; }
const signup = extra => ({org_name:'New organization',project_name:'New project',owner_name:'Chosen Owner',owner_mobile:mobile,project_type:'fund_shares',total_shares:20,id_token:token,...extra});
async function ticket() {
 const authorization = buildGoogleAuthorizationUrl({query:{intent:'login',redirect_uri:'fundledger://auth'},protocol:'http',get:name=>name==='host'?'127.0.0.1:4000':undefined});
 const state=new URL(authorization).searchParams.get('state');
 const response=await fetch(`${url}/auth/google/callback?code=isolated-code&state=${encodeURIComponent(state)}`);
 const html=await response.text();assert.equal(response.status,200);const match=html.match(/ticket=([A-Za-z0-9_-]+)/);assert.ok(match);return match[1];
}
test('new Google email signs in to organization setup, then creates a separate organization even with a reused contact mobile',async()=>{
 const before=structuredClone(users[0]);const login=await request('/auth/login',{id_token:token});
 assert.equal(login.status,200);assert.equal(login.body.data.signup_needed,true);assert.equal(login.body.data.token,undefined);
 const created=await request('/onboarding/signup',signup());assert.equal(created.status,201);const payload=created.body.data;
 assert.equal(payload.user.email,'new@example.com');assert.equal(payload.user.mobile,mobile);assert.equal(payload.user.name,'Chosen Owner');assert.ok(payload.token);assert.ok(payload.tenant.id);
 assert.equal(verifyAccessToken(payload.token).userId,payload.user.id);assert.equal(payload.onboarding.required,true);
 assert.deepEqual(users[0],before);assert.equal(users[1].identityRootId,null);assert.equal(memberships.filter(row=>row.userId===payload.user.id).length,1);assert.equal(memberships.at(-1).projectId,payload.active_project_id);assert.notEqual(payload.active_project_id,'existing-project');
 const later=await request('/auth/login',{id_token:token});assert.equal(later.status,200);assert.equal(later.body.data.user.id,payload.user.id);assert.equal(later.body.data.memberships.length,1);assert.equal(later.body.data.memberships[0].project_id,payload.active_project_id);
});
test('existing Google email gets a real existing session and cannot create a duplicate organization',async()=>{
 email='EXISTING@example.com';const res=await request('/onboarding/signup',signup());assert.equal(res.status,409);assert.match(res.body.error,/Google account already/);assert.equal(writes,0);
 const login=await request('/auth/login',{id_token:token});assert.equal(login.status,200);assert.equal(login.body.data.user.id,'existing-user');assert.ok(login.body.data.token);
});
test('unverified payload email cannot bypass contact-mobile uniqueness or claim Google identity',async()=>{
 const res=await request('/onboarding/signup',signup({id_token:undefined,owner_email:'new@example.com',verifiedGoogleEmail:'new@example.com'}));assert.equal(res.status,409);assert.match(res.body.error,/mobile already/);assert.equal(writes,0);
});
test('Google signup uses verified email, not the body email, and still requires a valid contact mobile',async()=>{
 for(const owner_mobile of [undefined,'','abc','123'])assert.equal((await request('/onboarding/signup',signup({owner_mobile}))).status,400);
 assert.equal(writes,0);
 const res=await request('/onboarding/signup',signup({owner_email:'spoof@example.com'}));assert.equal(res.status,201);assert.equal(res.body.data.user.email,'new@example.com');
});
test('invalid or unverified Google tokens cannot create an organization',async()=>{
 validToken=false;assert.equal((await request('/onboarding/signup',signup())).status,400);validToken=true;verified=false;assert.equal((await request('/onboarding/signup',signup())).status,400);assert.equal(writes,0);
});
test('duplicate organization slug is reported without a new account write',async()=>{
 const res=await request('/onboarding/signup',signup({org_name:'Existing',slug:'existing'}));assert.equal(res.status,409);assert.match(res.body.error,/slug/);assert.equal(writes,0);
});
test('Google ticket signup also accepts an existing contact mobile and retains the ticket after input rejection',async()=>{
 const id=await ticket();const complete=await request('/auth/google/complete',{ticket:id});assert.equal(complete.body.data.signup_needed,true);
 const invalid=await request('/auth/google/signup',{...signup({id_token:undefined}),ticket:id,owner_mobile:undefined});assert.equal(invalid.status,400);assert.equal(writes,0);
 const valid=await request('/auth/google/signup',{...signup({id_token:undefined}),ticket:id});assert.equal(valid.status,200);assert.equal(valid.body.data.user.id,users[1].id);assert.equal(users[1].identityRootId,null);
});
test('shared contacts cannot receive email OTPs that authenticate another Google identity',async()=>{
 assert.equal((await request('/onboarding/signup',signup())).status,201);
 const res=await request('/auth/otp/request',{mobile});assert.equal(res.status,400);assert.match(res.body.error,/multiple accounts/);assert.equal(otpWrites,0);
});

test('an older valid email OTP cannot cross into a newly created Google identity by specifying its tenant slug',async()=>{
 const created=await request('/onboarding/signup',signup());assert.equal(created.status,201);
 const res=await request('/auth/login',{mobile,otp:'123456',tenant_slug:created.body.data.tenant.slug});assert.equal(res.status,400);assert.match(res.body.error,/multiple accounts/);assert.equal(res.body.data,undefined);
});
