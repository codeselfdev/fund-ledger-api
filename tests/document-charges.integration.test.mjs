import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
const url = process.env.BUSINESS_SETUP_TEST_DATABASE_URL;
if (url && !/127\.0\.0\.1:55439\/business_setup_test(?:\?|$)/.test(url)) throw new Error('Use only the disposable business_setup_test database on localhost:55439');
test('additional charges travel from quotation through order, invoice, VAT entries and payment', { skip: !url }, async t => {
  Object.assign(process.env, { DATABASE_URL: url, NODE_ENV: 'production', JWT_SECRET: 'synthetic-charges-tests-only-secret-key', UPLOAD_STORAGE: 'local', UPLOAD_LOCAL_DIR: '/tmp/nesta-document-charge-tests/uploads' });
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { createApp } = await import('../dist/app.js');
  const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');
  const { emptyTaxSetup } = await import('../dist/modules/business-setup/contract.js');
  let server;
  try {
    const tenant = await prisma.tenant.create({ data: { name: 'Synthetic charge tests', slug: 'charge-tests-' + randomUUID(), contact: { subscription: { package: 'custom', status: 'active', current_period_end_at: new Date(Date.now() + 864000000).toISOString() } } } });
    const project = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Synthetic charges business', projectType: 'accounting', totalShares: 1, stockManagementEnabled: false } });
    const foreign = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Other synthetic business', projectType: 'accounting', totalShares: 1 } });
    const customer = await prisma.customer.create({ data: { tenantId: tenant.id, projectId: project.id, name: 'Synthetic customer' } });
    const auth = {};
    for (const role of ['owner', 'auditor']) {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Synthetic ' + role, mobile: 'charges-' + randomUUID() } });
      for (const projectId of [project.id, foreign.id]) await prisma.projectMembership.create({ data: { tenantId: tenant.id, projectId, userId: user.id, role } });
      const session = await prisma.session.create({ data: { tenantId: tenant.id, userId: user.id, activeProjectId: project.id, tokenHash: 'pending', expiresAt: new Date(Date.now() + 3600000) } });
      const token = signAccessToken({ tenantId: tenant.id, userId: user.id, sessionId: session.id });
      await prisma.session.update({ where: { id: session.id }, data: { tokenHash: hashToken(token) } }); auth[role] = token;
    }
    const setup = emptyTaxSetup(); setup.revision = 1; setup.rates = [{ id: 'vat', name: 'VAT', rateBps: 1500, kind: 'add', active: true, documents: ['quotation', 'sale'] }]; setup.defaults.quotation.rateId = setup.defaults.sale.rateId = 'vat';
    await prisma.businessConfiguration.create({ data: { tenantId: tenant.id, projectId: project.id, taxSetup: setup } });
    server = createApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/v1/accounting`;
    const charges = [{ label: 'Delivery / Shipping', amount: 3000, vat_treatment: 'included' }, { label: 'Letter of Credit Fee', amount: 2000, vat_treatment: 'excluded' }];
    const body = () => ({ kind: 'quotation', customer_id: customer.id, document_date: '2026-10-22', lines: [{ description: 'Service package', source: 'service', quantity: 1, unit_price: 10000 }], additional_charges: charges, discount: 1000, tax: 0, tax_selection: { revision: 1, rateId: 'vat', withholdingId: null, inclusive: false }, expected_total: 15800, request_key: randomUUID() });
    async function api(path, payload, { method = payload === undefined ? 'GET' : 'POST', status = 200, role = 'owner', projectId = project.id, binary = false } = {}) {
      const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${auth[role]}`, 'X-Project-Id': projectId, 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
      if (binary && response.status === status) return Buffer.from(await response.arrayBuffer());
      const value = await response.json(); assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(value)}`); return value.data;
    }
    const action = (document, name) => api(`/documents/${document.id}/status`, { action: name, expected_revision: document.revision });
    const editBody = document => { const value = body(); delete value.kind; delete value.request_key; value.expected_revision = document.revision; return value; };
    let quote, order, invoice;
    await t.test('preview includes the VAT treatment and charge totals without saving a document', async () => {
      const payload = body(); delete payload.request_key;
      const preview = await api('/documents/preview', payload);
      assert.ok(preview.base64.startsWith('JVBER')); assert.ok(preview.html.includes('Delivery'));
      assert.match(preview.html.replace(/<[^>]+>/g, ' '), /outside\s+VAT\s+base/);
      assert.ok(preview.html.includes('15,800.00')); assert.equal(await prisma.businessDocument.count({ where: { projectId: project.id } }), 0);
    });
    await t.test('create persists all charges separately from stock lines and computes the reviewed VAT total', async () => {
      quote = await api('/documents', body(), { status: 201 });
      assert.deepEqual(quote.additionalCharges, charges); assert.equal(quote.lines.length, 1);
      assert.equal(quote.subtotal, 15000); assert.equal(quote.total, 15800); assert.equal(quote.tax, 1800);
      assert.equal(quote.taxSnapshot.breakdown[0].base, 12000);
      assert.deepEqual((await api(`/documents/${quote.id}`)).additionalCharges, charges);
    });
    await t.test('invalid charges, stale total, unauthorized writes and foreign-project records are rejected', async () => {
      for (const additional_charges of [[{ ...charges[0], label: '' }], [{ ...charges[0], amount: -1 }], [{ ...charges[0], amount: 1.5 }], [{ ...charges[0], vat_treatment: 'unknown' }], Array(21).fill(charges[0])]) await api('/documents', { ...body(), additional_charges }, { status: 400 });
      await api('/documents', { ...body(), expected_total: 1 }, { status: 409 });
      await api('/documents', body(), { status: 403, role: 'auditor' });
      await api(`/documents/${quote.id}`, editBody(quote), { method: 'PATCH', status: 404, projectId: foreign.id });
      await api('/documents/preview', { ...editBody(quote), kind: 'quotation', document_id: quote.id }, { status: 404, projectId: foreign.id });
      assert.equal(await prisma.businessDocument.count({ where: { projectId: project.id } }), 1);
    });
    await t.test('accepted quotation revisions retain charges and require acceptance again', async () => {
      quote = await action(quote, 'send'); quote = await action(quote, 'accept');
      quote = await api(`/documents/${quote.id}`, editBody(quote), { method: 'PATCH' });
      assert.equal(quote.status, 'sent'); assert.deepEqual(quote.additionalCharges, charges);
      quote = await action(quote, 'accept');
      order = await api(`/documents/${quote.id}/convert`, { kind: 'order', document_date: '2026-10-22', request_key: randomUUID(), expected_revision: quote.revision }, { status: 201 });
      assert.deepEqual(order.additionalCharges, charges); assert.equal(order.total, 15800); assert.deepEqual(order.taxSnapshot, quote.taxSnapshot);
    });
    await t.test('older clients omitting charges preserve them and saved rates survive tax setup changes', async () => {
      const newer = structuredClone(setup); newer.revision = 2; newer.rates[0].rateBps = 2000;
      await prisma.businessConfiguration.update({ where: { projectId: project.id }, data: { taxSetup: newer } });
      const payload = editBody(order); delete payload.additional_charges;
      order = await api(`/documents/${order.id}`, payload, { method: 'PATCH' });
      assert.deepEqual(order.additionalCharges, charges); assert.equal(order.tax, 1800); assert.equal(order.taxSnapshot.revision, 1);
      order = await action(order, 'confirm');
      invoice = await api(`/documents/${order.id}/convert`, { kind: 'sale', document_date: '2026-10-22', request_key: randomUUID(), expected_revision: order.revision }, { status: 201 });
      assert.deepEqual(invoice.additionalCharges, charges); assert.equal(invoice.total, 15800);
    });
    await t.test('invoice draft charge edits recalculate VAT and explicit removal clears all fees', async () => {
      invoice = await api(`/documents/${invoice.id}`, { ...editBody(invoice), additional_charges: [], expected_total: 10350 }, { method: 'PATCH' });
      assert.deepEqual(invoice.additionalCharges, []); assert.equal(invoice.total, 10350); assert.equal(invoice.tax, 1350);
      invoice = await api(`/documents/${invoice.id}`, editBody(invoice), { method: 'PATCH' });
      assert.deepEqual(invoice.additionalCharges, charges); assert.equal(invoice.total, 15800);
      const pdf = await api(`/documents/${invoice.id}/document.pdf`, undefined, { binary: true }); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    });
    await t.test('issuing and reversing an invoice posts VAT including only eligible charges', async () => {
      invoice = await action(invoice, 'issue');
      const entry = await prisma.businessTaxEntry.findFirstOrThrow({ where: { projectId: project.id, sourceId: invoice.id, reversal: false } });
      assert.equal(entry.base, 12000); assert.equal(entry.amount, 1800);
      await api(`/documents/${invoice.id}`, editBody(invoice), { method: 'PATCH', status: 409 });
      invoice = await action(invoice, 'cancel');
      const reversal = await prisma.businessTaxEntry.findFirstOrThrow({ where: { projectId: project.id, sourceId: invoice.id, reversal: true } }); assert.equal(reversal.amount, -1800);
      assert.deepEqual(invoice.additionalCharges, charges);
    });
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await prisma.$disconnect(); }
});
