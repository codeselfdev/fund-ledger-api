import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { prisma } from '../dist/core/prisma/client.js';
import { env } from '../dist/config/env.js';
import { requestEmailOtp, requestLoginOtp } from '../dist/modules/auth/otp-delivery.service.js';

const originalTransport = nodemailer.createTransport;
const originalSmtp = { ...env.smtp };
const originalNodeEnv = process.env.NODE_ENV;
const originalFirebaseKey = process.env.FIREBASE_WEB_API_KEY;
let failDelivery = false;
const messages = [], challenges = [];
env.smtp.user = 'isolated-otp-test-user';
env.smtp.pass = 'isolated-otp-test-password';
delete process.env.FIREBASE_WEB_API_KEY;
nodemailer.createTransport = () => ({ sendMail: async message => {
  if (failDelivery) throw new Error('Synthetic SMTP rejection');
  messages.push(message);
} });
prisma.$transaction = async callback => callback(prisma);
prisma.$queryRaw = async () => [];
prisma.otpCode.updateMany = async () => ({ count: 0 });
prisma.otpCode.create = async ({ data }) => { challenges.push(data); return data; };
after(async () => {
  nodemailer.createTransport = originalTransport;
  Object.assign(env.smtp, originalSmtp);
  for (const [key, value] of Object.entries({ NODE_ENV: originalNodeEnv, FIREBASE_WEB_API_KEY: originalFirebaseKey })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await prisma.$disconnect();
});

for (const mode of ['development', 'test', 'production', undefined]) {
  test(`OTP responses omit verification codes with NODE_ENV=${mode}`, async () => {
    if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
    for (const request of [
      () => requestEmailOtp(' OTP@Example.test '),
      () => requestLoginOtp({ mobile: '+8801711000001', users: [{ id: 'account', tenantId: 'tenant', email: 'otp@example.test' }] }),
    ]) {
      const response = await request();
      const delivered = messages.at(-1);
      const code = delivered.text.match(/\b\d{6}\b/)[0];
      assert.equal(response.sent, true);
      assert.equal(response.emailed, true);
      assert.equal(delivered.to, 'otp@example.test');
      assert.equal('dev_code' in response, false);
      assert.equal(JSON.stringify(response).includes(code), false);
      assert.notEqual(challenges.at(-1).codeHash, code);
    }
  });
}

test('development email failures return an error instead of claiming a code was sent', async () => {
  process.env.NODE_ENV = 'development'; failDelivery = true;
  try {
    await assert.rejects(requestEmailOtp('otp@example.test'), error => error.statusCode === 503);
    await assert.rejects(requestLoginOtp({ mobile: '+8801711000001', users: [{ id: 'account', tenantId: 'tenant', email: 'otp@example.test' }] }), error => error.statusCode === 503);
  } finally { failDelivery = false; }
});

test('an account without any available delivery channel cannot claim OTP delivery in development', async () => {
  process.env.NODE_ENV = 'development'; const before = challenges.length;
  await assert.rejects(requestLoginOtp({ mobile: '+8801711000001', users: [{ id: 'account', tenantId: 'tenant', email: null }] }), error => error.statusCode === 503);
  assert.equal(challenges.length, before);
});
