import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
const url = process.env.BUSINESS_SETUP_TEST_DATABASE_URL;
if (url && !/127\.0\.0\.1:55439\/business_setup_test(?:\?|$)/.test(url)) throw new Error('Use only the disposable business_setup_test database on localhost:55439');
test('customer and dealer logos, isolation, image limits and document quotas', { skip: !url }, async t => {
  Object.assign(process.env, { DATABASE_URL: url, NODE_ENV: 'production', JWT_SECRET: 'synthetic-logo-tests-only-secret-key', UPLOAD_STORAGE: 'local', UPLOAD_LOCAL_DIR: '/tmp/nesta-record-logo-tests/uploads' });
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { createApp } = await import('../dist/app.js');
  const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');
  const { tenantQuota } = await import('../dist/core/subscription/quota.service.js');
  const tenants = []; let server;
  const contact = plan => ({ subscription: { package: plan, status: 'active', billing_cycle: 'monthly', current_period_end_at: new Date(Date.now() + 864000000).toISOString() } });
  try {
    const tenant = await prisma.tenant.create({ data: { name: 'Synthetic logo tests', slug: 'logo-tests-' + randomUUID(), contact: contact('custom') } }); tenants.push(tenant.id);
    const project = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Synthetic accounting', projectType: 'accounting', totalShares: 1 } });
    const billing = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Synthetic billing', projectType: 'billing', totalShares: 1 } });
    const customer = await prisma.customer.create({ data: { tenantId: tenant.id, projectId: project.id, name: 'Synthetic customer' } });
    const dealer = await prisma.vendor.create({ data: { tenantId: tenant.id, projectId: project.id, name: 'Synthetic dealer' } });
    const billingCustomer = await prisma.customer.create({ data: { tenantId: tenant.id, projectId: billing.id, name: 'Synthetic billing customer' } });
    const auth = {};
    for (const role of ['owner', 'accountant', 'cashier', 'auditor']) {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Synthetic ' + role, mobile: 'logo-' + randomUUID() } });
      for (const projectId of [project.id, billing.id]) await prisma.projectMembership.create({ data: { tenantId: tenant.id, projectId, userId: user.id, role } });
      const session = await prisma.session.create({ data: { tenantId: tenant.id, userId: user.id, activeProjectId: project.id, tokenHash: 'pending', expiresAt: new Date(Date.now() + 3600000) } });
      const token = signAccessToken({ tenantId: tenant.id, userId: user.id, sessionId: session.id });
      await prisma.session.update({ where: { id: session.id }, data: { tokenHash: hashToken(token) } }); auth[role] = { user, token };
    }
    server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    const path = (entity, id) => `/business-setup/entities/${entity}/records/${id}/logo`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
    async function request(route, { method = 'GET', body, role = 'owner', projectId = project.id, status = 200, raw = false } = {}) {
      const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${auth[role].token}`, 'X-Project-Id': projectId, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
      if (raw && response.status === status) return Buffer.from(await response.arrayBuffer());
      const value = await response.json(); if (Array.isArray(status)) { assert.ok(status.includes(response.status), JSON.stringify(value)); return { ...value.data, http_status: response.status }; } assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`); return value.data;
    }
    const upload = (entity, id, expected, options = {}) => {
      const { bytes = png, ...rest } = options, body = new FormData();
      body.append('expected_file_id', expected ?? ''); body.append('file', new Blob([bytes], { type: 'image/png' }), 'synthetic-logo.png');
      return request(path(entity, id), { ...rest, method: 'POST', body });
    };
    const remove = (entity, id, expected, options = {}) => request(path(entity, id), { ...options, method: 'DELETE', body: { expected_file_id: expected } });
    let customerLogo, dealerLogo;
    await t.test('logos are optional and missing logos consume no document slots', async () => {
      assert.deepEqual(await request(path('customer', customer.id)), { file_id: null });
      assert.deepEqual(await request(path('dealer', dealer.id)), { file_id: null });
      assert.equal((await tenantQuota(tenant.id)).documents.used, 0);
    });
    await t.test('saving customer and dealer logos counts one document each and exposes protected thumbnails', async () => {
      customerLogo = (await upload('customer', customer.id, null)).file_id;
      dealerLogo = (await upload('dealer', dealer.id, null)).file_id;
      assert.equal((await tenantQuota(tenant.id)).documents.used, 2);
      const customers = await request('/business-setup/entities/customer/query', { method: 'POST', body: {} });
      const dealers = await request('/business-setup/entities/dealer/query', { method: 'POST', body: {} });
      assert.equal(customers.entries[0].logoFileId, customerLogo); assert.equal(dealers.entries[0].logoFileId, dealerLogo);
      assert.equal((await request('/customers'))[0].logoFileId, customerLogo);
      assert.equal((await request('/vendors'))[0].logoFileId, dealerLogo);
      assert.deepEqual(await request(`/uploads/${customerLogo}/view`, { raw: true }), png);
    });
    await t.test('2 MB is inclusive; larger or disguised non-image files are rejected without quota changes', async () => {
      const exact = Buffer.alloc(2_000_000); png.copy(exact);
      customerLogo = (await upload('customer', customer.id, customerLogo, { bytes: exact })).file_id;
      await upload('customer', customer.id, customerLogo, { bytes: Buffer.alloc(2_000_001), status: 400 });
      await upload('customer', customer.id, customerLogo, { bytes: Buffer.from('<svg><script>alert(1)</script></svg>'), status: 400 });
      await upload('customer', customer.id, customerLogo, { bytes: Buffer.from('%PDF-1.7'), status: 400 });
      assert.equal((await tenantQuota(tenant.id)).documents.used, 2);
      assert.equal((await request(path('customer', customer.id))).file_id, customerLogo);
    });
    await t.test('read-only roles cannot mutate logos; accounting cashiers cannot edit dealer or billing customer logos', async () => {
      assert.equal((await request(path('customer', customer.id), { role: 'auditor' })).file_id, customerLogo);
      await upload('customer', customer.id, customerLogo, { role: 'auditor', status: 403 });
      await remove('dealer', dealer.id, dealerLogo, { role: 'auditor', status: 403 });
      await upload('dealer', dealer.id, dealerLogo, { role: 'cashier', status: 403 });
      await upload('customer', billingCustomer.id, null, { role: 'cashier', projectId: billing.id, status: 403 });
      customerLogo = (await upload('customer', customer.id, customerLogo, { role: 'cashier' })).file_id;
    });
    await t.test('project switching never exposes or changes another project’s logos', async () => {
      await request(path('customer', customer.id), { projectId: billing.id, status: 404 });
      await upload('customer', customer.id, customerLogo, { projectId: billing.id, status: 404 });
      await remove('dealer', dealer.id, dealerLogo, { projectId: billing.id, status: 404 });
      await request(`/uploads/${customerLogo}/view`, { projectId: billing.id, status: 404 });
      assert.equal((await request(path('dealer', dealer.id))).file_id, dealerLogo);
    });
    await t.test('generic uploads cannot bypass customer/dealer logo rules', async () => {
      const body = new FormData(); body.append('purpose', `customer_logo:${customer.id}`); body.append('file', new Blob([png], { type: 'image/png' }), 'bypass.png');
      await request('/uploads', { method: 'POST', body, status: 400 });
    });
    await t.test('replacement at the full quota preserves one slot; removal releases one slot; failed additions roll back', async () => {
      await prisma.upload.createMany({ data: Array.from({ length: 98 }, (_, i) => ({ tenantId: tenant.id, projectId: project.id, userId: auth.owner.user.id, size: 1, mimeType: 'application/pdf', fileName: `fixture-${i}.pdf`, storageKey: `synthetic/${randomUUID()}` })) });
      await prisma.tenant.update({ where: { id: tenant.id }, data: { contact: contact('free') } });
      assert.deepEqual((await tenantQuota(tenant.id)).documents, { used: 100, limit: 100 });
      const previous = customerLogo; customerLogo = (await upload('customer', customer.id, previous)).file_id;
      assert.notEqual(customerLogo, previous); assert.equal((await tenantQuota(tenant.id)).documents.used, 100);
      await request(`/uploads/${previous}/view`, { status: 404 });
      const newCustomer = await prisma.customer.create({ data: { tenantId: tenant.id, projectId: project.id, name: 'No quota customer' } });
      await upload('customer', newCustomer.id, null, { status: 409 });
      assert.equal((await request(path('customer', newCustomer.id))).file_id, null);
      await remove('dealer', dealer.id, dealerLogo); dealerLogo = null;
      assert.equal((await tenantQuota(tenant.id)).documents.used, 99);
      dealerLogo = (await upload('dealer', dealer.id, null)).file_id;
      assert.equal((await tenantQuota(tenant.id)).documents.used, 100);
    });
    await t.test('stale concurrent replacements cannot overwrite a logo the user has not reviewed', async () => {
      const old = customerLogo;
      const results = await Promise.all([upload('customer', customer.id, old, { status: [200, 409] }), upload('customer', customer.id, old, { status: [200, 409] })]);
      assert.deepEqual(results.map(value => value.http_status).sort(), [200, 409]);
      customerLogo = (await request(path('customer', customer.id))).file_id;
      assert.notEqual(customerLogo, old);
      await remove('customer', customer.id, old, { status: 409 });
      assert.equal((await tenantQuota(tenant.id)).documents.used, 100);
    });
    await t.test('logo changes retain an audit trail without changing contact details', async () => {
      assert.equal((await prisma.customer.findUnique({ where: { id: customer.id } })).name, customer.name);
      assert.ok(await prisma.activity.count({ where: { tenantId: tenant.id, projectId: project.id, action: 'business.logo.updated' } }) > 0);
      assert.ok(await prisma.activity.count({ where: { tenantId: tenant.id, projectId: project.id, action: 'business.logo.removed' } }) > 0);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    // This test runs exclusively in a disposable database; the runner removes it after exit.
    await prisma.$disconnect();
  }
});
