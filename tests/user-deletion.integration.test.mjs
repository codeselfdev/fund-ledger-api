import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import express from 'express';

// Explicit opt-in: use only a disposable PostgreSQL database with migrations applied.
const url = process.env.USER_DELETION_TEST_DATABASE_URL;
test('deleting one user preserves shared history and unrelated users', { skip: !url }, async () => {
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'isolated-user-deletion-regression-secret';
  process.env.WHATSAPP_ENABLED = 'false';
  const db = new PrismaClient({ datasources: { db: { url } } });
  const id = `user-deletion-test-${randomUUID()}`;
  let tenant, server, sharedDb;
  try {
    tenant = await db.tenant.create({ data: { name: id, slug: id } });
    const scope = { tenantId: tenant.id };
    const project = await db.project.create({ data: { ...scope, name: 'History', totalShares: 10 } });
    scope.projectId = project.id;
    const author = await db.user.create({ data: { tenantId: tenant.id, name: 'Former staff', mobile: 'author' } });
    const other = await db.user.create({ data: { tenantId: tenant.id, name: 'Current staff', mobile: 'other' } });
    const voter = await db.user.create({ data: { tenantId: tenant.id, name: 'Pending voter', mobile: 'voter' } });
    const member = await db.member.create({ data: { ...scope, name: 'Member', mobile: 'member', shares: 1, userId: author.id } });
    const membership = await db.projectMembership.create({ data: { ...scope, userId: author.id, memberId: member.id, role: 'admin' } });
    await db.projectMembership.create({ data: { ...scope, userId: other.id, role: 'admin' } });
    await db.projectMembership.create({ data: { ...scope, userId: voter.id, role: 'member', memberId: member.id } });
    const upcoming = new Date(Date.now() + 30 * 60000);
    const event = await db.projectEvent.create({ data: { ...scope, createdById: author.id, title: 'Meeting', agenda: 'Keep this agenda', place: 'Office', startsAt: upcoming } });
    const unrelated = await db.projectEvent.create({ data: { ...scope, createdById: other.id, title: 'Other meeting', agenda: 'Unchanged', place: 'Office', startsAt: new Date() } });
    const poll = await db.poll.create({ data: { ...scope, createdById: author.id, title: 'Vote', expiresAt: upcoming, createdAt: new Date(Date.now() - 3 * 3600000) } });
    const option = await db.pollOption.create({ data: { ...scope, pollId: poll.id, label: 'Yes', position: 0 } });
    await db.pollVote.create({ data: { ...scope, pollId: poll.id, optionId: option.id, userId: other.id } });
    const notice = await db.projectNotice.create({ data: { ...scope, createdById: author.id, title: 'Notice', body: 'Keep this notice', expiresAt: upcoming } });
    const log = await db.memberCallLog.create({ data: { ...scope, memberId: member.id, createdById: author.id, outcome: 'committed', summary: 'Keep this note' } });
    const commitment = await db.paymentCommitment.create({ data: { ...scope, memberId: member.id, callLogId: log.id, createdById: author.id, amount: 100, promisedDate: new Date(), summary: 'Keep this promise', outstandingAtCreate: 100 } });
    const reminder = await db.memberReminder.create({ data: { ...scope, memberId: member.id, sentById: author.id, reminderDate: new Date(), outstanding: 100, deliveredCount: 1 } });
    const account = await db.account.create({ data: { ...scope, name:'Cash', type:'cash', balance:500 } });
    const transaction = await db.accountTransaction.create({ data: { ...scope, accountId:account.id, direction:'money_in', amount:500, balanceAfter:500, createdById:author.id } });
    const schedule = await db.schedule.create({ data: { ...scope, name:'Contribution', totalAmount:100, dueDate:upcoming, createdById:author.id } });
    const due = await db.due.create({ data: { ...scope, scheduleId:schedule.id, memberId:member.id, amount:100, dueDate:upcoming } });

    const { prisma } = await import('../dist/core/prisma/client.js'); sharedDb = prisma;
    const { signAccessToken, hashToken } = await import('../dist/core/security/jwt.js');
    async function session(userId) {
      const sessionId = randomUUID();
      const token = signAccessToken({ sessionId, userId, tenantId: tenant.id });
      await db.session.create({ data: { id: sessionId, tenantId: tenant.id, userId, activeProjectId: project.id, tokenHash: hashToken(token), expiresAt: upcoming } });
      return token;
    }
    const authorToken = await session(author.id), otherToken = await session(other.id);
    const { authenticate } = await import('../dist/core/security/auth.middleware.js');
    const { pollsRouter, eventsRouter } = await import('../dist/modules/community/community.routes.js');
    const { noticesRouter } = await import('../dist/modules/community/notices.routes.js');
    const app = express(); app.use(express.json()); app.use(authenticate);
    app.use('/polls', pollsRouter); app.use('/events', eventsRouter); app.use('/notices', noticesRouter);
    app.use((error, _req, res, _next) => res.status(error.statusCode ?? 500).json({ error: error.message }));
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    async function request(path, method = 'GET', body, token = otherToken) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type':'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json() };
    }
    assert.equal((await request('/events/upcoming', 'GET', undefined, authorToken)).status, 200);

    // Seed records before applying the migration to verify existing rows survive it.
    if (process.env.USER_DELETION_APPLY_MIGRATION === 'true') {
      await assert.rejects(db.user.delete({ where: { id: author.id } }), error => error.code === 'P2003');
      const sql = await readFile(new URL('../prisma/migrations/20261016140000_preserve_history_on_user_deletion/migration.sql', import.meta.url), 'utf8');
      const statements = sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(s => s && !['BEGIN','COMMIT'].includes(s));
      await db.$transaction(async tx => { for (const statement of statements) await tx.$executeRawUnsafe(statement); });
      assert.deepEqual(await db.projectEvent.findUniqueOrThrow({ where: { id: event.id } }), event);
    }

    await db.user.delete({ where: { id: author.id } });

    for (const [model, row, field] of [['projectEvent',event,'createdById'],['poll',poll,'createdById'],['projectNotice',notice,'createdById'],['memberCallLog',log,'createdById'],['paymentCommitment',commitment,'createdById'],['memberReminder',reminder,'sentById']]) {
      const retained = await db[model].findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(retained[field], null, model);
      for (const [key, value] of Object.entries(row)) {
        if (key !== field) assert.deepEqual(retained[key], value, `${model}.${key}`);
      }
    }
    assert.equal(await db.user.count({ where: { id: author.id } }), 0);
    assert.equal(await db.projectMembership.count({ where: { id: membership.id } }), 0);
    assert.equal((await db.member.findUniqueOrThrow({ where: { id: member.id } })).userId, null);
    assert.equal(await db.pollVote.count({ where: { pollId: poll.id, userId: other.id } }), 1);
    assert.equal((await db.projectEvent.findUniqueOrThrow({ where: { id: unrelated.id } })).createdById, other.id);
    assert.equal(await db.user.count({ where: { id: other.id } }), 1);
    assert.deepEqual(await db.account.findUniqueOrThrow({ where: { id:account.id } }), account);
    assert.deepEqual(await db.accountTransaction.findUniqueOrThrow({ where: { id:transaction.id } }), transaction);
    assert.deepEqual(await db.schedule.findUniqueOrThrow({ where: { id:schedule.id } }), schedule);
    assert.deepEqual(await db.due.findUniqueOrThrow({ where: { id:due.id } }), due);
    assert.equal(await db.session.count({ where: { userId: author.id } }), 0);
    assert.equal(await db.session.count({ where: { userId: other.id } }), 1);
    assert.equal((await request('/events/upcoming', 'GET', undefined, authorToken)).status, 401);

    // Existing authenticated feature routes continue to work with a null author.
    const events = await request('/events/upcoming'); assert.equal(events.status, 200);
    assert.equal(events.body.data.find(row => row.id === event.id).created_by_id, null);
    const activePolls = await request('/polls/active'); assert.equal(activePolls.status, 200);
    assert.equal(activePolls.body.data.find(row => row.id === poll.id).created_by_id, null);
    assert.equal((await request(`/polls/${poll.id}/vote`, 'POST', { option_id: option.id })).status, 200);
    const analytics = await request(`/polls/${poll.id}/analytics`); assert.equal(analytics.status, 200);
    assert.equal(analytics.body.data.total_votes, 1);
    assert.equal(analytics.body.data.voters[0].user_id, other.id);
    assert.equal((await request('/notices')).body.data.find(row => row.id === notice.id).body, notice.body);
    assert.equal((await request(`/notices/${notice.id}`, 'PATCH', { body: 'Updated retained notice' })).status, 200);
    assert.equal((await request(`/events/${event.id}`, 'PATCH', { title: 'Updated retained meeting' })).status, 200);
    const newEvent = await request('/events', 'POST', { title:'New meeting', agenda:'New agenda', place:'Office', starts_at:upcoming.toISOString() });
    assert.equal(newEvent.status, 201); assert.equal(newEvent.body.data.created_by_id, other.id);
    const newPoll = await request('/polls', 'POST', { title:'New poll', options:['Yes','No'], expires_at:upcoming.toISOString() });
    assert.equal(newPoll.status, 201); assert.equal(newPoll.body.data.created_by_id, other.id);

    const { runCommunityReminders } = await import('../dist/modules/community/community-reminders.service.js');
    await runCommunityReminders();
    assert.equal((await db.projectEvent.findUniqueOrThrow({ where: { id: event.id } })).reminderOneHourSentAt instanceof Date, true);
    assert.equal(await db.notification.count({ where: { recipientUserId: other.id, entityId:event.id, type:'event.reminder_one_hour' } }), 1);
    assert.equal(await db.notification.count({ where: { recipientUserId: voter.id, entityId:poll.id, type:'poll.vote_reminder' } }), 1);
    await runCommunityReminders();
    assert.equal(await db.notification.count({ where: { recipientUserId: other.id, entityId:event.id, type:'event.reminder_one_hour' } }), 1);
    assert.equal(await db.notification.count({ where: { recipientUserId: voter.id, entityId:poll.id, type:'poll.vote_reminder' } }), 1);
    assert.equal((await request(`/polls/${poll.id}/close`, 'POST')).status, 200);
    assert.equal((await request(`/events/${event.id}/cancel`, 'POST')).status, 200);
    assert.equal((await request(`/notices/${notice.id}`, 'DELETE')).status, 200);

    // A shared login root must still be handled explicitly, not silently detached.
    const linked = await db.user.create({ data: { tenantId: tenant.id, name: 'Linked login', mobile: 'linked', identityRootId: other.id } });
    await assert.rejects(db.user.delete({ where: { id: other.id } }), error => error.code === 'P2003');
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: linked.id } })).identityRootId, other.id);
    await db.user.delete({ where: { id: linked.id } });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (tenant) await db.tenant.delete({ where: { id: tenant.id } });
    if (sharedDb) await sharedDb.$disconnect();
    await db.$disconnect();
  }
});
