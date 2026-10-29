import { installAccountRelationFixtures } from './helpers/normalized-fixtures.mjs';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'isolated-custom-roles-test';
const { prisma } = await import('../dist/core/prisma/client.js');
const { projectRolesRouter } = await import('../dist/modules/project-roles/project-roles.routes.js');
const { errorHandler } = await import('../dist/core/http/error-handler.js');
let rows, assignments, audits, server, base, sequence;
const matches = (row, where) => row && Object.entries(where).every(([key, value]) => value === undefined || row[key] === value);
before(async () => {
  prisma.project.findFirst = async ({ where }) => ({ id: where.id, projectType: where.id === 'payroll' ? 'payroll_pf' : where.id === 'construction' ? 'construction' : 'accounting' });
  Object.assign(prisma.projectRole, {
    findMany: async ({ where }) => rows.filter(row => matches(row, where)),
    findFirst: async ({ where }) => rows.find(row => matches(row, where)) ?? null,
    findFirstOrThrow: async ({ where }) => structuredClone(rows.find(row => matches(row, where))),
    create: async ({ data }) => { const row = { ...data, id: 'role-' + (++sequence), revision: 1 }; rows.push(row); return structuredClone(row); },
    updateMany: async ({ where, data }) => { let count = 0; for (const row of rows.filter(row => matches(row, where))) { Object.assign(row, { ...data, ...(data.revision ? { revision: row.revision + data.revision.increment } : {}) }); count++; } return { count }; },
    deleteMany: async ({ where }) => { rows = rows.filter(row => !matches(row, where)); return { count: 1 }; },
  });
  prisma.projectMembership.count = async ({ where }) => assignments.filter(row => matches(row, where)).length;
  prisma.projectMembership.updateMany = async () => ({ count: 0 });
  prisma.activity.create = async ({ data }) => { audits.push(data); return data; };
  prisma.$transaction = async operation => { const previous = structuredClone({ rows, assignments, audits }); try { return await operation(prisma); } catch (error) { ({ rows, assignments, audits } = previous); throw error; } };
  installAccountRelationFixtures(prisma);
const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.auth = { tenantId: 'tenant', projectId: req.header('x-project') ?? 'project', userId: 'owner', roles: [req.header('x-role') ?? 'owner'] }; next(); }); app.use('/roles', projectRolesRouter); app.use(errorHandler);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/roles`; resolve(); }); });
});
after(async () => { await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); });
beforeEach(() => { rows = []; assignments = []; audits = []; sequence = 0; });
const body = { name: 'Invoice clerk', description: '', permissions: { sale: { read: true, write: false } } };
async function api(path, method, data, headers = {}) { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: data ? JSON.stringify(data) : undefined }); return { status: response.status, body: await response.json() }; }
test('custom roles create, update with a revision, and delete with an audit in the same transaction', async () => {
  const created = await api('', 'POST', body); assert.equal(created.status, 201); assert.equal(created.body.data.revision, 1); const id = created.body.data.id;
  const updated = await api('/' + id, 'PUT', { ...body, name: 'Senior clerk', revision: 1 }); assert.equal(updated.status, 200); assert.equal(updated.body.data.revision, 2);
  assert.equal((await api('/' + id, 'PUT', { ...body, revision: 1 })).status, 409);
  assert.equal((await api('/' + id, 'DELETE', { revision: 2 })).status, 200); assert.equal(rows.length, 0);
  assert.deepEqual(audits.map(audit => audit.action), ['project_role.created','project_role.updated','project_role.deleted']);
});
test('permissions validate project type, read/write consistency, reserved administration and at least one read', async () => {
  for (const permissions of [{}, { sale: { read: false, write: true } }, { roles: { read: true, write: true } }, { payroll_run: { read: true, write: false } }, { ledger: { read: true, write: true } }]) {
    const response = await api('', 'POST', { ...body, permissions }); assert.ok(response.status >= 400, JSON.stringify(response));
  }
  assert.equal(rows.length, 0); assert.equal(audits.length, 0);
});
test('roles cannot be edited through another project or deleted while active people use them', async () => {
  const created = await api('', 'POST', body), id = created.body.data.id;
  assert.equal((await api('/' + id, 'PUT', { ...body, revision: 1 }, { 'x-project': 'foreign' })).status, 404);
  assignments.push({ customRoleId: id, isActive: true });
  assert.equal((await api('/' + id, 'DELETE', { revision: 1 })).status, 409); assert.equal(rows[0].revision, 1); assert.equal(audits.length, 1);
});
test('accountants and auditors cannot manage custom role definitions', async () => {
  for (const role of ['accountant','auditor','member']) assert.equal((await api('', 'POST', body, { 'x-role': role })).status, 403);
});

test('Construction inbox permissions require visible read access to the records being reviewed', async () => {
  const permissions = { construction_approvals: { read:true, write:true } };
  assert.equal((await api('', 'POST', { ...body, permissions }, {'x-project':'construction'})).status,400);
  for(const key of ['construction_budgets','construction_running_bills','construction_suppliers','construction_labor','construction_changes','construction_site_log'])permissions[key]={read:true,write:false};
  assert.equal((await api('', 'POST', { ...body, permissions }, {'x-project':'construction'})).status,201);
});
