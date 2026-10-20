import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.OTP_TEST_DATABASE_URL;
if (!url) {
  test('PostgreSQL OTP transaction and concurrent resend regression (set OTP_TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  const connection = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname), 'Only a local disposable database is allowed');
  assert.match(connection.pathname, /test/i, 'Use a disposable test database');
  const schema = 'otp_lock_test_' + randomUUID().replaceAll('-', '');
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: url });
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  connection.searchParams.set('schema', schema);
  Object.assign(process.env, { DATABASE_URL: connection.toString(), JWT_SECRET: 'isolated-otp-test-secret', NODE_ENV: 'production',
    SMTP_USER: 'synthetic-smtp-user', SMTP_PASS: 'synthetic-smtp-password', SMTP_HOST: 'smtp.example.test' });
  const nodemailer = (await import('nodemailer')).default;
  const originalTransport = nodemailer.createTransport, emails = [];
  nodemailer.createTransport = () => ({ sendMail: async message => { emails.push(message); } });
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { createOtp, verifyOtp } = await import('../dist/modules/auth/auth.service.js');
  const { requestEmailOtp } = await import('../dist/modules/auth/otp-delivery.service.js');
  await prisma.$executeRawUnsafe(`CREATE TABLE otp_codes (
    id TEXT PRIMARY KEY, mobile TEXT NOT NULL, code_hash TEXT NOT NULL,
    expires_at TIMESTAMP(3) NOT NULL, consumed_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  after(async () => {
    nodemailer.createTransport = originalTransport;
    await prisma.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.$disconnect();
  });
  test('reproduces the original Prisma void-result error against real PostgreSQL', async () => {
    await assert.rejects(prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'otp:synthetic-legacy'}, 0))`;
    }), error => error.code === 'P2010' && /void|deserialize/i.test(error.message));
  });
  test('email request stores a hashed challenge and reaches mocked SMTP without exposing the code', async () => {
    const response = await requestEmailOtp(' OTP-Lock@Example.test ');
    assert.deepEqual(response, { sent: true, delivery: 'email', emailed: true });
    assert.equal(emails.length, 1); assert.equal(emails[0].to, 'otp-lock@example.test');
    const code = emails[0].text.match(/\b\d{6}\b/)[0];
    const row = await prisma.otpCode.findFirstOrThrow({ where: { mobile: 'email:otp-lock@example.test' } });
    assert.notEqual(row.codeHash, code);
    assert.equal(await verifyOtp('email:otp-lock@example.test', code), true);
    assert.equal(await verifyOtp('email:otp-lock@example.test', code), false);
  });
  test('concurrent resends leave exactly one usable OTP and keep other identities independent', async () => {
    const contact = 'email:concurrent@example.test';
    const codes = await Promise.all(Array.from({ length: 4 }, () => createOtp(contact)));
    const rows = await prisma.otpCode.findMany({ where: { mobile: contact, consumedAt: null } });
    assert.equal(rows.length, 1);
    const outcomes = await Promise.all(codes.map(code => verifyOtp(contact, code)));
    assert.equal(outcomes.filter(Boolean).length, 1);
    const independent = await createOtp('email:independent@example.test');
    assert.equal(await verifyOtp('email:other@example.test', independent), false);
    assert.equal(await verifyOtp('email:independent@example.test', independent), true);
  });
}
