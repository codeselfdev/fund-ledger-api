import { installAccountReadFixtures, installSubscriptionReadFixtures } from './helpers/normalized-fixtures.mjs';
import assert from 'node:assert/strict';
import {test,beforeEach,after} from 'node:test';
Object.assign(process.env,{DATABASE_URL:'postgresql://test:test@127.0.0.1:1/test',JWT_SECRET:'isolated-billing-alerts',SMTP_HOST:'smtp.example.test',SMTP_USER:'test-user',SMTP_PASS:'test-pass',PLATFORM_ALERT_EMAILS:'admin@example.test',PLATFORM_ALERT_TELEGRAM_CHAT_ID:'test-chat',TELEGRAM_BOT_TOKEN:'test-token',ADMIN_WEB_URL:'https://admin.example.test'});
const nodemailer=(await import('nodemailer')).default;
let mail=[],telegram=[],rows=[],failEmail=false,failTelegram=false;
const originalTransport=nodemailer.createTransport;
nodemailer.createTransport=()=>({sendMail:async body=>{if(failEmail)throw Error('simulated provider failure');mail.push(body);return{};}});
const {prisma}=await import('../dist/core/prisma/client.js');
const {env}=await import('../dist/config/env.js');
const {deliverPlatformAlerts,platformAlerts,retryPlatformAlert}=await import('../dist/modules/internal/alerts.service.js');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,opts)=>{assert.match(String(url),/^https:\/\/api.telegram.org\//);if(failTelegram)return Response.json({ok:false},{status:503});telegram.push(JSON.parse(opts.body));return Response.json({ok:true});};
const equal=(a,b)=>a instanceof Date&&b instanceof Date?a.getTime()===b.getTime():a===b;
function matches(row,where){return Object.entries(where).every(([k,v])=>k==='OR'?v.some(w=>matches(row,w)):v&&typeof v==='object'&&!(v instanceof Date)?'lt'in v?row[k]<v.lt:'lte'in v?row[k]<=v.lte:false:equal(row[k],v));}
function fresh(kind,id){return{id,tenantId:'org',userId:'customer',ticketId:null,kind,eventKey:`${kind}:invoice${kind==='billing_payment'?':request':''}`,createdAt:new Date(),readAt:null,emailSentAt:null,telegramSentAt:null,attempts:0,telegramAttempts:0,leaseUntil:null,telegramLeaseUntil:null,nextAttemptAt:new Date(0),telegramNextAttemptAt:new Date(0),tenant:{name:'Example Fund',slug:'example'}};}
beforeEach(()=>{
 delete process.env.MASTER_USER_EMAIL; delete process.env.Master_user_email; delete process.env.MASTER_USER_ID; process.env.PLATFORM_ALERT_EMAILS='admin@example.test';
 prisma.masterAlertDelivery.count=async()=>1;
 mail=[];telegram=[];failEmail=false;failTelegram=false;rows=[fresh('billing_upgrade','upgrade'),fresh('billing_payment','payment')];env.smtp.user='test-user';env.smtp.pass='test-pass';process.env.ADMIN_WEB_URL='https://admin.example.test';process.env.PLATFORM_ALERT_TELEGRAM_CHAT_ID='test-chat';process.env.TELEGRAM_BOT_TOKEN='test-token';
 prisma.platformAlert.findMany=async({where})=>structuredClone(rows.filter(r=>matches(r,where)));
 prisma.platformAlert.findUnique=async({where})=>rows.find(r=>r.id===where.id)??null;
 prisma.platformAlert.count=async()=>rows.filter(r=>!r.readAt).length;
 prisma.platformAlert.updateMany=async({where,data})=>{const selected=rows.filter(r=>matches(r,where));for(const row of selected)for(const[k,v]of Object.entries(data))row[k]=v&&typeof v==='object'&&'increment'in v?row[k]+v.increment:v;return{count:selected.length};};
 prisma.tenant.findUnique=async()=>({id:'org',name:'Example Fund',contact:{billing:{invoices:[{id:'invoice',package:'business',billing_cycle:'monthly',amount:5000,currency:'BDT',status:'submitted',payment_amount:5000,payment_reference:'BANK-123',receipt:{file_name:'bank-receipt.pdf'}}]}}});
 prisma.user.findFirst=async()=>({id:'customer',name:'Synthetic Customer',mobile:'+8801700000000',email:'customer@example.test'});
 prisma.member.findMany=async()=>[];
 prisma.subscriptionInvoice.findMany=async()=>[{tenantId:'org',id:'invoice',package:'business',billingCycle:'monthly',amount:5000,currency:'BDT',status:'submitted',instructions:'Pay',issuedAt:new Date(),paymentAmount:5000,paymentReference:'BANK-123',paymentRequestKey:null,receiptId:'proof',submittedAt:new Date(),approvedAt:null,rejectionReason:null,periodEndsAt:null}];
 prisma.subscriptionPaymentReceipt.findMany=async()=>[{id:'proof',tenantId:'org',invoiceId:'invoice',fileName:'bank-receipt.pdf',mimeType:'application/pdf',size:10}];

installAccountReadFixtures(prisma);
installSubscriptionReadFixtures(prisma);
});
after(async()=>{globalThis.fetch=originalFetch;nodemailer.createTransport=originalTransport;await prisma.$disconnect();});
test('billing requests appear unread in the portal and include invoice navigation and delivery readiness',async()=>{const page=await platformAlerts();assert.equal(page.unread,2);assert.equal(page.alerts[0].invoice_id,'invoice');assert.equal(page.alerts[0].delivery.email,'pending');assert.equal(page.delivery_configured.telegram,true);});
test('email and Telegram contain plan, amount, reference, receipt name and a private portal review link',async()=>{await deliverPlatformAlerts();assert.equal(mail.length,2);assert.equal(telegram.length,2);assert.match(mail[0].subject,/Plan upgrade requested/);assert.match(mail[1].subject,/Payment awaiting approval/);assert.match(mail[1].text,/BDT 5000/);assert.match(mail[1].text,/BANK-123/);assert.match(mail[1].text,/bank-receipt.pdf/);assert.match(mail[1].text,/view=billing&organization=org&invoice=invoice/);assert.equal(telegram[1].reply_markup.inline_keyboard[0][0].text,'Review billing request');assert.ok(rows.every(r=>r.emailSentAt&&r.telegramSentAt));});
test('failed email retries do not resend already successful Telegram notifications',async()=>{failEmail=true;await deliverPlatformAlerts();assert.equal(mail.length,0);assert.equal(telegram.length,2);failEmail=false;rows.forEach(r=>r.nextAttemptAt=new Date(0));await deliverPlatformAlerts();assert.equal(mail.length,2);assert.equal(telegram.length,2);await deliverPlatformAlerts();assert.equal(mail.length,2);});
test('failed Telegram delivery can recover without repeating email',async()=>{failTelegram=true;await deliverPlatformAlerts();assert.equal(mail.length,2);assert.equal(telegram.length,0);failTelegram=false;rows.forEach(r=>r.telegramNextAttemptAt=new Date(0));await deliverPlatformAlerts();assert.equal(mail.length,2);assert.equal(telegram.length,2);});
test('missing SMTP or Telegram config is visible and does not burn delivery attempts',async()=>{env.smtp.pass='';delete process.env.PLATFORM_ALERT_TELEGRAM_CHAT_ID;delete process.env.ADMIN_WEB_URL;await deliverPlatformAlerts();assert.equal(rows[0].attempts,0);assert.equal(rows[0].telegramAttempts,0);const page=await platformAlerts();assert.equal(page.alerts[0].delivery.email,'not_configured');assert.equal(page.alerts[0].delivery.telegram,'not_configured');assert.equal(page.delivery_configured.admin_portal,false);});
test('retry resets only undelivered channels and never clears a successful delivery marker',async()=>{rows[0].emailSentAt=new Date();rows[0].telegramAttempts=5;const page=await platformAlerts();assert.equal(page.alerts[0].delivery.telegram,'failed');await retryPlatformAlert('upgrade');assert.ok(rows[0].emailSentAt);assert.equal(rows[0].telegramAttempts,0);await deliverPlatformAlerts();assert.equal(mail.length,1);assert.equal(telegram.length,2);});

test('a locally hosted portal does not block email or the existing Telegram alert group',async()=>{
 delete process.env.ADMIN_WEB_URL;await deliverPlatformAlerts();assert.equal(mail.length,2);assert.equal(telegram.length,2);assert.match(mail[1].text,/Open the super-admin panel/);assert.equal(telegram[1].reply_markup,undefined);assert.ok(rows.every(r=>r.emailSentAt&&r.telegramSentAt));
});


test('dedicated master email does not duplicate an address also present in legacy platform alert recipients',async()=>{
 process.env.MASTER_USER_EMAIL='MASTER@example.test';process.env.MASTER_WEB_ORIGIN='https://fundnesta.appnesta.com';
 process.env.PLATFORM_ALERT_EMAILS='master@example.test,ops@example.test';
 await deliverPlatformAlerts();assert.equal(mail.length,2);assert.ok(mail.every(message=>message.to==='ops@example.test'));
});
test('master-only legacy recipients delegate new requests without sending duplicate emails',async()=>{
 process.env.MASTER_USER_EMAIL='master@example.test';process.env.MASTER_WEB_ORIGIN='https://fundnesta.appnesta.com';
 process.env.PLATFORM_ALERT_EMAILS='MASTER@example.test';await deliverPlatformAlerts();assert.equal(mail.length,0);
 assert.ok(rows.every(row=>row.emailSentAt));
});
test('historical requests without dedicated master deliveries keep their existing legacy email routing',async()=>{
 process.env.MASTER_USER_EMAIL='master@example.test';process.env.MASTER_WEB_ORIGIN='https://fundnesta.appnesta.com';
 process.env.PLATFORM_ALERT_EMAILS='master@example.test';prisma.masterAlertDelivery.count=async()=>0;
 await deliverPlatformAlerts();assert.equal(mail.length,2);assert.ok(mail.every(message=>message.to==='master@example.test'));
});
