import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { prisma } from '../dist/core/prisma/client.js';
import { authenticate } from '../dist/core/security/auth.middleware.js';
import { signAccessToken } from '../dist/core/security/jwt.js';
import { membershipsRouter } from '../dist/modules/memberships/memberships.routes.js';

let server;
let url;
let members;
let memberships;
let transactionCalls;

const user = {
  id: 'target-user',
  tenantId: 'tenant',
  name: 'Access Only User',
  mobile: 'e:target-user',
  email: null,
  isActive: true
};

function matchesMembership(where, membership) {
  return (!where.id || where.id === membership.id)
    && (!where.projectId || where.projectId === membership.projectId)
    && (!where.userId || where.userId === membership.userId)
    && (!where.role || where.role === membership.role);
}

before(() => {
  // Authentication records activity when a fixture has no lastActiveAt timestamp.
  prisma.user.updateMany = async () => ({ count: 1 });
  prisma.tenant.findUniqueOrThrow = async () => ({ contact: { subscription: { package: "free" } } });
  prisma.project.findFirstOrThrow = async () => ({ id: 'project', tenantId: 'tenant', name: 'Fund Nesta' });
  prisma.user.findMany = async () => [user];
  prisma.user.findFirstOrThrow = async () => user;
  prisma.projectMembership.findFirst = async ({ where }) => memberships.find((row) => matchesMembership(where, row)) ?? null;
  prisma.projectMembership.findFirstOrThrow = async ({ where }) => {
    const row = memberships.find((item) => matchesMembership(where, item));
    if (!row) throw new Error('Membership not found');
    return row;
  };
  prisma.projectMembership.create = async ({ data }) => {
    const row = { id: `membership-${memberships.length + 1}`, isActive: true, ...data };
    memberships.push(row);
    return row;
  };
  prisma.projectMembership.upsert = async ({ where, update, create }) => {
    const key = where.projectId_userId_role;
    const existing = memberships.find((row) => row.projectId === key.projectId && row.userId === key.userId && row.role === key.role);
    if (existing) return Object.assign(existing, update);
    const row = { id: `membership-${memberships.length + 1}`, isActive: true, ...create };
    memberships.push(row);
    return row;
  };
  prisma.projectMembership.updateMany = async ({ where, data }) => {
    const rows = memberships.filter((row) => row.tenantId === where.tenantId
      && row.projectId === where.projectId
      && row.userId === where.userId
      && row.memberId === where.memberId);
    rows.forEach((row) => Object.assign(row, data));
    return { count: rows.length };
  };
  prisma.member.findFirst = async ({ where }) => members.find((row) => (
    row.tenantId === where.tenantId
    && row.projectId === where.projectId
    && (!where.userId || row.userId === where.userId)
    && (!where.mobile || row.mobile === where.mobile)
  )) ?? null;
  prisma.member.create = async ({ data }) => {
    const row = { id: `member-${members.length + 1}`, ...data };
    members.push(row);
    return row;
  };
  prisma.$transaction = async (callback) => {
    transactionCalls += 1;
    return callback(prisma);
  };
  prisma.activity.create = async ({ data }) => data;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { tenantId: 'tenant', projectId: 'project', userId: 'owner', memberId: null, roles: ['owner'] };
    next();
  });
  app.use('/v1/memberships', membershipsRouter);
  app.use((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => {
    url = `http://127.0.0.1:${server.address().port}/v1/memberships`;
    resolve();
  }));
});

beforeEach(() => {
  members = [];
  memberships = [];
  transactionCalls = 0;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function assign(role) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: user.id, role })
  });
  return { status: response.status, body: await response.json() };
}

for (const role of ['admin', 'accountant']) {
  test(`${role}-only assignment does not create a member`, async () => {
    const result = await assign(role);
    assert.equal(result.status, 201);
    assert.equal(result.body.data.member_id, null);
    assert.equal(members.length, 0);
    assert.deepEqual(memberships.map((row) => row.role), [role]);
    assert.equal(memberships[0].memberId, null);
  });
}

test('an explicit member assignment still creates and links the member record', async () => {
  const result = await assign('member');
  assert.equal(result.status, 201);
  assert.equal(result.body.data.member_id, 'member-1');
  assert.equal(members.length, 1);
  assert.deepEqual(memberships.map((row) => row.role), ['member']);
  assert.equal(memberships[0].memberId, 'member-1');
});

test('sign-in does not promote an admin-only user to member', async () => {
  const token = signAccessToken({ sessionId: 'session', userId: user.id, tenantId: 'tenant' });
  prisma.session.findFirst = async () => ({
    id: 'session',
    tenantId: 'tenant',
    userId: user.id,
    activeProjectId: 'project',
    user
  });
  prisma.projectMembership.findMany = async () => [{
    id: 'admin-membership',
    tenantId: 'tenant',
    projectId: 'project',
    userId: user.id,
    memberId: null,
    role: 'admin',
    isActive: true
  }];

  const req = {
    header(name) {
      if (name.toLowerCase() === 'authorization') return `Bearer ${token}`;
      return undefined;
    }
  };
  let nextError;
  await authenticate(req, {}, (error) => { nextError = error; });

  assert.equal(nextError, undefined);
  assert.equal(req.auth.memberId, null);
  assert.equal(req.auth.roles.includes('member'), false);
  assert.equal(transactionCalls, 0);
  assert.equal(members.length, 0);
});
