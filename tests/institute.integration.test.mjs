import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const testUrl = process.env.INSTITUTE_TEST_DATABASE_URL;
test('institute PostgreSQL isolation, concurrency and rollback', { skip: !testUrl && 'Set INSTITUTE_TEST_DATABASE_URL to a migrated disposable institute_test database.' }, async t => {
  const parsed = new URL(testUrl);
  assert.equal(decodeURIComponent(parsed.pathname), '/institute_test', 'Refusing to use any database other than institute_test');
  process.env.DATABASE_URL = testUrl;
  process.env.JWT_SECRET = 'institute-test-only-not-a-production-secret';
  process.env.INSTITUTE_ENABLED = 'true';
  const { prisma } = await import('../dist/core/prisma/client.js');
  const { instituteRouter } = await import('../dist/modules/institute/institute.routes.js');
  const { settings } = await import('../dist/modules/institute/institute.policy.js');
  const tenant = await prisma.tenant.create({ data: { name: 'Disposable institute fixture', slug: `institute-test-${randomUUID()}` } });
  const owner = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Test owner', mobile: `test:${randomUUID()}` } });
  const project = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Disposable school', totalShares: 1, projectType: 'institute', instituteSettings: settings(null) } });
  const scope = { tenantId: tenant.id, projectId: project.id };
  await prisma.projectMembership.create({ data: { ...scope, userId: owner.id, role: 'owner' } });
  t.after(async () => {
    for (const table of ['instituteDocument','instituteNotificationDelivery','instituteWriteReceipt','instituteResultPublication','instituteMark','instituteMarkSheet','instituteExam','institutePostRecipient','institutePost','instituteFeeReceipt','instituteFeePayment','instituteFeeInvoice','instituteFeePlan','instituteAttendanceMark','instituteAttendanceSheet','instituteLeaveRequest','instituteRoutineSlot','instituteTeacherAssignment','instituteGuardianLink','instituteStudent','instituteSubject','instituteGroup']) await prisma[table].deleteMany({ where: scope });
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
    await prisma.$disconnect();
  });
  const group = await prisma.instituteGroup.create({ data: { ...scope, name: 'Class 8', academicYear: '2026' } });
  const student = await prisma.instituteStudent.create({ data: { ...scope, name: 'Test student', rollNo: '1', groupId: group.id, joinedOn: new Date('2026-01-01') } });
  const account = await prisma.account.create({ data: { ...scope, name: 'Test cash', type: 'cash', isDefault: true } });
  const plan = await prisma.instituteFeePlan.create({ data: { ...scope, name: 'Tuition', amount: 1000, cycle: 'monthly', dueDay: 10 } });
  const invoice = await prisma.instituteFeeInvoice.create({ data: { ...scope, studentId: student.id, planId: plan.id, period: '2026-10', amount: 1000, dueOn: new Date('2026-10-10') } });
  const payment = await prisma.instituteFeePayment.create({ data: { ...scope, studentId: student.id, invoiceIds: [invoice.id], amount: 1000, method: 'cash', submittedBy: owner.id } });
  const call = (method, route, body, params = {}, key = randomUUID(), auth = {}) => new Promise((resolve, reject) => {
    const layer = instituteRouter.stack.find(l => l.route?.path === route && l.route.methods[method]);
    assert.ok(layer, route);
    const req = { method: method.toUpperCase(), path: route.replace(/:([A-Za-z]+)/g, (_, name) => params[name]), body, params, query: { portal: 'office' }, header: name => name.toLowerCase() === 'idempotency-key' ? key : undefined,
      auth: { ...scope, userId: owner.id, sessionId: 'test-session', roles: ['owner'], builtinRoles: ['owner'], memberId: null, ...auth } };
    layer.route.stack.at(-1).handle(req, { json: value => resolve(value.data) }, reject);
  });
  await t.test('two devices verifying one payment create one receipt and ledger entry', async () => {
    const values = await Promise.all([call('post','/fee-payments/:id/verify',{revision:0},{id:payment.id}),call('post','/fee-payments/:id/verify',{revision:0},{id:payment.id})]);
    assert.equal(values[0].receipt_id, values[1].receipt_id);
    assert.equal(await prisma.instituteFeeReceipt.count({ where: { ...scope, paymentId: payment.id } }), 1);
    assert.equal(await prisma.accountTransaction.count({ where: { ...scope, referenceType: 'institute_fee_payment', referenceId: payment.id } }), 1);
    assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).balance, 1000);
  });
  await t.test('two attendance saves at the same revision yield one success and one conflict', async () => {
    const input = { group_id: group.id, date: '2026-10-26', session: 1, revision: 0, notify_absent: false, marks: [{ student_id: student.id, status: 'present' }] };
    const values = await Promise.allSettled([call('put','/attendance/sheets',input),call('put','/attendance/sheets',{...input,marks:[{student_id:student.id,status:'late'}]})]);
    assert.equal(values.filter(v => v.status === 'fulfilled').length, 1);
    assert.equal(values.find(v => v.status === 'rejected').reason.code, 'REVISION_CONFLICT');
    assert.equal(await prisma.instituteAttendanceSheet.count({ where: { ...scope, groupId: group.id } }), 1);
  });
  await t.test('a replayed idempotency key returns the same aggregate', async () => {
    const key = randomUUID(), input = { name: 'Class 9', academic_year: '2026' };
    const first = await call('post','/groups',input,{},key), second = await call('post','/groups',input,{},key);
    assert.deepEqual(first, second);
    assert.equal(await prisma.instituteGroup.count({ where: { ...scope, name: input.name } }), 1);
  });
  await t.test('a failure after invoice and receipt writes rolls the entire verification back', async () => {
    const invoice2 = await prisma.instituteFeeInvoice.create({ data: { ...scope, studentId: student.id, planId: plan.id, period: '2026-11', amount: 1000, dueOn: new Date('2026-11-10') } });
    const payment2 = await prisma.instituteFeePayment.create({ data: { ...scope, studentId: student.id, invoiceIds: [invoice2.id], amount: 1000, method: 'cash', submittedBy: owner.id } });
    await prisma.account.update({ where: { id: account.id }, data: { balance: 2147483640 } });
    await assert.rejects(() => call('post','/fee-payments/:id/verify',{revision:0},{id:payment2.id}));
    assert.equal((await prisma.instituteFeeInvoice.findUniqueOrThrow({ where: { id: invoice2.id } })).paidAmount, 0);
    assert.equal((await prisma.instituteFeePayment.findUniqueOrThrow({ where: { id: payment2.id } })).status, 'submitted');
    assert.equal(await prisma.instituteFeeReceipt.count({ where: { ...scope, paymentId: payment2.id } }), 0);
  });
});
