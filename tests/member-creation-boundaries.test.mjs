import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

function load(file, deps) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name in deps, `Unexpected dependency: ${name}`);
    return deps[name];
  }, module, module.exports);
  return module.exports;
}

function authentication({ roles = ['owner'], linkedId = null, owned = [], requestedMemberId } = {}) {
  const calls = [];
  const db = {
    session: { findFirst: async () => ({ id: 'session', tenantId: 'tenant', userId: 'owner', activeProjectId: 'project', user: { id: 'owner', name: 'Owner', isActive: true } }) },
    projectMembership: { findMany: async () => roles.map(role => ({ role, memberId: role === 'member' ? linkedId : null })) },
    project: { findUnique: async () => ({ projectType: 'fund_shares' }) },
    member: { findMany: async args => { calls.push(['members', args]); return owned.map(id => ({ id })); } },
    $transaction: async fn => { calls.push(['transaction']); return fn(db); },
  };
  const error = message => new Error(message);
  const { authenticate } = load('../src/core/security/auth.middleware.ts', {
    './impersonation-policy.js': { validateImpersonatedRequest: async () => undefined },
    './client-activity.js': { recordUserActivity: async () => {} },
    '../prisma/client.js': { prisma: db }, '../http/api-error.js': { forbidden: error, unauthorized: error },
    './jwt.js': { hashToken: () => 'hash', verifyAccessToken: () => ({ sessionId: 'session', userId: 'owner', tenantId: 'tenant' }) },
    './roles.js': {}, './menu-access.js': {},
    './member-link.service.js': { ensureUserProjectMember: async () => { calls.push(['createMember']); return { memberId: 'unexpected-owner-member' }; } },
    './menu-access.middleware.js': { enforceMenuAccess: async () => {} },
    './project-access.js': { effectiveProjectRoles: roles => roles },
  });
  const req = { header: name => ({ authorization: 'Bearer token', 'x-project-id': 'project', 'x-member-id': requestedMemberId })[name] };
  return { calls, req, run: async () => {
    let failure;
    await authenticate(req, {}, error => { failure = error; });
    return failure;
  } };
}

for (const roles of [['owner'], ['admin'], ['accountant'], ['owner', 'member'], ['member']]) {
  test(`refreshing access with ${roles.join('/')} roles never creates a zero-share member`, async () => {
    const h = authentication({ roles });
    assert.equal(await h.run(), undefined);
    assert.equal(h.req.auth.memberId, null);
    assert.equal(h.calls.some(([name]) => name === 'transaction' || name === 'createMember'), false);
  });
}

test('a missing member link resolves existing share records without changing them', async () => {
  const h = authentication({ roles: ['member', 'accountant'], owned: ['existing-member'] });
  assert.equal(await h.run(), undefined);
  assert.equal(h.req.auth.memberId, 'existing-member');
  assert.deepEqual(h.req.auth.memberIds, ['existing-member']);
  assert.deepEqual(h.calls, [['members', { where: { tenantId: 'tenant', projectId: 'project', userId: 'owner', status: 'active' }, select: { id: true } }]]);
});

test('share selection preserves the linked record and rejects another user’s record', async () => {
  const h = authentication({ roles: ['member'], linkedId: 'second', owned: ['first', 'second'] });
  assert.equal(await h.run(), undefined);
  assert.equal(h.req.auth.memberId, 'second');
  const selected = authentication({ roles: ['member'], linkedId: 'second', owned: ['first', 'second'], requestedMemberId: 'first' });
  assert.equal(await selected.run(), undefined);
  assert.equal(selected.req.auth.memberId, 'first');
  const foreign = authentication({ roles: ['member'], owned: ['first'], requestedMemberId: 'foreign' });
  assert.match((await foreign.run()).message, /does not belong/);
});

function installment(savedMembers) {
  const calls = [];
  const db = {
    member: { findMany: async args => { calls.push(['members', args]); return savedMembers; } },
    schedule: { create: async ({ data }) => { calls.push(['schedule', data]); return { id: 'schedule', ...data }; } },
    due: { create: async ({ data }) => { calls.push(['due', data]); return { id: `due-${data.memberId}`, ...data }; } },
    deposit: { findMany: async () => [] },
    projectMembership: { findMany: async () => { calls.push(['projectUsers']); return [{ user: { id: 'owner' } }, { user: { id: 'accountant' } }]; } },
    $transaction: async fn => fn(db),
  };
  const { createScheduleWithUnitAmount } = load('../src/modules/schedules/schedule-creation.service.ts', {
    '@prisma/client': {}, '../../core/http/api-error.js': { badRequest: message => new Error(message) },
    '../../core/prisma/client.js': { prisma: db },
    '../../core/security/member-link.service.js': { ensureUserProjectMember: async (_tx, input) => calls.push(['createMember', input.user.id]) },
  });
  return { calls, run: () => createScheduleWithUnitAmount({ tenantId: 'tenant', projectId: 'project', name: 'Next installment', unitAmount: 100, dueDate: new Date('2099-01-01'), status: 'upcoming', createdById: 'owner' }) };
}

test('installments bill existing shares without enrolling the owner or accountant', async () => {
  const h = installment([{ id: 'selected-member', shares: 4 }]);
  const result = await h.run();
  assert.equal(result.duesCreated, 1);
  assert.equal(result.schedule.totalAmount, 400);
  assert.equal(h.calls.some(([name]) => name === 'projectUsers' || name === 'createMember'), false);
  assert.deepEqual(h.calls.find(([name]) => name === 'members')[1].where, { tenantId: 'tenant', projectId: 'project', status: 'active', shares: { gt: 0 } });
  assert.equal(h.calls.find(([name]) => name === 'due')[1].memberId, 'selected-member');
});

test('an empty member directory rejects installment creation without enrolling access-only users', async () => {
  const h = installment([]);
  await assert.rejects(h.run(), /At least one active member with shares/);
  assert.equal(h.calls.some(([name]) => ['createMember', 'schedule', 'due'].includes(name)), false);
});
