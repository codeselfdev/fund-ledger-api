import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import nodemailer from 'nodemailer';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-secret';
const { env } = await import('../dist/config/env.js');
const { sendMail, sendOtpEmail, sendDecisionEmail } = await import('../dist/core/mail/mailer.service.js');

const originalCreateTransport = nodemailer.createTransport;
const originalSmtp = { ...env.smtp };
let transportCreations = 0;
const messages = [];
env.smtp.user = 'test-user';
env.smtp.pass = 'test-password';
nodemailer.createTransport = () => {
  transportCreations++;
  return { sendMail: async message => { messages.push(message); } };
};
after(() => {
  nodemailer.createTransport = originalCreateTransport;
  Object.assign(env.smtp, originalSmtp);
});

test('placeholder recipients are skipped before SMTP is initialized, including OTP and decisions', async () => {
  for (const to of ['member@example.com', ' MEMBER@EXAMPLE.COM ', 'Member <member@example.com>', 'member@test.example.com']) {
    assert.equal(await sendMail({ to, cc: ['admin@real.test'], subject: 'Test', text: 'Body' }), false);
  }
  assert.equal(await sendOtpEmail('member@example.com', '123456'), false);
  assert.equal(await sendDecisionEmail({ to: 'member@example.com', subject: 'Decision', entityLabel: 'Deposit', decision: 'approved' }), false);
  assert.equal(transportCreations, 0);
  assert.equal(messages.length, 0);
});

test('valid recipients receive mail with placeholder TO and CC addresses removed', async () => {
  assert.equal(await sendMail({
    to: 'Placeholder <member@example.com>, Member <member@real.test>',
    cc: ['Admin <admin@real.test>', 'placeholder@EXAMPLE.COM', 'Copies: fake@example.com, copy@real.test;'],
    subject: 'Test', text: 'Body', html: '<p>Body</p>'
  }), true);
  const message = messages.at(-1);
  assert.deepEqual(message.to, [{ name: 'Member', address: 'member@real.test' }]);
  assert.deepEqual(message.cc.map(({ address }) => address), ['admin@real.test', 'copy@real.test']);
  assert.equal(message.subject, 'Test');
  assert.equal(message.text, 'Body');
  assert.equal(message.html, '<p>Body</p>');
});

test('similar domains and example.com in the local part or display name remain deliverable', async () => {
  assert.equal(await sendMail({
    to: '"example.com" <example.com@real.test>, member@notexample.com, member@example.com.real.test',
    cc: ['fake@example.com'], subject: 'Test', text: 'Body'
  }), true);
  assert.deepEqual(messages.at(-1).to.map(({ address }) => address), ['example.com@real.test', 'member@notexample.com', 'member@example.com.real.test']);
  assert.equal(messages.at(-1).cc, undefined);
});
