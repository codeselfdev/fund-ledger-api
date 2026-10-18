import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { prisma } from '../dist/core/prisma/client.js';
import { env } from '../dist/config/env.js';
import { smsDay, reserveSms, requestLoginOtp } from '../dist/modules/auth/otp-delivery.service.js';
import { clientPlatform, clientActivityContext, recordUserLogin, recordUserActivity } from '../dist/core/security/client-activity.js';
import { createSessionToken } from '../dist/modules/auth/auth.service.js';
import { summariesFor } from '../dist/modules/internal/monitoring.service.js';
const nativeFetch = globalThis.fetch;
const originalTransport = nodemailer.createTransport;
let usage, sms, emails, otpRows, updates, mailFails, providerFails;
const user = { id: 'owner', tenantId: 'tenant-a', email: 'owner@example.test' };
beforeEach(() => {
  process.env.FIREBASE_WEB_API_KEY = 'test-only-api-key';
  process.env.NODE_ENV = 'production';
  usage = new Map(); sms = []; emails = []; otpRows = []; updates = []; mailFails = false; providerFails = false;
  env.smtp.user = 'test'; env.smtp.pass = 'test';
  nodemailer.createTransport = () => ({ sendMail: async message => { if (mailFails) throw Error('test mail failure'); emails.push(message); } });
  prisma.$transaction = async fn => { const snapshot = new Map(usage); try { return await fn(prisma); } catch (error) { usage = snapshot; throw error; } };
  prisma.$queryRaw = async (_strings, scope, day, limit) => {
    const key = scope + ':' + day, count = usage.get(key) ?? 0;
    if (count >= limit) return [];
    usage.set(key, count + 1); return [{ count: count + 1 }];
  };
  prisma.smsDailyUsage.findMany = async ({where}) => where.scope.in.map(scope => ({ scope, count: usage.get(scope + ':' + where.day.toISOString().slice(0,10)) ?? 0 }));
  prisma.otpCode.create = async ({data}) => { otpRows.push(data); return data; };
  prisma.user.update = async ({where,data}) => { updates.push({where,data}); return { id:where.id,...data }; };
  prisma.user.updateMany = async args => { updates.push(args); return {count:1}; };
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).startsWith('https://identitytoolkit.googleapis.com/'));
    sms.push(JSON.parse(options.body));
    if (providerFails) throw Error('test timeout');
    return Response.json({ sessionInfo:'firebase-verification-id' });
  };
});
after(async () => { globalThis.fetch = nativeFetch; nodemailer.createTransport = originalTransport; await prisma.$disconnect(); });
const request = (extra={}) => requestLoginOtp({mobile:'+8801711000001',users:[user],...extra});
test('Dhaka midnight starts a fresh quota day regardless of host timezone', () => {
  assert.equal(smsDay(new Date('2026-10-17T17:59:59Z')),'2026-10-17');
  assert.equal(smsDay(new Date('2026-10-17T18:00:00Z')),'2026-10-18');
});
test('two SMS are shared across different users of a tenant; the third is delivered only by email', async () => {
  assert.equal((await request()).delivery,'recaptcha'); assert.equal(sms.length,0); assert.equal(usage.size,0);
  assert.equal((await request({recaptchaToken:'captcha-a'})).delivery,'sms');
  assert.equal((await request({users:[{...user,id:'member',email:'member@example.test'}],recaptchaToken:'captcha-b'})).delivery,'sms');
  const third=await request();
  assert.equal(third.delivery,'email'); assert.equal(third.sms_limit_reached,true); assert.equal(third.masked_email,'o***@example.test');
  assert.equal(third.dev_code,undefined); assert.equal(sms.length,2); assert.equal(emails.length,1); assert.equal(emails[0].to,user.email);
  assert.equal(otpRows.length,1); assert.notEqual(otpRows[0].codeHash,emails[0].text.match(/\d{6}/)[0]);
});
test('other tenants and new calendar days have independent allowances', async () => {
  assert.equal(await reserveSms(['tenant:a'],'2026-10-18'),true);
  assert.equal(await reserveSms(['tenant:a'],'2026-10-18'),true);
  assert.equal(await reserveSms(['tenant:a'],'2026-10-18'),false);
  assert.equal(await reserveSms(['tenant:b'],'2026-10-18'),true);
  assert.equal(await reserveSms(['tenant:a'],'2026-10-19'),true);
});
test('a shared mobile reserves all tenant scopes once and rolls back a partial reservation', async () => {
  await reserveSms(['tenant:b'],'2026-10-18');await reserveSms(['tenant:b'],'2026-10-18');
  assert.equal(await reserveSms(['tenant:b','tenant:a','tenant:a'],'2026-10-18'),false);
  assert.equal(usage.get('tenant:a:2026-10-18'),undefined);
});
test('exhausted quota without email produces 429 and never sends a third SMS or creates an OTP', async () => {
  await request({recaptchaToken:'captcha'});await request({recaptchaToken:'captcha'});
  await assert.rejects(request({users:[{...user,email:null}]}), error => error.statusCode===429 && error.code==='SMS_DAILY_LIMIT');
  assert.equal(sms.length,2);assert.equal(otpRows.length,0);
});
test('email fallback cannot authenticate a different identity sharing the same contact', async () => {
  await request({recaptchaToken:'captcha'});await request({recaptchaToken:'captcha'});
  await assert.rejects(request({users:[user,{...user,id:'other',tenantId:'other',email:'other@example.test'}]}), /multiple accounts/);
  assert.equal(emails.length,0);assert.equal(otpRows.length,0);
});
test('SMTP failure never claims successful email delivery in production', async () => {
  delete process.env.FIREBASE_WEB_API_KEY; mailFails=true;
  await assert.rejects(request(), error => error.statusCode===503);
});
test('provider timeouts retain reservations and fall back to email without a retry SMS', async () => {
  providerFails=true;
  assert.equal((await request({recaptchaToken:'captcha'})).delivery,'email');
  assert.equal(usage.get('tenant:tenant-a:'+smsDay()),1); assert.equal(sms.length,1);
});
test('signup has a hashed phone scope and cannot bypass an existing tenant allowance', async () => {
  await request({users:[],signup:true,recaptchaToken:'captcha'});
  assert.ok([...usage.keys()][0].startsWith('signup:'));assert.ok(![...usage.keys()][0].includes('8801711'));
  await request({recaptchaToken:'captcha'});await request({recaptchaToken:'captcha'});
  assert.equal((await request({signup:true,recaptchaToken:'captcha'})).delivery,'email');
});
test('platform headers identify web/iOS/Android and unknown clients remain explicit', () => {
  assert.equal(clientPlatform('web','Android Mozilla/5.0'),'web');assert.equal(clientPlatform('ios'),'ios');
  assert.equal(clientPlatform(undefined,'Dalvik Android'),'android');assert.equal(clientPlatform('arbitrary'),'unknown');
});
test('successful login records platform/time; ordinary session rotation does not replace login', async () => {
  prisma.session.create=async({data})=>({id:'session',...data});prisma.session.update=async()=>({});
  await new Promise((resolve,reject)=>clientActivityContext({header:name=>name==='x-client-platform'?'ios':undefined},{},()=>createSessionToken({tenantId:'org',userId:'user',recordLogin:true}).then(resolve,reject)));
  assert.equal(updates.length,1);assert.equal(updates[0].data.lastLoginPlatform,'ios');assert.ok(updates[0].data.lastLoginAt instanceof Date);
  assert.equal(updates[0].data.lastLoginAt,updates[0].data.lastActiveAt);
  await createSessionToken({tenantId:'org',userId:'user'});assert.equal(updates.length,1);
});
test('authenticated activity is throttled and never alters login time/platform', async () => {
  await recordUserActivity('user',new Date());assert.equal(updates.length,0);
  await recordUserActivity('user',null);assert.deepEqual(Object.keys(updates[0].data),['lastActiveAt']);
  assert.equal(updates[0].where.id,'user');assert.equal(updates[0].where.OR[0].lastActiveAt,null);
});
test('failed session creation cannot update successful login metadata', async () => {
  prisma.session.create=async()=>{throw Error('session failed');};
  await assert.rejects(createSessionToken({tenantId:'org',userId:'user',recordLogin:true}),/session failed/);assert.equal(updates.length,0);
});
test('organization summaries include an owner without financial membership, hide Google placeholders, and aggregate all user activity', async () => {
  const counterModels=['project','member','user','expense','accountTransaction','fixedAsset','deposit','projectNotice','poll','pollVote','projectEvent','notificationCampaign','notification','account','upload','reportExport','receipt','supportTicket','supportAttachment','appInstallation'];
  for(const name of counterModels)prisma[name].groupBy=async()=>[];
  prisma.platformPayment.groupBy=async()=>[];prisma.$queryRaw=async()=>[];
  const active=new Date('2026-10-18T08:30:00Z');
  prisma.user.groupBy=async()=>[{tenantId:'org',_max:{lastActiveAt:active}}];
  prisma.user.findMany=async({where,select})=>{assert.equal(where.memberships.some.role,'owner');assert.equal(select.email,true);return[{id:'owner',tenantId:'org',name:'Owner',email:'owner@example.test',mobile:'g:google-sub',lastLoginAt:null,lastLoginPlatform:null}];};
  const [summary]=await summariesFor([{id:'org',name:'Org',slug:'org',currency:'BDT',createdAt:new Date(),contact:null,deletionStartedAt:null}]);
  assert.equal(summary.owner.name,'Owner');assert.equal(summary.owner.mobile,null);assert.equal(summary.last_active_at,active);assert.equal(summary.counts.members,0);
});
