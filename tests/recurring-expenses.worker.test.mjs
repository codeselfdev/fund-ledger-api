import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { prisma } from '../dist/core/prisma/client.js';
import { queueNotification, runRecurringExpenses } from '../dist/modules/expenses/recurring-expenses.service.js';
after(async () => { await prisma.$disconnect(); });
test('automatic creation notifies the creator as well as the approval audience without duplicates', async () => {
  const members = [{ userId: 'creator', role: 'accountant' }, { userId: 'reviewer', role: 'approver' }, { userId: 'reviewer', role: 'admin' }, { userId: 'unrelated-member', role: 'member' }];
  let saved;
  const tx = { onboardingProgress: { findUnique: async () => ({ expenseApprovalFlow: 'accountant_and_approver' }) },
    projectMembership: { findMany: async ({ where }) => members.filter(member => where.OR.some(filter => filter.userId === member.userId || filter.role?.in.includes(member.role))) },
    notification: { createMany: async ({ data }) => { saved = data; } } };
  const bill = { id: 'bill', tenantId: 'tenant', projectId: 'project', name: 'Rent', createdById: 'creator', nextDue: new Date('2026-10-21'), mode: 'auto' };
  const result = await queueNotification(tx, bill, 'expense.submitted', 'expense');
  assert.deepEqual(result.recipientUserIds, ['creator', 'reviewer']); assert.equal(saved.length, 2); assert.ok(saved.every(row => row.entityId === 'expense' && row.type === 'expense.submitted'));
  await queueNotification(tx, { ...bill, mode: 'remind' }, 'expense.submitted', 'manual');
  assert.deepEqual(saved.map(row => row.recipientUserId), ['reviewer']);
});
test('a page of inaccessible projects does not prevent later projects from being examined', async () => {
  const calls = [], checked = [];
  prisma.recurringExpenseBill.findMany = async options => { calls.push(options); return calls.length === 1 ? Array.from({ length: 500 }, (_, i) => ({ id: `bill-${String(i).padStart(3, '0')}`, projectId: 'inactive', tenantId: 'tenant' })) : [{ id: 'later-active-project', projectId: 'later', tenantId: 'tenant' }]; };
  prisma.project.findFirst = async ({ where }) => { checked.push(where.id); return null; };
  await runRecurringExpenses(new Date('2026-10-21T06:00:00Z'));
  assert.equal(checked.length, 501); assert.equal(checked.at(-1), 'later'); assert.equal(calls.length, 2);
});
