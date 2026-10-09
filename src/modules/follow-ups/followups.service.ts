import type { CommitmentStatus, PaymentCommitment, Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { calculateDueBalance } from "../members/member-settlement.service.js";
import { getMemberOutstanding } from "../dues/outstanding.service.js";
import { addDateDays, compareDateOnly, dateKey, dhakaDateKey, dhakaToday, effectiveStatus, isReminderAvailable, scoreFor, tierFor } from "./followups.policy.js";

type Tx = Prisma.TransactionClient;
type Scope = { tenantId: string; projectId: string };

export function commitmentPayload(commitment: PaymentCommitment, now = new Date()) {
  const status = effectiveStatus(commitment.status, commitment.promisedDate, now);
  const daysOverdue = status === "broken"
    ? Math.max(1, Math.round((dhakaToday(now).getTime() - commitment.promisedDate.getTime()) / 86_400_000))
    : 0;
  return {
    id: commitment.id,
    amount: commitment.amount,
    promised_date: dateKey(commitment.promisedDate),
    summary: commitment.summary,
    status: commitment.status,
    effective_status: status,
    days_overdue: daysOverdue,
    created_at: commitment.createdAt,
    resolved_at: commitment.resolvedAt
  };
}

function memberPayload(member: { id: string; name: string; mobile: string; shares: number; profile: Prisma.JsonValue | null }) {
  const profile = member.profile && typeof member.profile === "object" && !Array.isArray(member.profile) ? member.profile : null;
  const photoId = profile?.photo_file_id;
  return {
    id: member.id, name: member.name, mobile: member.mobile, shares: member.shares,
    profile: { photo_file_id: typeof photoId === "string" && photoId ? photoId : null }
  };
}

export async function resolveCommitmentsForDeposit(
  tx: Tx,
  deposit: { id: string; tenantId: string; projectId: string; memberId: string; createdAt: Date },
  actorUserId?: string | null
) {
  const pending = await tx.paymentCommitment.findFirst({
    where: { tenantId: deposit.tenantId, projectId: deposit.projectId, memberId: deposit.memberId, status: "pending" },
    orderBy: { createdAt: "desc" }
  });
  const commitment = pending ?? await tx.paymentCommitment.findFirst({
    where: { tenantId: deposit.tenantId, projectId: deposit.projectId, memberId: deposit.memberId, status: "broken" },
    orderBy: { createdAt: "desc" }
  });
  if (!commitment) return null;

  const deposits = await tx.deposit.findMany({
    where: {
      tenantId: deposit.tenantId,
      projectId: deposit.projectId,
      memberId: deposit.memberId,
      status: "confirmed",
      createdAt: { gte: commitment.createdAt }
    },
    select: { amount: true, refundedAmount: true }
  });
  const paidTotal = deposits.reduce((sum, item) => sum + Math.max(0, item.amount - item.refundedAmount), 0);
  const outstanding = await getMemberOutstanding(deposit.tenantId, deposit.projectId, deposit.memberId, tx);
  if (paidTotal < commitment.amount && outstanding > 0) return null;

  const status: CommitmentStatus = compareDateOnly(dhakaDateKey(deposit.createdAt), commitment.promisedDate) <= 0 ? "kept" : "kept_late";
  const resolved = await tx.paymentCommitment.update({
    where: { id: commitment.id },
    data: {
      status,
      resolvedAt: new Date(),
      resolvedById: actorUserId ?? null,
      resolvedDepositId: deposit.id,
      resolveReason: "Automatically resolved from confirmed deposits"
    }
  });
  await tx.activity.create({
    data: {
      tenantId: deposit.tenantId,
      projectId: deposit.projectId,
      actorUserId: actorUserId ?? null,
      action: `commitment.${status}`,
      entityType: "payment_commitment",
      entityId: commitment.id,
      before: JSON.parse(JSON.stringify(commitment)),
      after: JSON.parse(JSON.stringify(resolved))
    }
  });
  return resolved;
}

async function projectSnapshot(scope: Scope, now = new Date()) {
  const today = dhakaToday(now);
  const [members, commitments, dues, reminders] = await Promise.all([
    prisma.member.findMany({
      where: { ...scope, status: "active" },
      select: { id: true, name: true, mobile: true, shares: true, profile: true },
      orderBy: { name: "asc" }
    }),
    prisma.paymentCommitment.findMany({ where: scope, orderBy: { createdAt: "desc" } }),
    prisma.due.findMany({
      where: scope,
      select: {
        id: true,
        memberId: true,
        amount: true,
        paidAmount: true,
        waivedAmount: true,
        penaltyDue: true,
        penaltyPaid: true,
        dueDate: true,
        paidAt: true,
        allocations: {
          where: { deposit: { status: "confirmed" } },
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
          take: 1
        }
      }
    }),
    prisma.memberReminder.findMany({ where: { ...scope, reminderDate: today }, orderBy: { sentAt: "desc" } })
  ]);

  const commitmentsByMember = new Map<string, PaymentCommitment[]>();
  for (const commitment of commitments) {
    const rows = commitmentsByMember.get(commitment.memberId) ?? [];
    rows.push(commitment);
    commitmentsByMember.set(commitment.memberId, rows);
  }
  const duesByMember = new Map<string, typeof dues>();
  for (const due of dues) {
    const rows = duesByMember.get(due.memberId) ?? [];
    rows.push(due);
    duesByMember.set(due.memberId, rows);
  }
  const reminderByMember = new Map(reminders.map(reminder => [reminder.memberId, reminder]));

  const reliability = members.map(member => {
    const memberCommitments = commitmentsByMember.get(member.id) ?? [];
    const kept = memberCommitments.filter(item => item.status === "kept").length;
    const breaks = memberCommitments.filter(item => ["broken", "kept_late", "rescheduled"].includes(effectiveStatus(item.status, item.promisedDate, now))).length;
    const memberDues = duesByMember.get(member.id) ?? [];
    const missedDeadlines = memberDues.filter(due => {
      if (compareDateOnly(due.dueDate, today) >= 0) return false;
      if (calculateDueBalance(due).total > 0) return true;
      const settledAt = due.paidAt ?? due.allocations[0]?.createdAt ?? null;
      return !settledAt || compareDateOnly(dhakaDateKey(settledAt), due.dueDate) > 0;
    }).length;
    const score = scoreFor(breaks, missedDeadlines);
    return { member, score, tier: tierFor(score), kept, breaks, missed_deadlines: missedDeadlines };
  }).sort((left, right) => right.score - left.score || left.breaks - right.breaks || left.member.name.localeCompare(right.member.name));

  const reliabilityByMember = new Map(reliability.map((row, index) => [row.member.id, {
    score: row.score,
    tier: row.tier,
    rank: index + 1,
    of: reliability.length,
    kept: row.kept,
    breaks: row.breaks,
    missed_deadlines: row.missed_deadlines
  }]));
  const outstandingByMember = new Map(members.map(member => [member.id, (duesByMember.get(member.id) ?? []).reduce((sum, due) => sum + calculateDueBalance(due).total, 0)]));
  return { today, members, commitmentsByMember, reminderByMember, reliability, reliabilityByMember, outstandingByMember };
}

function activeCommitment(rows: PaymentCommitment[], now = new Date()) {
  return rows.find(row => row.status === "pending") ?? rows.find(row => row.status === "broken") ?? null;
}

function reminderPayload(outstanding: number, sentAt?: Date | null) {
  return {
    available: isReminderAvailable(outstanding, sentAt),
    sent_today_at: sentAt ?? null,
    reason: outstanding <= 0 ? "no_outstanding_due" : sentAt ? "already_sent_today" : null
  };
}

export async function getFollowupList(scope: Scope, tab: "need" | "upcoming" | "settled", now = new Date()) {
  const snapshot = await projectSnapshot(scope, now);
  const settledCutoff = addDateDays(snapshot.today, -30);
  const all = snapshot.members.flatMap(member => {
    const commitments = snapshot.commitmentsByMember.get(member.id) ?? [];
    const active = activeCommitment(commitments, now);
    const settled = commitments.find(item => ["kept", "kept_late"].includes(item.status) && item.resolvedAt && item.resolvedAt >= settledCutoff) ?? null;
    const outstanding = snapshot.outstandingByMember.get(member.id) ?? 0;
    const reminder = snapshot.reminderByMember.get(member.id);
    const base = { member: memberPayload(member), outstanding, reminder: reminderPayload(outstanding, reminder?.sentAt), reliability: snapshot.reliabilityByMember.get(member.id)! };
    return [
      ...(active ? [{ ...base, commitment: active, effective: effectiveStatus(active.status, active.promisedDate, now), group: "active" as const }] : []),
      ...(settled ? [{ ...base, commitment: settled, effective: effectiveStatus(settled.status, settled.promisedDate, now), group: "settled" as const }] : [])
    ];
  });
  const need = all.filter(row => row.group === "active" && ["due_today", "broken"].includes(row.effective));
  const upcoming = all.filter(row => row.group === "active" && row.effective === "pending");
  const settled = all.filter(row => row.group === "settled");
  need.sort((a, b) => a.effective === b.effective ? b.commitment.promisedDate.getTime() - a.commitment.promisedDate.getTime() : a.effective === "due_today" ? -1 : 1);
  upcoming.sort((a, b) => a.commitment.promisedDate.getTime() - b.commitment.promisedDate.getTime());
  settled.sort((a, b) => (b.commitment.resolvedAt?.getTime() ?? 0) - (a.commitment.resolvedAt?.getTime() ?? 0));
  const selected = tab === "need" ? need : tab === "upcoming" ? upcoming : settled;
  return {
    today: dateKey(snapshot.today),
    counts: { need: need.length, upcoming: upcoming.length, settled: settled.length },
    need_unpaid_total: need.reduce((sum, row) => sum + Math.min(row.commitment.amount, row.outstanding), 0),
    items: selected.map(row => ({ ...row, commitment: commitmentPayload(row.commitment, now), effective: undefined, group: undefined }))
  };
}

export async function getReliabilityRanking(scope: Scope, tier: "all" | "reliable" | "watch" | "at_risk", now = new Date()) {
  const snapshot = await projectSnapshot(scope, now);
  const counts = { all: snapshot.reliability.length, reliable: 0, watch: 0, at_risk: 0 };
  snapshot.reliability.forEach(row => { counts[row.tier] += 1; });
  return {
    counts,
    items: snapshot.reliability
      .filter(row => tier === "all" || row.tier === tier)
      .map(row => ({ member: memberPayload(row.member), reliability: snapshot.reliabilityByMember.get(row.member.id)! }))
  };
}

export async function getMemberFollowup(scope: Scope, memberId: string, cursor = 0, now = new Date()) {
  const snapshot = await projectSnapshot(scope, now);
  const member = snapshot.members.find(item => item.id === memberId);
  if (!member) return null;
  const commitments = snapshot.commitmentsByMember.get(memberId) ?? [];
  const outstanding = snapshot.outstandingByMember.get(memberId) ?? 0;
  const reminder = snapshot.reminderByMember.get(memberId);
  const [callLogs, reminders] = await Promise.all([
    prisma.memberCallLog.findMany({
      where: { ...scope, memberId },
      include: { createdBy: { select: { name: true } }, commitment: { select: { id: true } } },
      orderBy: { createdAt: "desc" }
    }),
    prisma.memberReminder.findMany({
      where: { ...scope, memberId },
      include: { sentBy: { select: { name: true } } },
      orderBy: { sentAt: "desc" }
    })
  ]);
  const timeline = [
    ...commitments.map(item => ({ id: item.id, kind: "commitment" as const, created_at: item.createdAt, created_by_name: callLogs.find(log => log.commitment?.id === item.id)?.createdBy.name, commitment: commitmentPayload(item, now) })),
    ...callLogs.filter(item => !item.commitment).map(item => ({ id: item.id, kind: "call_log" as const, created_at: item.calledAt, summary: item.summary, outcome: item.outcome, created_by_name: item.createdBy.name })),
    ...reminders.map(item => ({ id: item.id, kind: "reminder" as const, created_at: item.sentAt, created_by_name: item.sentBy.name }))
  ].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  const page = timeline.slice(cursor, cursor + 30);
  return {
    today: dateKey(snapshot.today),
    member: memberPayload(member),
    outstanding,
    active_commitment: activeCommitment(commitments, now) ? commitmentPayload(activeCommitment(commitments, now)!, now) : null,
    reminder: reminderPayload(outstanding, reminder?.sentAt),
    reliability: snapshot.reliabilityByMember.get(member.id)!,
    timeline: page,
    next_cursor: cursor + page.length < timeline.length ? String(cursor + page.length) : null
  };
}

export async function breakOverdueCommitments(now = new Date()) {
  const today = dhakaToday(now);
  const rows = await prisma.paymentCommitment.findMany({ where: { status: "pending", promisedDate: { lt: today } } });
  let changed = 0;
  for (const row of rows) {
    const updated = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM payment_commitments WHERE id = ${row.id} FOR UPDATE`;
      const current = await tx.paymentCommitment.findUnique({ where: { id: row.id } });
      if (!current || current.status !== "pending" || compareDateOnly(current.promisedDate, today) >= 0) return null;
      const after = await tx.paymentCommitment.update({ where: { id: current.id }, data: { status: "broken" } });
      await tx.activity.create({ data: {
        tenantId: current.tenantId,
        projectId: current.projectId,
        action: "commitment.broken",
        entityType: "payment_commitment",
        entityId: current.id,
        before: JSON.parse(JSON.stringify(current)),
        after: JSON.parse(JSON.stringify(after))
      } });
      return after;
    });
    if (updated) changed += 1;
  }
  return { changed };
}
