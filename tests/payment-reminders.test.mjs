import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../dist/core/prisma/client.js';
import { paymentRemindersRouter } from '../dist/modules/payment-reminders/reminders.routes.js';
import { planRule, renderMessage, ruleSchema, DEFAULT_RULES, DEFAULT_SETTINGS, totalSends, relativeLabel } from '../dist/modules/payment-reminders/reminders.policy.js';
import { runPaymentReminders, candidatesFor, combinedMessage } from '../dist/modules/payment-reminders/reminders.service.js';
import { routeMenuKeys } from '../dist/core/security/menu-access.policy.js';

const satThu = { sendingDays: [6, 0, 1, 2, 3, 4], treatHolidays: true, offDayRule: 'before' };
const rule = (over = {}) => ({ kind: 'after', days: 3, ownTime: null, repeatEvery: 3, repeatCount: 5, message: 'x', enabled: true, ...over });

test('the design example: +3d every 3 days, 5 sends, Friday off moves Fri 13 back to Thu 12', () => {
  assert.deepEqual(planRule(rule(), '2026-11-10', satThu).map(s => [s.date, s.movedFrom]), [['2026-11-12', '2026-11-13'], ['2026-11-16', null], ['2026-11-19', null], ['2026-11-22', null], ['2026-11-25', null]]);
});

test('off-day handling never makes a before or due-date reminder late, and never pulls an overdue one back before the deadline', () => {
  // Due date itself on a Friday with "next sending day": Saturday would be late, so it falls back to Thursday.
  assert.deepEqual(planRule(rule({ kind: 'due', days: 0, repeatEvery: null, repeatCount: null }), '2026-11-13', { ...satThu, offDayRule: 'after' }).map(s => s.date), ['2026-11-12']);
  // +1d on a Friday with "day before" would land on the due date; it moves forward instead.
  assert.deepEqual(planRule(rule({ days: 1, repeatEvery: null, repeatCount: null }), '2026-11-12', satThu).map(s => s.date), ['2026-11-14']);
  assert.deepEqual(planRule(rule({ kind: 'before', days: 1, repeatEvery: null, repeatCount: null }), '2026-11-14', { ...satThu, offDayRule: 'skip' }), []);
  // Victory Day (Wed 16 Dec 2026) is a public holiday.
  assert.deepEqual(planRule(rule({ kind: 'before', days: 3, repeatEvery: null, repeatCount: null }), '2026-12-19', satThu).map(s => s.date), ['2026-12-15']);
  assert.deepEqual(planRule(rule({ kind: 'before', days: 3, repeatEvery: null, repeatCount: null }), '2026-12-19', { ...satThu, treatHolidays: false }).map(s => s.date), ['2026-12-16']);
});

test('messages fill every placeholder in the member’s words and the defaults stay within ten sends', () => {
  assert.equal(renderMessage('Hi {name}, your {amount} for {schedule} was due on {due_date} and is now {days} late. Please pay as soon as you can.', { name: 'Rahim Uddin', amount: 12000, schedule: 'Installment 14', dueDate: '2026-11-10', sendDate: '2026-11-13' }),
    'Hi Rahim, your ৳12,000 for Installment 14 was due on Tue 10 Nov and is now 3 days late. Please pay as soon as you can.');
  assert.equal(totalSends(DEFAULT_RULES), 10);
  assert.equal(relativeLabel('2026-11-10', '2026-11-03'), '7 days before');
  assert.equal(relativeLabel('2026-10-25', '2026-11-03'), '9 days late');
  assert.equal(ruleSchema.safeParse({ kind: 'after', days: 3, message: 'Pay {amout}' }).success, false);
  assert.equal(ruleSchema.safeParse({ kind: 'before', days: 3, repeat_every: 3, repeat_count: 5, message: 'x' }).success, false);
  assert.equal(ruleSchema.safeParse({ kind: 'after', days: 3, repeat_every: 3, repeat_count: 5, message: 'x' }).success, true);
});

test('several deadlines on one day become one message led by the earliest', () => {
  const items = [{ recipientId: 'm', recipientName: 'Rahim Uddin', groupKey: 's13', groupName: 'Installment 13', dueDate: '2026-10-25', amount: 5000 }, { recipientId: 'm', recipientName: 'Rahim Uddin', groupKey: 's14', groupName: 'Installment 14', dueDate: '2026-11-10', amount: 12000 }];
  const rules = [rule({ days: 9, repeatEvery: null, repeatCount: null, message: '{schedule} {days} late' }), rule({ kind: 'before', days: 7, repeatEvery: null, repeatCount: null, message: '{schedule} in {days}' })];
  const found = candidatesFor(items, rules, DEFAULT_SETTINGS, '2026-11-03');
  assert.equal(found.length, 2);
  assert.equal(combinedMessage(found).body, 'Installment 13 9 days late You also have 1 other unpaid due; ৳17,000 in total.');
});

test('custom roles reach this screen only through the Payment reminders menu', () => {
  assert.deepEqual(routeMenuKeys('/v1/payment-reminders', 'GET'), ['payment_reminders']);
  assert.deepEqual(routeMenuKeys('/v1/payment-reminders/rules/r1', 'PUT'), ['payment_reminders']);
});

// ---------------------------------------------------------------- engine + routes with an in-memory store
let state;
const unique = () => new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '5.22.0' });
function reset(projectType = 'fund_shares') {
  state = { projectType, settings: null, rules: [], reminders: [], notified: [], messages: [], activity: [], promises: [], dues: [], invoices: [] };
}
before(() => {
  reset();
  prisma.project.findFirst = async () => ({ id: 'project', name: 'Oshtok 08', projectType: state.projectType });
  prisma.paymentReminderSettings.findUnique = async () => state.settings;
  prisma.paymentReminderSettings.findUniqueOrThrow = async () => state.settings;
  prisma.paymentReminderSettings.findMany = async ({ where }) => state.settings && state.settings.enabled === where.enabled ? [{ ...state.settings, project: { name: 'Oshtok 08', projectType: state.projectType, deletionStartedAt: null } }] : [];
  prisma.paymentReminderSettings.update = async ({ data }) => Object.assign(state.settings, data);
  prisma.$transaction = async fn => fn({
    paymentReminderSettings: { create: async ({ data }) => (state.settings = { createdAt: new Date(), updatedAt: new Date(), updatedById: null, ...data }) },
    paymentReminderRule: { createMany: async ({ data }) => { data.forEach((row, i) => state.rules.push({ id: `r${i + 1}`, ...row })); return { count: data.length }; } },
  });
  prisma.paymentReminderRule.findMany = async () => state.rules;
  prisma.paymentReminderRule.findFirst = async ({ where }) => state.rules.find(r => r.id === where.id) ?? null;
  prisma.paymentReminderRule.create = async ({ data }) => { if (state.rules.some(r => r.kind === data.kind && r.days === data.days)) throw unique(); const row = { id: `r${state.rules.length + 10}`, ...data }; state.rules.push(row); return row; };
  prisma.paymentReminderRule.update = async ({ where, data }) => Object.assign(state.rules.find(r => r.id === where.id), data);
  prisma.paymentReminderRule.delete = async ({ where }) => { state.rules = state.rules.filter(r => r.id !== where.id); };
  prisma.due.findMany = async () => state.dues;
  prisma.billingInvoice.findMany = async () => state.invoices;
  prisma.memberReminder.findMany = async ({ where }) => state.reminders.filter(r => where.memberId.in.includes(r.memberId) && r.reminderDate.getTime() === where.reminderDate.getTime());
  prisma.memberReminder.create = async ({ data }) => { if (state.reminders.some(r => r.memberId === data.memberId && r.reminderDate.getTime() === data.reminderDate.getTime())) throw unique(); const row = { id: `m${state.reminders.length}`, ...data }; state.reminders.push(row); return row; };
  prisma.memberReminder.update = async ({ where, data }) => Object.assign(state.reminders.find(r => r.id === where.id), data);
  prisma.paymentCommitment.findMany = async ({ where }) => state.promises.filter(p => where.memberId.in.includes(p.memberId));
  prisma.projectMembership.findMany = async ({ where }) => { state.notified.push(where.memberId.in[0]); return []; };
  prisma.billingMessage.create = async ({ data }) => { if (state.messages.some(m => m.dedupeKey === data.dedupeKey)) throw unique(); state.messages.push(data); return data; };
  prisma.activity.create = async ({ data }) => { state.activity.push(data); return data; };
});
beforeEach(() => reset());
const due = (memberId, name, schedule, dueDate, amount = 12000) => ({ memberId, scheduleId: schedule, amount, paidAmount: 0, waivedAmount: 0, penaltyDue: 0, penaltyPaid: 0, dueDate: new Date(`${dueDate}T00:00:00Z`), schedule: { name: schedule }, member: { name } });
// Tue 3 Nov 2026, 10:30 in Dhaka.
const tuesday = new Date('2026-11-03T04:30:00Z');

test('automatic sends reach each member once a day, respect manual reminders and open promises, and wait for the send time', async () => {
  let server; const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.auth = { tenantId: 'tenant', projectId: 'project', userId: 'admin', memberId: null, roles: [req.header('x-role') ?? 'admin'] }; next(); }); app.use('/v1', paymentRemindersRouter); app.use((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({ error: { code: error.code, message: error.message } }));
  await new Promise(resolve => { server = app.listen(0, resolve); });
  const url = `http://127.0.0.1:${server.address().port}/v1/payment-reminders`;
  try {
    const first = await (await fetch(url)).json();
    assert.equal(first.data.first_time, true); assert.equal(first.data.settings.enabled, false); assert.equal(first.data.rules.length, 6); assert.equal(first.data.sends_per_due, 10);
    state.dues = [due('a', 'Rahim Uddin', 'Installment 14', '2026-11-10'), due('b', 'Karim', 'Installment 14', '2026-11-10'), due('c', 'Salma', 'Installment 13', '2026-10-31'), due('d', 'Nadia', 'Installment 13', '2026-10-31')];
    // Nothing is sent while switched off.
    assert.equal((await runPaymentReminders(tuesday)).sent, 0);
    assert.equal((await fetch(`${url}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-role': 'accountant' }, body: JSON.stringify({ enabled: true }) })).status, 403);
    const on = await (await fetch(`${url}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).json();
    assert.equal(on.data.settings.enabled, true);
    // b was already reminded by hand today; d promised to pay later, so its overdue (+3d) reminder waits.
    state.reminders.push({ id: 'manual', memberId: 'b', reminderDate: new Date('2026-11-03T00:00:00Z'), source: 'manual' });
    state.promises.push({ memberId: 'd' });
    assert.equal((await runPaymentReminders(new Date('2026-11-03T03:30:00Z'))).sent, 0, 'not before 10:00');
    const run = await runPaymentReminders(tuesday);
    assert.deepEqual(state.notified.sort(), ['a', 'c']);
    assert.equal(run.sent, 2);
    assert.ok(state.reminders.filter(r => r.source === 'automatic').every(r => ['a', 'c'].includes(r.memberId)));
    assert.equal((await runPaymentReminders(new Date('2026-11-03T05:00:00Z'))).sent, 0, 'the 10:00 slot runs once');
    // Over ten sends per due is refused; a duplicate day is a conflict.
    const tooMany = await fetch(`${url}/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'after', days: 10, message: 'Late' }) });
    assert.equal(tooMany.status, 400);
    const duplicate = await fetch(`${url}/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'after', days: 1, message: 'Late', enabled: false }) });
    assert.equal(duplicate.status, 409);
    const preview = await (await fetch(`${url}/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'after', days: 3, repeat_every: 3, repeat_count: 5, message: 'Hi {name}, {days} late' }) })).json();
    assert.match(preview.data.message, /^Hi (Rahim|Karim|Salma|Nadia), \d+ days? late$/); assert.equal(preview.data.time, '10:00');
  } finally { server.close(); }
});

test('billing projects queue one email a day per customer with an address', async () => {
  reset('billing');
  state.settings = { projectId: 'billing-project', tenantId: 'tenant', enabled: true, preferredTime: '10:00', sendingDays: [0, 1, 2, 3, 4, 6], offDayRule: 'before', treatHolidays: true, pauseForPromises: true, updatedById: 'admin' };
  state.rules = DEFAULT_RULES.map((r, i) => ({ id: `r${i}`, ...r }));
  const invoice = (customerId, email, number, dueDate) => ({ id: number, customerId, number, status: 'issued', total: 1500, discount: 0, tax: 0, paidAmount: 0, creditAmount: 0, debitAmount: 0, lateFeeAmount: 0, dueDate: new Date(`${dueDate}T00:00:00Z`), customer: { id: customerId, name: 'Customer', email, isActive: true } });
  state.invoices = [invoice('c1', 'one@example.com', 'INV-1', '2026-11-10'), invoice('c1', 'one@example.com', 'INV-2', '2026-11-10'), invoice('c2', null, 'INV-3', '2026-11-10')];
  await runPaymentReminders(tuesday);
  assert.equal(state.messages.length, 1); assert.equal(state.messages[0].dedupeKey, 'auto-reminder:c1:2026-11-03'); assert.match(state.messages[0].body, /1 other unpaid due/);
});

after(() => {});
