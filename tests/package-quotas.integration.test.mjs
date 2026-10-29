import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';

// Run only against a disposable database with the quota migration already applied.
const url = process.env.QUOTA_TEST_DATABASE_URL;
test('organization package enforcement against PostgreSQL', { skip: !url }, async t => {
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET ??= 'isolated-quota-integration-secret';
  process.env.NODE_ENV = 'production';
  process.env.UPLOAD_STORAGE = 'local';
  process.env.UPLOAD_LOCAL_DIR = `/tmp/fundledger-retention-test-${process.pid}`;
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { createOneMonthTrial, evaluateSubscription, renewTenantSubscription } = await import('../dist/core/subscription/subscription.service.js');
  const { tenantQuota, assertPersonCapacity, assertProjectCapacity } = await import('../dist/core/subscription/quota.service.js');
  const { freeDocumentsPurgeAt } = await import('../dist/core/subscription/document-retention.js');
  const { selectPackage } = await import('../dist/modules/subscription/package-selection.service.js');
  const { submitInvoicePayment, reviewInvoicePayment } = await import('../dist/modules/subscription/billing.service.js');
  const prefix = `quota-test-${randomUUID()}`;
  const orgs = [];
  async function org(plan = 'free') {
    const id = `${prefix}-${orgs.length}`;
    const row = await prisma.tenant.create({ data: { id, name: id, slug: id, contact: { subscription: { ...createOneMonthTrial(), package: plan } } } }); orgs.push(id); return row;
  }
  const project = tenantId => prisma.project.create({ data: { tenantId, name: 'Test project', totalShares: 1000 } });
  const user = (tenantId, mobile = randomUUID()) => prisma.user.create({ data: { tenantId, name: 'Test user', mobile } });
  const setPlan = async (tenantId, plan) => { const row = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }); return prisma.tenant.update({ where: { id: tenantId }, data: { contact: { ...row.contact, subscription: { ...row.contact.subscription, package: plan } } } }); };
  const document = (tenantId, projectId, userId, extra = {}) => ({ tenantId, projectId, userId, fileName: 'test.pdf', mimeType: 'application/pdf', size: 100, storageKey: randomUUID(), ...extra });
  try {
    await t.test('free project cap is atomic under concurrent creates; other organizations are independent', async () => {
      const a = await org(), b = await org(); await project(a.id);
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => project(a.id)));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      results.filter(r => r.status === 'rejected').forEach(r => assert.match(r.reason.message, /PROJECT_QUOTA_EXCEEDED/));
      assert.equal((await tenantQuota(a.id)).projects.used, 2);
      await project(b.id); assert.equal((await tenantQuota(b.id)).projects.used, 1);
    });
    await t.test('documents count across projects, deletion frees capacity, size boundary includes exactly 5 MB', async () => {
      const a = await org(), p1 = await project(a.id), p2 = await project(a.id), u = await user(a.id);
      await prisma.upload.createMany({ data: Array.from({ length: 100 }, (_, i) => document(a.id, i % 2 ? p1.id : p2.id, u.id)) });
      await assert.rejects(prisma.upload.create({ data: document(a.id, p1.id, u.id) }), /DOCUMENT_QUOTA_EXCEEDED/);
      const old = await prisma.upload.findFirstOrThrow({ where: { tenantId: a.id } });
      await prisma.upload.update({ where: { id: old.id }, data: { deletedAt: new Date() } });
      assert.equal((await tenantQuota(a.id)).documents.used, 99);
      await assert.rejects(prisma.upload.create({ data: document(a.id, p2.id, u.id, { size: 5000001 }) }), /DOCUMENT_TOO_LARGE/);
      await prisma.upload.create({ data: document(a.id, p2.id, u.id, { size: 5000000 }) });
      assert.equal((await tenantQuota(a.id)).documents.used, 100);
    });
    await t.test('simultaneous uploads cannot claim the last document slot twice', async () => {
      const a = await org(), p = await project(a.id), u = await user(a.id);
      await prisma.upload.createMany({ data: Array.from({ length: 99 }, () => document(a.id, p.id, u.id)) });
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => prisma.upload.create({ data: document(a.id, p.id, u.id) })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal((await tenantQuota(a.id)).documents.used, 100);
    });
    await t.test('Starter counts users and unlinked members once, including shared roles and login linkage', async () => {
      const a = await org('starter'), p = await project(a.id), first = await user(a.id, 'first');
      await prisma.user.createMany({ data: Array.from({ length: 18 }, (_, i) => ({ tenantId: a.id, name: 'User', mobile: `seat-${i}` })) });
      const m = await prisma.member.create({ data: { tenantId: a.id, projectId: p.id, name: 'No login yet', mobile: 'last-seat', shares: 1 } });
      await assert.rejects(user(a.id), /USER_QUOTA_EXCEEDED/);
      await assert.rejects(assertPersonCapacity(a.id, { mobile: 'extra-person' }), /user\/member limit/);
      const linked = await user(a.id, 'last-seat'); // replaces the unlinked identity, no new seat
      await prisma.member.update({ where: { id: m.id }, data: { userId: linked.id } });
      await prisma.projectMembership.createMany({ data: ['owner', 'admin', 'accountant', 'member'].map(role => ({ tenantId: a.id, projectId: p.id, userId: first.id, role })) });
      assert.equal((await tenantQuota(a.id)).users.used, 20);
      await assertPersonCapacity(a.id, { user_id: first.id });
      await assert.rejects(prisma.member.create({ data: { tenantId: a.id, projectId: p.id, name: 'Over cap', mobile: 'extra', shares: 1 } }), /USER_QUOTA_EXCEEDED/);
      await prisma.member.update({ where: { id: m.id }, data: { status: 'inactive' } });
      await prisma.user.update({ where: { id: linked.id }, data: { isActive: false } });
      await user(a.id); assert.equal((await tenantQuota(a.id)).users.used, 20);
    });
    await t.test('concurrent user creation and bulk import roll back at the paid seat limit', async () => {
      const a = await org('starter');
      await prisma.user.createMany({ data: Array.from({ length: 19 }, (_, i) => ({ tenantId: a.id, name: 'User', mobile: `user-${i}` })) });
      const results = await Promise.allSettled(Array.from({ length: 4 }, () => user(a.id)));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      await assert.rejects(prisma.$transaction(async tx => { await tx.user.create({ data: { tenantId: a.id, name: 'Import', mobile: 'new' } }); }), /USER_QUOTA_EXCEEDED/);
      assert.equal((await tenantQuota(a.id)).users.used, 20);
    });
    for (const [plan, docs, seats, projects] of [['starter', 1000, 20, 2], ['business', 15000, 500, 6]]) {
      await t.test(`${plan} enforces the exact document, user and project boundaries`, async () => {
        const a = await org('custom'), p = await project(a.id), u = await user(a.id);
        await prisma.upload.createMany({ data: Array.from({ length: docs }, () => document(a.id, p.id, u.id)) });
        await prisma.user.createMany({ data: Array.from({ length: seats - 1 }, (_, i) => ({ tenantId: a.id, name: 'User', mobile: `person-${i}` })) });
        await prisma.project.createMany({ data: Array.from({ length: projects - 1 }, () => ({ tenantId: a.id, name: 'Project', totalShares: 1 })) });
        await setPlan(a.id, plan);
        await assert.rejects(prisma.upload.create({ data: document(a.id, p.id, u.id) }), /DOCUMENT_QUOTA_EXCEEDED/);
        await assert.rejects(user(a.id), /USER_QUOTA_EXCEEDED/);
        await assert.rejects(project(a.id), /PROJECT_QUOTA_EXCEEDED/);
        const quota = await tenantQuota(a.id); assert.equal(quota.documents.used, docs); assert.equal(quota.users.used, seats); assert.equal(quota.projects.used, projects); assert.equal(quota.projects.limit, projects); await assert.rejects(assertProjectCapacity(a.id), /project limit/);
      });
    }
    for (const [plan, cycle, amount] of [['starter', 'monthly', 3000], ['starter', 'yearly', 30000], ['business', 'monthly', 8000], ['business', 'yearly', 80000]]) {
      await t.test(`${plan} ${cycle} invoice uses the current catalog price`, async () => {
        const a = await org(), u = await user(a.id);
        const invoice = await selectPackage(a.id, u.id, plan, cycle);
        assert.equal(invoice.amount, amount); assert.equal(invoice.currency, 'BDT');
        assert.equal((await tenantQuota(a.id)).package, 'free');
      });
    }
    await t.test('organizations over a reduced project cap retain their records and reject new capacity', async () => {
      const a = await org('custom');
      for (let i=0;i<7;i++) await project(a.id);
      for (const [plan, limit] of [['starter',2], ['business',6]]) {
        await setPlan(a.id, plan);
        const before = await tenantQuota(a.id); assert.deepEqual(before.projects, {used:7,limit});
        const existing = await prisma.project.findFirstOrThrow({where:{tenantId:a.id}});
        await prisma.project.update({where:{id:existing.id},data:{tenantId:a.id,name:'Still editable'}});
        await assert.rejects(project(a.id), /PROJECT_QUOTA_EXCEEDED/);
        assert.equal(await prisma.project.count({where:{tenantId:a.id}}),7);
        await assert.rejects(selectPackage(a.id, 'operator', plan, 'monthly'), /usage exceeds/);
      }
    });
    await t.test('a previously issued invoice retains its agreed price on selection retry', async () => {
      const a = await org(), u = await user(a.id);
      const oldInvoice = {id: 'previously-issued', package: 'starter', billing_cycle: 'monthly', amount: 1000, currency: 'BDT', status: 'open'};
      await prisma.tenant.update({where:{id:a.id},data:{contact:{...a.contact,billing:{invoices:[oldInvoice]}}}});
      const invoice = await selectPackage(a.id,u.id,'starter','monthly');
      assert.equal(invoice.id,'previously-issued'); assert.equal(invoice.amount,1000);
      assert.equal((await prisma.tenant.findUniqueOrThrow({where:{id:a.id}})).contact.billing.invoices.length,1);
    });
    await t.test('invoices are priced on the server; pending/rejected payments never activate quotas', async () => {
      const a = await org(), u = await user(a.id);
      const invoice = await selectPackage(a.id, u.id, 'starter', 'monthly'); assert.equal(invoice.amount, 3000); assert.equal(invoice.currency, 'BDT');
      assert.equal((await selectPackage(a.id, u.id, 'starter', 'monthly')).id, invoice.id);
      assert.equal((await tenantQuota(a.id)).package, 'free');
      await assert.rejects(selectPackage(a.id, u.id, 'business', 'yearly'), /unpaid invoice/);
      await submitInvoicePayment(a.id, invoice.id, u.id, {payment_reference:'TX-test',payment_amount:invoice.amount,request_key:randomUUID()}, {originalname:'receipt.pdf',buffer:Buffer.from('%PDF-1.4 synthetic receipt'),size:Buffer.byteLength('%PDF-1.4 synthetic receipt')});
      assert.equal((await tenantQuota(a.id)).package, 'free');
      await reviewInvoicePayment(a.id, invoice.id, 'reject', 'Not received');
      assert.equal((await tenantQuota(a.id)).package, 'free');
      await submitInvoicePayment(a.id, invoice.id, u.id, {payment_reference:'TX-confirmed',payment_amount:invoice.amount,request_key:randomUUID()}, {originalname:'receipt.pdf',buffer:Buffer.from('%PDF-1.4 synthetic receipt'),size:Buffer.byteLength('%PDF-1.4 synthetic receipt')});
      await reviewInvoicePayment(a.id, invoice.id, 'approve');
      const paid = await prisma.tenant.findUniqueOrThrow({ where: { id: a.id } });
      assert.equal(evaluateSubscription(paid.contact).status, 'active'); assert.equal((await tenantQuota(a.id)).package, 'starter');
      assert.equal(freeDocumentsPurgeAt(paid.contact), null);
      const end = paid.contact.subscription.current_period_end_at;
      await reviewInvoicePayment(a.id, invoice.id, 'approve');
      assert.equal((await prisma.tenant.findUniqueOrThrow({ where: { id: a.id } })).contact.subscription.current_period_end_at, end);
    });
    await t.test('multipart guards, scoped deletion and physical retention cleanup use organization quotas', async () => {
      const express = (await import('express')).default;
      const { uploadsRouter } = await import('../dist/modules/uploads/uploads.routes.js');
      const { memberDocumentsRouter } = await import('../dist/modules/member-documents/member-documents.routes.js');
      const { errorHandler } = await import('../dist/core/http/error-handler.js');
      const { cleanupRetainedDocuments } = await import('../dist/core/subscription/document-retention.js');
      const { storeObject, readObject } = await import('../dist/core/storage/object-storage.service.js');
      const a = await org(), p = await project(a.id), u = await user(a.id);
      const m = await prisma.member.create({ data: { tenantId: a.id, projectId: p.id, userId: u.id, name: 'Member', mobile: u.mobile, shares: 1 } });
      await prisma.tenant.update({ where: { id: a.id }, data: { contact: { ...a.contact, member_document_titles: [{ id: 'identity', title: 'Identity', is_active: true }] } } });
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.auth = { tenantId: a.id, projectId: p.id, userId: u.id, roles: [req.header('x-role') ?? 'admin'], memberId: req.header('x-self') === 'yes' ? m.id : null }; next(); });
      app.use('/uploads', uploadsRouter); app.use('/', memberDocumentsRouter); app.use(errorHandler);
      const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const form = size => { const f = new FormData(); f.append('file', new Blob([new Uint8Array(size)], { type: 'application/pdf' }), 'test.pdf'); return f; };
        let response = await fetch(base + '/uploads', { method: 'POST', body: form(5000000) });
        assert.equal(response.status, 201, JSON.stringify(await response.json()));
        response = await fetch(base + '/uploads', { method: 'POST', body: form(5000001) });
        assert.equal(response.status, 413); assert.equal((await response.json()).error.code, 'DOCUMENT_TOO_LARGE');
        const f = form(100); f.append('title_id', 'identity');
        response = await fetch(base + `/members/${m.id}/documents`, { method: 'POST', body: f });
        assert.equal(response.status, 201); const saved = (await response.json()).data;
        assert.equal((await tenantQuota(a.id)).documents.used, 2);
        response = await fetch(base + `/members/${m.id}/documents/${saved.id}`, { method: 'DELETE', headers: { 'x-role': 'member' } });
        assert.equal(response.status, 403);
        response = await fetch(base + `/members/foreign/documents/${saved.id}`, { method: 'DELETE' }); assert.equal(response.status, 404);
        response = await fetch(base + `/members/${m.id}/documents/${saved.id}`, { method: 'DELETE', headers: { 'x-role': 'member', 'x-self': 'yes' } }); assert.equal(response.status, 200);
        assert.equal((await tenantQuota(a.id)).documents.used, 1);
        response = await fetch(base + `/members/${m.id}/documents/${saved.id}/view`); assert.equal(response.status, 404);
        const removed = await prisma.upload.findUniqueOrThrow({ where: { id: saved.id } });
        await readObject(removed.storageKey); // recoverable backup still exists
        await cleanupRetainedDocuments(new Date(removed.purgeAfterAt.getTime() - 1));
        assert.ok(await prisma.upload.findUnique({ where: { id: saved.id } }));
        await cleanupRetainedDocuments(removed.purgeAfterAt);
        assert.equal(await prisma.upload.findUnique({ where: { id: saved.id } }), null);
        await assert.rejects(readObject(removed.storageKey));
        // Free data expires three calendar months after trial end; paid legacy data is protected.
        const free = await org(), fp = await project(free.id), fu = await user(free.id);
        const contact = { subscription: createOneMonthTrial(new Date('2025-01-01')) };
        await prisma.tenant.update({ where: { id: free.id }, data: { contact } });
        const key = `${free.id}/backup.pdf`; await storeObject({ storageKey: key, buffer: Buffer.from('backup'), contentType: 'application/pdf' });
        await prisma.upload.create({ data: document(free.id, fp.id, fu.id, { storageKey: key }) });
        await cleanupRetainedDocuments(new Date('2025-04-30')); await readObject(key);
        await cleanupRetainedDocuments(new Date('2025-05-01'));
        assert.equal((await tenantQuota(free.id)).documents.used, 0); await assert.rejects(readObject(key));
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
    await t.test('calendar billing clamps month ends, preserves prepaid time, and cleanup excludes legacy paid subscriptions', async () => {
      const trial = { subscription: createOneMonthTrial(new Date('2026-01-31T12:00:00Z')) };
      assert.equal(freeDocumentsPurgeAt(trial).toISOString(), '2026-05-28T12:00:00.000Z');
      const paid = renewTenantSubscription(trial, new Date('2026-01-31T12:00:00Z'), { package: 'starter', billing_cycle: 'monthly' });
      assert.equal(paid.subscription.current_period_end_at, '2026-02-28T12:00:00.000Z');
      assert.equal(evaluateSubscription(paid.contact, new Date('2026-02-01')).status, 'active');
      const upgrade = renewTenantSubscription(paid.contact, new Date('2026-02-01'), { package: 'business', billing_cycle: 'yearly' });
      assert.equal(upgrade.subscription.current_period_end_at, '2027-02-28T12:00:00.000Z');
      assert.equal(freeDocumentsPurgeAt({ subscription: { ...trial.subscription, package: undefined, current_period_end_at: '2027-01-01' } }), null);
    });
  } finally {
    await prisma.tenant.deleteMany({ where: { id: { in: orgs } } });
    await prisma.$disconnect();
    await (await import('node:fs/promises')).rm(process.env.UPLOAD_LOCAL_DIR, { recursive: true, force: true });
  }
});
