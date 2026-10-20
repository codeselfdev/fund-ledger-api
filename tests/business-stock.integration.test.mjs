import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.COMMERCE_TEST_DATABASE_URL;
if (!url) {
  test('business purchases and sales PostgreSQL regression (set COMMERCE_TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  const connection = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname));
  assert.match(connection.pathname, /test/i);
  const schema = 'business_stock_test_' + randomUUID().replaceAll('-', '');
  connection.searchParams.set('schema', schema);
  Object.assign(process.env, { DATABASE_URL: connection.toString(), JWT_SECRET: 'synthetic-stock-test-secret', NODE_ENV: 'production' });
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasourceUrl: url });
  let server, prisma;
  const temp = mkdtempSync(join(tmpdir(), 'fundnesta-stock-schema-'));
  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (prisma) await prisma.$disconnect();
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.$disconnect();
    rmSync(temp, { recursive: true, force: true });
  });
  const latest = readFileSync('prisma/schema.prisma', 'utf8');
  const legacy = latest.replace(/^  stockManagementEnabled .*\n/gm, '').replace(/^  inventoryLocations InventoryLocation\[\]\n/gm, '').replace(/^  stockLocationId .*\n/gm, '').replace(/^  stockLocation InventoryLocation.*\n/gm, '').replace(/^  stockTracked .*\n/gm, '').replace(/^  locationId String\? @map\("location_id"\)\n/gm, '').replace(/^  location InventoryLocation.*\n/gm, '').replace(/^  @@index\(\[projectId, itemId, locationId\]\)\n/gm, '').replace(/\nmodel InventoryLocation \{[\s\S]*?\n\}/, '');
  writeFileSync(join(temp, 'schema.prisma'), legacy);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--schema', join(temp, 'schema.prisma')], { env: process.env, stdio: 'pipe' });
  const seed = new PrismaClient({ datasourceUrl: connection.toString() });
  await seed.$executeRawUnsafe(`INSERT INTO tenants (id,name,slug,updated_at) VALUES ('legacy-t','Legacy','legacy-stock-test',now())`);
  await seed.$executeRawUnsafe(`INSERT INTO projects (id,tenant_id,name,total_shares,updated_at) VALUES ('legacy-p','legacy-t','Legacy',0,now())`);
  await seed.$executeRawUnsafe(`INSERT INTO inventory_items (id,tenant_id,project_id,name,quantity,updated_at) VALUES ('legacy-i','legacy-t','legacy-p','Legacy item',12,now())`);
  await seed.$executeRawUnsafe(`INSERT INTO customers (id,tenant_id,project_id,name,updated_at) VALUES ('legacy-c','legacy-t','legacy-p','Customer',now())`);
  await seed.$executeRawUnsafe(`INSERT INTO business_documents (id,tenant_id,project_id,customer_id,customer_snapshot,kind,number,status,lines,subtotal,total,document_date,workflow,events,request_key,created_by_id,updated_at) VALUES ('legacy-d','legacy-t','legacy-p','legacy-c','{}','sale','OLD-1','issued','[]',100,100,now(),'{}','[]','legacy-key','legacy-user',now())`);
  await seed.$disconnect();
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'execute', '--file', 'prisma/migrations/20261020020000_inventory_locations/migration.sql', '--url', connection.toString()], { env: process.env, stdio: 'pipe' });
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-url', connection.toString(), '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], { env: process.env, stdio: 'pipe' });
  ({ prisma } = await import('../dist/core/prisma/client.js'));
  const { accountingRouter } = await import('../dist/modules/accounting/accounting.routes.js');
  const { salesRouter } = await import('../dist/modules/sales/sales.routes.js');
  const { purchasesRouter } = await import('../dist/modules/purchases/purchases.routes.js');
  const { stockRouter } = await import('../dist/modules/inventory/stock.routes.js');
  const { inventoryRouter } = await import('../dist/modules/inventory/inventory.routes.js');
  const { errorHandler } = await import('../dist/core/http/error-handler.js');
  const tenant = await prisma.tenant.create({ data: { name: 'Synthetic stock test', slug: schema } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Test admin', mobile: 'synthetic-stock-user' } });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.auth = { tenantId: tenant.id, userId: user.id, projectId: req.header('x-project-id'), roles: [req.header('x-role') ?? 'admin'] }; next(); });
  app.use('/accounting', accountingRouter); app.use('/purchases', purchasesRouter); app.use('/sales', salesRouter); app.use('/inventory', stockRouter, inventoryRouter); app.use(errorHandler);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(project, path, body, role = 'admin', method) {
    const response = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', 'x-project-id': project.id, 'x-role': role }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  }
  async function fixture(projectType = 'accounting') {
    const project = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Synthetic business', totalShares: 0, projectType } });
    const scope = { tenantId: tenant.id, projectId: project.id };
    const item = await prisma.inventoryItem.create({ data: { ...scope, name: 'Cement', quantity: 10, costPrice: 100, sellPrice: 150 } });
    const vendor = await prisma.vendor.create({ data: { ...scope, name: 'Dealer also used as vendor' } });
    const account = await prisma.account.create({ data: { ...scope, name: 'Cash', type: 'cash', balance: 10000 } });
    const customer = await prisma.customer.create({ data: { ...scope, name: 'Customer' } });
    return { project, scope, item, vendor, account, customer };
  }
  async function draft(f, quantities = [4, 3]) {
    const result = await request(f.project, '/accounting/documents', { kind: 'sale', customer_id: f.customer.id, document_date: '2026-01-01', request_key: randomUUID(), lines: quantities.map(quantity => ({ item_id: f.item.id, description: f.item.name, quantity, unit_price: 150 })) });
    assert.equal(result.status, 201, JSON.stringify(result)); return result.data;
  }
  const quantity = f => prisma.inventoryItem.findUniqueOrThrow({ where: { id: f.item.id } }).then(item => item.quantity);
  test('migration preserves legacy stock and marks existing sales as tracked', async () => {
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: 'legacy-p' } })).stockManagementEnabled, true);
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: 'legacy-i' } })).quantity, 12);
    assert.equal((await prisma.businessDocument.findUniqueOrThrow({ where: { id: 'legacy-d' } })).stockTracked, true);
  });
  test('received purchases add stock once; draft/issued/cancelled sales share that stock and dealer identity', async () => {
    const f = await fixture();
    const ordered = await request(f.project, '/purchases', { vendor_id: f.vendor.id, account_id: f.account.id, lines: [3, 2].map(quantity => ({ item_id: f.item.id, quantity, unit_cost: 100 })) });
    assert.equal(ordered.status, 201, JSON.stringify(ordered)); assert.equal(await quantity(f), 10);
    const listed = await request(f.project, '/purchases'); assert.equal(listed.data[0].vendor.id, f.vendor.id);
    const receive = await Promise.all([0, 1].map(() => request(f.project, `/purchases/${ordered.data.id}/receive`, {})));
    assert.deepEqual(receive.map(r => r.status).sort(), [200, 400]); assert.equal(await quantity(f), 15);
    assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: f.account.id } })).balance, 9500);
    const sale = await draft(f); assert.equal(await quantity(f), 15);
    const issue = await Promise.all([0, 1].map(() => request(f.project, `/accounting/documents/${sale.id}/status`, { action: 'issue' })));
    assert.deepEqual(issue.map(r => r.status).sort(), [200, 409]); assert.equal(await quantity(f), 8);
    const cancelled = await request(f.project, `/accounting/documents/${sale.id}/status`, { action: 'cancel' }); assert.equal(cancelled.status, 200); assert.equal(await quantity(f), 15);
    const stock = await prisma.stockMovement.findMany({ where: { itemId: f.item.id } }); assert.equal(stock.reduce((sum, row) => sum + row.quantity, 0), 5);
    assert.equal((await request(f.project, `/accounting/documents/${sale.id}/status`, { action: 'cancel' })).status, 409); assert.equal(await quantity(f), 15);
  });
  test('simultaneous manual adjustment and sale preserve both stock changes', async () => {
    const f = await fixture(), sale = await draft(f, [5]);
    const results = await Promise.all([request(f.project, `/inventory/items/${f.item.id}/adjust`, { type: 'increase', quantity: 7, reason: 'Stock count' }), request(f.project, `/accounting/documents/${sale.id}/status`, { action: 'issue' })]);
    assert.deepEqual(results.map(r => r.status), [200, 200]); assert.equal(await quantity(f), 12);
    const stock = await prisma.stockMovement.findMany({ where: { itemId: f.item.id }, orderBy: { createdAt: 'asc' } });
    assert.equal(stock.length, 2); assert.equal(stock.reduce((sum, row) => sum + row.quantity, 10), 12);
  });
  test('competing decreases cannot oversell; rejected sales leave stock and movement history unchanged', async () => {
    const f = await fixture();
    const results = await Promise.all([0, 1].map(() => request(f.project, `/inventory/items/${f.item.id}/adjust`, { type: 'decrease', quantity: 7, reason: 'Stock count' })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(await quantity(f), 3);
    const sale = await draft(f, [4]); assert.equal((await request(f.project, `/accounting/documents/${sale.id}/status`, { action: 'issue' })).status, 409);
    assert.equal(await quantity(f), 3); assert.equal(await prisma.stockMovement.count({ where: { itemId: f.item.id } }), 1);
    assert.equal((await prisma.businessDocument.findUniqueOrThrow({ where: { id: sale.id } })).status, 'draft');
  });

  test('location CRUD enforces admin access, scopes records and retains history on deletion', async () => {
    const f = await fixture();
    const config = await request(f.project, '/inventory/settings'); assert.equal(config.data.stock_management_enabled, true); assert.equal(config.data.locations.length, 1);
    assert.equal((await request(f.project, '/inventory/locations', { name: 'Branch' }, 'accountant')).status, 403);
    const location = await request(f.project, '/inventory/locations', { name: 'Branch', address: 'Dhaka' }); assert.equal(location.status, 201);
    const edit = await request(f.project, `/inventory/locations/${location.data.id}`, { name: 'North warehouse' }, 'admin', 'PATCH'); assert.equal(edit.data.name, 'North warehouse');
    const other = await fixture(); assert.equal((await request(other.project, `/inventory/locations/${location.data.id}`, { name: 'Stolen' }, 'admin', 'PATCH')).status, 404);
    assert.equal((await request(f.project, `/inventory/locations/${location.data.id}`, undefined, 'admin', 'DELETE')).status, 200);
    const archived = await prisma.inventoryLocation.findUniqueOrThrow({ where: { id: location.data.id } }); assert.equal(archived.isActive, false);
    assert.equal((await request(f.project, `/inventory/locations/${config.data.default_location_id}`, undefined, 'admin', 'DELETE')).status, 409);
  });
  test('sales cannot use another location’s stock and receiving purchases adds only to the selected location', async () => {
    const f = await fixture(); const branch = (await request(f.project, '/inventory/locations', { name: 'Branch' })).data;
    const sale = await request(f.project, '/accounting/documents', { kind: 'sale', location_id: branch.id, customer_id: f.customer.id, document_date: '2026-01-01', request_key: randomUUID(), lines: [{ item_id: f.item.id, description: 'Cement', quantity: 2, unit_price: 150 }] });
    assert.equal((await request(f.project, `/accounting/documents/${sale.data.id}/status`, { action: 'issue' })).status, 409); assert.equal(await quantity(f), 10);
    const purchase = await request(f.project, '/purchases', { location_id: branch.id, account_id: f.account.id, lines: [{ item_id: f.item.id, quantity: 3, unit_cost: 100 }] });
    assert.equal((await request(f.project, `/purchases/${purchase.data.id}/receive`, {})).status, 200); assert.equal(await quantity(f), 13);
    assert.equal((await request(f.project, `/accounting/documents/${sale.data.id}/status`, { action: 'issue' })).status, 200); assert.equal(await quantity(f), 11);
    const details = await request(f.project, `/inventory/items/${f.item.id}/movements`); assert.equal(details.data.item.locationStocks.find(row => row.locationId === branch.id).quantity, 1);
    assert.equal((await request(f.project, `/inventory/locations/${branch.id}`, undefined, 'admin', 'DELETE')).status, 409);
    const foreign = await fixture(); assert.equal((await request(foreign.project, '/purchases', { location_id: branch.id, lines: [{ item_id: foreign.item.id, quantity: 1, unit_cost: 100 }] })).status, 404);
  });
  test('stock switch is admin-only; disabled receipts and sales leave quantities unchanged; cancellation restores previously tracked sales', async () => {
    const f = await fixture(), issued = await draft(f, [2]);
    assert.equal((await request(f.project, `/accounting/documents/${issued.id}/status`, { action: 'issue' })).status, 200); assert.equal(await quantity(f), 8);
    assert.equal((await request(f.project, '/inventory/settings', { stock_management_enabled: false }, 'accountant', 'PATCH')).status, 403);
    assert.equal((await request(f.project, '/inventory/settings', { stock_management_enabled: false }, 'admin', 'PATCH')).status, 200);
    const sale = await draft(f, [99]); assert.equal((await request(f.project, `/accounting/documents/${sale.id}/status`, { action: 'issue' })).status, 200); assert.equal(await quantity(f), 8);
    assert.equal((await request(f.project, `/accounting/documents/${sale.id}/status`, { action: 'cancel' })).status, 200); assert.equal(await quantity(f), 8);
    assert.equal((await request(f.project, `/accounting/documents/${issued.id}/status`, { action: 'cancel' })).status, 200); assert.equal(await quantity(f), 10);
    const purchase = await request(f.project, '/purchases', { account_id: f.account.id, lines: [{ item_id: f.item.id, quantity: 7, unit_cost: 100 }] });
    assert.equal((await request(f.project, `/purchases/${purchase.data.id}/receive`, {})).status, 200); assert.equal(await quantity(f), 10);
    assert.equal((await request(f.project, `/inventory/items/${f.item.id}/adjust`, { type: 'increase', quantity: 2, reason: 'Count' })).status, 400);
    assert.equal((await request(f.project, '/inventory/settings', { stock_management_enabled: true }, 'admin', 'PATCH')).status, 200); assert.equal(await quantity(f), 10);
  });  test('direct sales use the same location balances and preserve quantities when tracking is disabled', async () => {
    const f = await fixture(), branch = (await request(f.project, '/inventory/locations', { name: 'Branch' })).data;
    const purchase = await request(f.project, '/purchases', { location_id: branch.id, account_id: f.account.id, lines: [{ item_id: f.item.id, quantity: 5, unit_cost: 100 }] });
    await request(f.project, `/purchases/${purchase.data.id}/receive`, {});
    const body = { location_id: branch.id, account_id: f.account.id, lines: [{ item_id: f.item.id, quantity: 2, unit_price: 150 }] };
    const sold = await request(f.project, '/sales', body); assert.equal(sold.status, 201, JSON.stringify(sold)); assert.equal(await quantity(f), 13);
    assert.equal((await request(f.project, `/sales/${sold.data.id}/cancel`, {})).status, 200); assert.equal(await quantity(f), 15);
    await request(f.project, '/inventory/settings', { stock_management_enabled: false }, 'admin', 'PATCH');
    const untracked = await request(f.project, '/sales', { ...body, lines: [{ item_id: f.item.id, quantity: 99, unit_price: 150 }] });
    assert.equal(untracked.status, 201, JSON.stringify(untracked)); assert.equal(await quantity(f), 15);
    assert.equal((await request(f.project, `/sales/${untracked.data.id}/cancel`, {})).status, 200); assert.equal(await quantity(f), 15);
  });

}
