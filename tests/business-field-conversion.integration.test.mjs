import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import express from 'express';

const url = process.env.BUSINESS_SETUP_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:55439\/business_setup_test(?:\?|$)/.test(url)) throw new Error('Use the isolated business_setup_test database on localhost:55439 only.');
test('saved custom field choice conversion in disposable PostgreSQL', { skip: !url }, async t => {
  const schemaName = 'field_conversion_test_' + randomUUID().replaceAll('-', '');
  const connection = new URL(url); connection.searchParams.set('schema', schemaName);
  Object.assign(process.env, { DATABASE_URL: connection.toString(), NODE_ENV: 'production', JWT_SECRET: 'synthetic-field-conversion-test-only' });
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: url });
  let prisma, server;
  try {
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' });
    ({ prisma } = await import('../dist/core/prisma/client.js'));
    const { businessSetupRouter } = await import('../dist/modules/business-setup/business-setup.routes.js');
    const { errorHandler } = await import('../dist/core/http/error-handler.js');
    const tenant = await prisma.tenant.create({ data: { name: 'Synthetic conversion test', slug: schemaName } });
    const otherTenant = await prisma.tenant.create({ data: { name: 'Unrelated tenant', slug: schemaName + '-other' } });
    const user = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Test admin', mobile: 'synthetic-' + randomUUID() } });
    let failAudit = false;
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.auth = { tenantId: tenant.id, projectId: req.header('x-project-id'), userId: failAudit ? 'nonexistent-audit-user' : user.id, roles: [req.header('x-role') ?? 'admin'] }; next(); });
    app.use('/setup', businessSetupRouter); app.use(errorHandler);
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/setup`;
    async function api(project, path, body, expected = 200, role = 'admin', method = body ? 'POST' : 'GET') {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-project-id': project.id, 'x-role': role }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`); return result.data ?? result.error;
    }
    const model = entity => entity === 'customer' ? prisma.customer : entity === 'dealer' ? prisma.vendor : prisma.inventoryItem;
    async function fixture(entity = 'customer', patch = {}) {
      const project = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Conversion fixture', projectType: 'accounting', totalShares: 0 } });
      const field = await prisma.businessField.create({ data: { tenantId: tenant.id, projectId: project.id, entity, key: 'tags', label: 'Tags', type: 'text', options: [], searchable: true, filterable: true, ...patch } });
      const create = (attributes, extra = {}) => model(entity).create({ data: { tenantId: tenant.id, projectId: project.id, name: 'Synthetic ' + randomUUID(), attributes, ...extra } });
      const state = () => api(project, `/entities/${entity}/schema`);
      const preview = (revision = 0, type = 'multi_select', expected = 200, role = 'admin') => api(project, `/entities/${entity}/fields/${field.id}/conversion-preview`, { revision, type }, expected, role);
      const save = async (options, expected = 200, changes = {}, revision = 0) => {
        const current = (await state()).fields[0]; const { id, ...value } = current;
        return api(project, `/entities/${entity}/fields/${id}`, { revision, field: { ...value, type: 'multi_select', options, ...changes } }, expected, 'admin', 'PATCH');
      };
      return { project, field, create, state, preview, save, entity };
    }
    for (const entity of ['customer', 'dealer', 'item']) await t.test(`${entity}: preview, conversion, filters and isolation retain saved values`, async () => {
      const f = await fixture(entity);
      const first = await f.create({ tags: ' Priority, Delivery, Priority ', other: 'kept' });
      const second = await f.create({ tags: '\tOnline,\nDelivery\u00a0,\ufeff' });
      const blank = await f.create({ tags: null }); const absent = await f.create({ other: 'present' });
      const inactive = await f.create({ tags: 'Inactive tag' }, { isActive: false });
      const unrelated = await fixture(entity); const foreign = await unrelated.create({ tags: 'Unrelated' });
      // A mismatched tenant row must never be converted, even if its project ID matches.
      const foreignTenantRow = await model(entity).create({ data: { tenantId: otherTenant.id, projectId: f.project.id, name: 'Foreign tenant', attributes: { tags: 'Private' } } });
      const before = await f.preview(); assert.deepEqual(before.options, ['Delivery', 'Inactive tag', 'Online', 'Priority']); assert.equal(before.records, 3);
      assert.equal((await model(entity).findUnique({ where: { id: first.id } })).attributes.tags, ' Priority, Delivery, Priority ');
      assert.equal((await f.state()).revision, 0);
      const saved = await f.save([...before.options, 'VIP']); assert.equal(saved.type, 'multi_select'); assert.equal(saved.key, 'tags');
      assert.deepEqual((await model(entity).findUnique({ where: { id: first.id } })).attributes, { tags: ['Priority', 'Delivery'], other: 'kept' });
      assert.deepEqual((await model(entity).findUnique({ where: { id: second.id } })).attributes.tags, ['Online', 'Delivery']);
      assert.equal((await model(entity).findUnique({ where: { id: blank.id } })).attributes.tags, null);
      assert.deepEqual((await model(entity).findUnique({ where: { id: absent.id } })).attributes, { other: 'present' });
      assert.deepEqual((await model(entity).findUnique({ where: { id: inactive.id } })).attributes.tags, ['Inactive tag']);
      assert.equal((await model(entity).findUnique({ where: { id: foreign.id } })).attributes.tags, 'Unrelated');
      assert.equal((await model(entity).findUnique({ where: { id: foreignTenantRow.id } })).attributes.tags, 'Private');
      assert.equal((await f.state()).revision, 1);
      const result = await api(f.project, `/entities/${entity}/query`, { filters: [{ key: 'tags', operator: 'in', value: ['Delivery'] }] }); assert.equal(result.entries.length, 2);
      const search = await api(f.project, `/entities/${entity}/query`, { search: 'Priority' }); assert.equal(search.entries[0].id, first.id);
      const activity = await prisma.activity.findFirst({ where: { entityId: f.field.id, action: 'business.field.updated' } }); assert.equal(activity.after.convertedRecords, 3);
      if (entity === 'item') { assert.equal((await prisma.inventoryItem.findUnique({ where: { id: first.id } })).quantity, 0); assert.equal(await prisma.stockMovement.count({ where: { projectId: f.project.id } }), 0); }
    });
    await t.test('admin-only previews, stable keys, stale settings, unsupported changes and missing fields fail safely', async () => {
      const f = await fixture(); await f.create({ tags: 'Priority' });
      await f.preview(0, 'multi_select', 403, 'accountant'); await f.preview(0, 'number', 400); await f.preview(99, 'multi_select', 409);
      await api(f.project, '/entities/customer/fields/missing/conversion-preview', { revision: 0, type: 'multi_select' }, 404);
      await f.save(['Priority'], 400, { key: 'renamed' }); await f.save(['Priority'], 400, { type: 'number', searchable: false });
      assert.equal((await f.state()).fields[0].type, 'text'); assert.equal((await f.state()).revision, 0);
    });
    await t.test('new values written after preview must be reviewed before conversion', async () => {
      const f = await fixture(); const row = await f.create({ tags: 'Priority' }); const before = await f.preview();
      await f.create({ tags: 'New tag' });
      await f.save(before.options, 409);
      assert.equal((await model('customer').findUnique({ where: { id: row.id } })).attributes.tags, 'Priority'); assert.equal((await f.state()).revision, 0);
      const refreshed = await f.preview(); await f.save(refreshed.options);
    });
    await t.test('existing choices containing commas stay intact when single choice becomes multiple', async () => {
      const f = await fixture('customer', { type: 'select', options: ['Delivery, Online', 'Unused'] }); const row = await f.create({ tags: 'Delivery, Online' });
      const preview = await f.preview(); assert.deepEqual(preview.options, ['Delivery, Online', 'Unused']);
      await f.save(['Delivery, Online'], 400); await f.save(preview.options);
      assert.deepEqual((await prisma.customer.findUnique({ where: { id: row.id } })).attributes.tags, ['Delivery, Online']);
    });
    await t.test('text to single choice keeps comma-containing values whole; empty fields accept admin choices', async () => {
      const f = await fixture('customer', { type: 'long_text' }); const row = await f.create({ tags: ' Delivery, Online ' });
      const preview = await f.preview(0, 'select'); assert.deepEqual(preview.options, ['Delivery, Online']);
      await f.save(preview.options, 200, { type: 'select' }); assert.equal((await prisma.customer.findUnique({ where: { id: row.id } })).attributes.tags, 'Delivery, Online');
      const empty = await fixture(); assert.deepEqual((await empty.preview()).options, []); await empty.save(['First option']);
      const configured = await fixture('customer', { options: ['Configured choice'] }); await configured.create({ tags: 'Saved tag' });
      const existing = await configured.preview(); assert.deepEqual(existing.options, ['Configured choice', 'Saved tag']); await configured.save(existing.options);
    });
    await t.test('conversion rejects too many choices, overlong choices and malformed data without mutation', async () => {
      for (const value of ['x'.repeat(101), Array.from({ length: 101 }, (_, i) => 'Tag' + i).join(','), ['Unexpected array']]) {
        const f = await fixture(); const row = await f.create({ tags: value }); await f.preview(0, 'multi_select', 400); await f.save(['Admin choice'], 400);
        assert.deepEqual((await prisma.customer.findUnique({ where: { id: row.id } })).attributes.tags, value); assert.equal((await f.state()).revision, 0);
      }
    });
    await t.test('a later transaction failure rolls both record conversion and definition back', async () => {
      const f = await fixture(); const row = await f.create({ tags: 'Priority, Delivery' }); const preview = await f.preview();
      failAudit = true;
      try { await f.save(preview.options, 500); } finally { failAudit = false; }
      assert.equal((await f.state()).fields[0].type, 'text'); assert.equal((await f.state()).revision, 0);
      assert.equal((await prisma.customer.findUnique({ where: { id: row.id } })).attributes.tags, 'Priority, Delivery');
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (prisma) await prisma.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.$disconnect();
  }
});
