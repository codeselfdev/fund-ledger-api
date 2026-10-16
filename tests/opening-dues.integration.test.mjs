import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../dist/core/prisma/client.js';
import { createApp } from '../dist/app.js';
import { signAccessToken, hashToken } from '../dist/core/security/jwt.js';

test('isolated PostgreSQL: 54 imported share rows, 16 opening debtors, and independently settled installments',
  { skip: process.env.RUN_OPENING_DUES_INTEGRATION !== 'true' }, async t => {
  const db = new URL(process.env.DATABASE_URL);
  assert.equal(db.hostname, '127.0.0.1');
  assert.equal(db.pathname, '/fundnesta_opening_verify', 'Only the disposable database is permitted');
  const tenant = await prisma.tenant.create({ data: { name: 'Synthetic opening-dues test', slug: `opening-${randomUUID()}`,
    contact: { subscription: { status: 'active', package: 'business', billing_cycle: 'monthly', current_period_end_at: new Date(Date.now() + 30 * 86400000).toISOString() } } } });
  const owner = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Synthetic owner', mobile: '+8801711999999' } });
  const project = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Synthetic fund', totalShares: 54, portalSettings: { deposit_review: 'admin_only' } } });
  await prisma.projectMembership.create({ data: { tenantId: tenant.id, projectId: project.id, userId: owner.id, role: 'owner' } });
  const account = await prisma.account.create({ data: { tenantId: tenant.id, projectId: project.id, name: 'Synthetic cash', type: 'cash', balance: 0 } });
  async function authToken(user, projectId) {
    const id = randomUUID(), token = signAccessToken({ tenantId: tenant.id, userId: user.id, sessionId: id });
    await prisma.session.create({ data: { id, tenantId: tenant.id, userId: user.id, activeProjectId: projectId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 86400000) } });
    return token;
  }
  const token = await authToken(owner, project.id);
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  async function request(path, method = 'GET', body, bearer = token, projectId = project.id) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${bearer}`, 'x-project-id': projectId, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json();
    return { status: response.status, ...json };
  }
  const arrears = { 6: 336000, 8: 159000, 17: 346000, 18: 159000, 22: 279000, 23: 178000, 24: 11000, 26: 411000, 27: 761000, 33: 211000, 40: 956000, 42: 21000, 43: 229000, 48: 571000, 49: 341000, 53: 31000 };
  const rows = Array.from({ length: 54 }, (_, i) => {
    const serial = i + 1, previousDue = arrears[serial] ?? 0, previousPaid = 2131000 - previousDue;
    const currentPaid = ({ 20: 1000, 44: 31000, 45: 133000 })[serial] ?? 0;
    return { serial: String(serial), mid: `MID-${serial}`, name: `Synthetic member ${serial}`, mobile: `+8801711${String(serial === 8 ? 6 : serial).padStart(6, '0')}`,
      email: '', shares: 1, previous_due_amount: previousDue, current_installment_amount: 133000,
      total_due_amount: previousDue + 133000 - currentPaid, previous_paid_amount: previousPaid, total_paid_amount: previousPaid + currentPaid, comment: '' };
  });
  const input = { request_id: randomUUID(), installment_name: '23rd installment', as_of_date: '2025-10-16', rows };
  let openingId, currentId, memberId, oldPaid;
  try {
    await t.test('actual import creates separate share rows, correct opening/current totals, and no bank credit for old paid history', async () => {
      const preview = await request('/members/import-fund/preview', 'POST', input);
      assert.equal(preview.status, 200, JSON.stringify(preview));
      const imported = await request('/members/import-fund', 'POST', { ...input, review_token: preview.data.review_token, confirm: true });
      assert.equal(imported.status, 201, JSON.stringify(imported));
      currentId = imported.data.current_schedule_id;
      const listed = await request('/schedules?include_system=true');
      assert.equal(listed.status, 200, JSON.stringify(listed));
      const opening = listed.data.find(row => row.purpose === 'previous_installment');
      openingId = opening.id;
      assert.deepEqual(opening.collection, { total: 5000000, collected: 0, remaining: 5000000, pending: 0, waived: 0, dues_count: 16, paid_count: 0, collected_percent: 0 });
      assert.equal(opening.opening_balance.historical_paid, 110074000);
      assert.equal(opening.opening_balance.as_of_date, '2025-10-16');
      const current = listed.data.find(row => row.id === currentId);
      assert.equal(current.collection.total, 7182000);
      assert.equal(current.collection.collected, 165000);
      assert.equal(current.collection.remaining, 7017000);
      assert.equal(current.collection.paid_count, 1);
      const detail = await request(`/schedules/${openingId}/member-summary`);
      assert.equal(detail.status, 200, JSON.stringify(detail));
      assert.equal(detail.data.items.length, 16);
      assert.equal(new Set(detail.data.items.map(row => row.member.id)).size, 16);
      assert.equal(detail.data.items.filter(row => row.member.mobile === rows[5].mobile).length, 2);
      assert.ok(detail.data.items.every(row => row.opening_balance.recovered === 0));
      const debtor = detail.data.items.find(row => row.member.mid === 'MID-6');
      memberId = debtor.member.id; oldPaid = debtor.due.paidAmount;
      assert.equal(debtor.due.outstanding, 336000);
      assert.equal((await prisma.account.findUnique({ where: { id: account.id } })).balance, 0);
      assert.equal(await prisma.deposit.count({ where: { projectId: project.id } }), 0);
    });

    let paymentId;
    async function submit(amount, scheduleId) {
      const result = await request('/deposits', 'POST', { member_id: memberId, schedule_ids: [scheduleId], account_id: account.id, amount, method: 'cash', allocate: 'penalty_first' });
      assert.equal(result.status, 201, JSON.stringify(result)); return result.data.id;
    }
    async function summary(id) {
      const response = await request(`/schedules/${id}/member-summary`);
      assert.equal(response.status, 200, JSON.stringify(response)); return response.data;
    }
    async function confirm(id) {
      const result = await request(`/deposits/${id}/confirm`, 'POST', {});
      assert.equal(result.status, 200, JSON.stringify(result));
    }
    await t.test('pending opening payment stays separate and cannot reduce the confirmed remaining balance', async () => {
      paymentId = await submit(100000, openingId);
      const opening = await summary(openingId), member = opening.items.find(row => row.member.id === memberId);
      assert.equal(opening.collection.remaining, 5000000);
      assert.equal(opening.collection.collected, 0);
      assert.equal(opening.collection.pending, 100000);
      assert.equal(member.pending_amount, 100000);
      assert.equal(member.due.outstanding, 336000);
      assert.equal(member.payment_state, 'pending');
      assert.equal((await summary(currentId)).collection.remaining, 7017000);
    });
    await t.test('confirmed partial and final opening payments clear that debtor and preserve the other 15 plus current dues', async () => {
      await confirm(paymentId);
      let opening = await summary(openingId), member = opening.items.find(row => row.member.id === memberId);
      assert.equal(opening.collection.remaining, 4900000);
      assert.equal(opening.collection.pending, 0);
      assert.equal(member.opening_balance.recovered, 100000);
      assert.equal(member.due.outstanding, 236000);
      const rest = await submit(236000, openingId); await confirm(rest);
      opening = await summary(openingId); member = opening.items.find(row => row.member.id === memberId);
      assert.equal(opening.collection.remaining, 4664000);
      assert.equal(opening.collection.collected, 336000);
      assert.equal(opening.collection.paid_count, 1);
      assert.equal(opening.items.filter(row => row.due.outstanding > 0).length, 15);
      assert.equal(opening.items.length, 16);
      assert.equal(member.payment_state, 'paid');
      assert.equal(member.due.paidAmount, oldPaid + 336000);
      assert.equal(member.opening_balance.historical_paid, oldPaid);
      assert.equal((await summary(currentId)).collection.remaining, 7017000);
    });
    await t.test('current installment payment clears only its balance and posts only new cash once', async () => {
      const id = await submit(133000, currentId); await confirm(id);
      const current = await summary(currentId);
      assert.equal(current.collection.remaining, 6884000);
      assert.equal(current.collection.paid_count, 2);
      assert.equal(current.items.find(row => row.member.id === memberId).due.outstanding, 0);
      assert.equal((await summary(openingId)).collection.remaining, 4664000);
      assert.equal((await prisma.account.findUnique({ where: { id: account.id } })).balance, 469000);
      assert.equal(await prisma.receipt.count({ where: { projectId: project.id } }), 3);
      assert.equal((await request(`/deposits/${id}/confirm`, 'POST', {})).status, 400);
      assert.equal((await prisma.account.findUnique({ where: { id: account.id } })).balance, 469000);
    });
    await t.test('owners and admins who are also shareholders can create income, expense, due deposit and advance without receipt attachments', async () => {
      for (const [index, role] of ['owner', 'admin'].entries()) {
        const staff = await prisma.user.create({ data: { tenantId: tenant.id, name: `Synthetic ${role} shareholder`, mobile: `+880171199999${index}` } });
        const share = await prisma.member.create({ data: { tenantId: tenant.id, projectId: project.id, userId: staff.id, name: staff.name, mobile: staff.mobile, shares: 0 } });
        await prisma.projectMembership.createMany({ data: [role, 'member'].map(r => ({ tenantId: tenant.id, projectId: project.id, userId: staff.id, role: r, ...(r === 'member' ? { memberId: share.id } : {}) })) });
        const staffToken = await authToken(staff, project.id);
        assert.equal((await request('/incomes', 'POST', { account_id: account.id, amount: 1000, source: 'Synthetic no-receipt income' }, staffToken)).status, 201);
        const expense = await request('/expenses', 'POST', { account_id: account.id, amount: 500, title: 'Synthetic no-receipt expense', category: 'services' }, staffToken);
        assert.equal(expense.status, 201, JSON.stringify(expense));
        const debtor = (await summary(openingId)).items.find(row => row.due.outstanding > 0);
        const deposit = await request('/deposits', 'POST', { member_id: debtor.member.id, schedule_ids: [openingId], account_id: account.id, amount: 100, method: 'cash' }, staffToken);
        assert.equal(deposit.status, 201, JSON.stringify(deposit));
        const advance = await request('/deposits/advance', 'POST', { member_id: debtor.member.id, account_id: account.id, amount: 100, method: 'cash' }, staffToken);
        assert.equal(advance.status, 201, JSON.stringify(advance));
        assert.equal((await prisma.deposit.findUnique({ where: { id: deposit.data.id } })).proofFileId, null);
        assert.equal((await prisma.deposit.findUnique({ where: { id: advance.data.id } })).proofFileId, null);
        assert.equal((await prisma.expense.findUnique({ where: { id: expense.data.id } })).docFileId, null);
      }
    });
    await t.test('members can read opening dues; their own receipt requirement and project boundaries remain enforced', async () => {
      const member = await prisma.member.findUnique({ where: { id: memberId }, include: { user: true } });
      const memberToken = await authToken(member.user, project.id);
      const detail = await request(`/schedules/${openingId}/member-summary`, 'GET', undefined, memberToken);
      assert.equal(detail.status, 200); assert.equal(detail.data.items.length, 16);
      assert.ok(detail.data.items.every(row => row.member.mobile === '' && row.pending_deposit_ids.length === 0));
      const another = detail.data.items.find(row => row.member.id !== memberId);
      assert.equal((await request('/deposits', 'POST', { member_id: another.member.id, schedule_ids: [openingId], account_id: account.id, amount: 1, method: 'cash' }, memberToken)).status, 403);
      for (const path of ['/deposits', '/deposits/advance']) {
        const own = await request(path, 'POST', { member_id: memberId, schedule_ids: [currentId], account_id: account.id, amount: 1, method: 'cash' }, memberToken);
        assert.equal(own.status, 400); assert.match(own.error.message ?? own.error, /upload a receipt/);
      }
      const foreign = await prisma.project.create({ data: { tenantId: tenant.id, name: 'Separate project', totalShares: 1 } });
      await prisma.projectMembership.create({ data: { tenantId: tenant.id, projectId: foreign.id, userId: owner.id, role: 'owner' } });
      assert.equal((await request(`/schedules/${openingId}/member-summary`, 'GET', undefined, token, foreign.id)).status, 404);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await prisma.$disconnect();
  }
});
