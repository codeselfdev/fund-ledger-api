import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import express from 'express';
import { prisma } from '../dist/core/prisma/client.js';
import { memberProfileRouter } from '../dist/modules/members/member-profile.routes.js';
import { membersRouter } from '../dist/modules/members/members.routes.js';

let member, user, userWrites, server, url, failUserWrite;
const matches = (row, where) => row && Object.entries(where).every(([key, value]) => row[key] === value);
const defined = data => Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
function reset() {
  member = { id: 'member', tenantId: 'tenant', projectId: 'project', userId: 'user', name: 'Member name', mobile: '+8801711000000', email: 'old@example.com', status: 'active', shares: 2, profile: { occupation: 'Engineer', photo_file_id: 'photo' } };
  user = { id: 'user', tenantId: 'tenant', name: 'Account name', mobile: member.mobile, email: member.email };
  userWrites = 0; failUserWrite = false;
}
before(async () => {
  prisma.member.findFirst = async ({ where }) => matches(member, where) ? member : null;
  prisma.member.findUniqueOrThrow = async () => member;
  prisma.member.update = async ({ data }) => (member = { ...member, ...defined(data) });
  prisma.user.update = async ({ where, data }) => {
    userWrites++;
    if (failUserWrite || !matches(user, where)) throw new Error('User update failed');
    return user = { ...user, ...defined(data) };
  };
  prisma.$queryRaw = async () => [];
  prisma.$transaction = async callback => {
    const snapshot = structuredClone({ member, user });
    try { return await callback(prisma); }
    catch (error) { ({ member, user } = snapshot); throw error; }
  };
  prisma.activity.create = async ({ data }) => data;
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { tenantId: 'tenant', projectId: 'project', userId: 'actor', memberId: req.header('x-self') === 'yes' ? 'member' : null, roles: [req.header('x-role') || 'admin'] }; next();
  });
  app.use('/members', memberProfileRouter, membersRouter);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
async function patch(body, suffix = '/profile', headers = {}) {
  const response = await fetch(url + '/members/member' + suffix, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
test('profile email updates both member and linked login account, preserving other identity fields and profile', async () => {
  reset(); const response = await patch({ email: '  New.Email@example.com  ' });
  assert.equal(response.status, 200); assert.equal(member.email, 'New.Email@example.com'); assert.equal(user.email, member.email);
  assert.equal(user.name, 'Account name'); assert.equal(userWrites, 1);
  assert.deepEqual(member.profile, { occupation: 'Engineer', photo_file_id: 'photo' });
});
test('clearing profile email clears the linked account for both supported empty values', async () => {
  for (const email of ['', null]) { reset(); assert.equal((await patch({ email })).status, 200); assert.equal(member.email, null); assert.equal(user.email, null); }
});
test('profile-only edits preserve a different account email and do not write the user', async () => {
  reset(); user.email = 'account@example.com';
  assert.equal((await patch({ occupation: 'Architect' })).status, 200);
  assert.equal(user.email, 'account@example.com'); assert.equal(userWrites, 0);
});
test('failed account update rolls back the member email', async () => {
  reset(); failUserWrite = true;
  assert.equal((await patch({ email: 'new@example.com' })).status, 500);
  assert.equal(member.email, 'old@example.com'); assert.equal(user.email, 'old@example.com');
});
test('unlinked member updates do not guess or overwrite another user account', async () => {
  reset(); member.userId = null;
  assert.equal((await patch({ email: 'new@example.com' })).status, 200);
  assert.equal(user.email, 'old@example.com'); assert.equal(userWrites, 0);
});
test('foreign-project member and unauthorized edits fail without writes', async () => {
  reset(); member.projectId = 'foreign'; assert.equal((await patch({ email: 'new@example.com' })).status, 404); assert.equal(userWrites, 0);
  reset(); assert.equal((await patch({ email: 'new@example.com' }, '/profile', { 'x-role': 'accountant' })).status, 403); assert.equal(userWrites, 0);
});
test('a member can update their own email using existing profile permissions', async () => {
  reset(); assert.equal((await patch({ email: 'new@example.com' }, '/profile', { 'x-role': 'member', 'x-self': 'yes' })).status, 200);
  assert.equal(user.email, member.email);
});
test('a linked user in a different tenant cannot be modified and the member change rolls back', async () => {
  reset(); user.tenantId = 'foreign'; assert.equal((await patch({ email: 'new@example.com' })).status, 500);
  assert.equal(user.email, 'old@example.com'); assert.equal(member.email, 'old@example.com');
});
test('the general member update synchronizes email and preserves omitted account fields', async () => {
  reset(); assert.equal((await patch({ email: 'new@example.com' }, '')).status, 200); assert.equal(user.email, member.email); assert.equal(user.name, 'Account name');
  user.email = 'account@example.com'; assert.equal((await patch({ name: 'Updated member' }, '')).status, 200);
  assert.equal(user.name, 'Updated member'); assert.equal(user.email, 'account@example.com');
});
