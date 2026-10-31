import type { MemberRecognition, Prisma, RecognitionStatus, Role } from "@prisma/client";
import type { z } from "zod";
import { writeAudit } from "../../core/audit/audit.service.js";
import { conflict, forbidden, notFound } from "../../core/http/api-error.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { prisma } from "../../core/prisma/client.js";
import { addDateDays, assertEffortDate, dateKey, dhakaToday, MAX_PENDING_RECOGNITIONS, RECOGNITION_BONUS, RECOGNITION_WINDOW_DAYS, type recognitionActionSchema, type recognitionCreateSchema } from "./followups.policy.js";
import { projectSnapshot } from "./followups.service.js";

type Auth = { tenantId: string; projectId: string; userId: string; memberId: string | null; memberIds?: string[]; roles: Role[] };
type Row = MemberRecognition & { requestedBy?: { identity: { name: string } } | null; reviewedBy?: { identity: { name: string } } | null };
const REVIEWERS: Role[] = ["owner", "admin"];
const READERS: Role[] = ["owner", "admin", "accountant", "auditor"];
const people = { requestedBy: { select: { identity: { select: { name: true } } } }, reviewedBy: { select: { identity: { select: { name: true } } } } } satisfies Prisma.MemberRecognitionInclude;

/** Members see their own record; owner/admin accredit; accountants/auditors read. Nobody accredits their own effort. */
export function recognitionAccess(auth: Auth, memberId: string) {
  const own = auth.memberId === memberId || auth.memberIds?.includes(memberId) === true;
  const reviewer = !own && auth.roles.some(role => REVIEWERS.includes(role));
  const reader = own || auth.roles.some(role => READERS.includes(role));
  if (!reader) throw forbidden("You cannot view this member's recognition.");
  return { own, reviewer };
}

export function recognitionPayload(row: Row, userId?: string) {
  return {
    id: row.id, title: row.title, note: row.note, status: row.status,
    effort_date: dateKey(row.effortDate), effort_hours: row.effortMinutes == null ? null : row.effortMinutes / 60,
    requested_by_name: row.requestedBy?.identity.name ?? null, reviewed_by_name: row.reviewedBy?.identity.name ?? null,
    reviewed_at: row.reviewedAt, review_note: row.reviewNote, created_at: row.createdAt,
    requested_by_me: !!userId && row.requestedById === userId
  };
}

export async function getMemberRecognitions(auth: Auth, memberId: string, now = new Date()) {
  const { own, reviewer } = recognitionAccess(auth, memberId);
  const scope = { tenantId: auth.tenantId, projectId: auth.projectId };
  const member = await prisma.member.findFirst({ where: { ...scope, id: memberId }, select: { id: true, name: true, status: true } });
  if (!member) throw notFound("Member not found");
  const since = addDateDays(dhakaToday(now), -RECOGNITION_WINDOW_DAYS);
  const [rows, accredited, snapshot] = await Promise.all([
    prisma.memberRecognition.findMany({ where: { ...scope, memberId, status: { in: ["pending", "accredited", "declined", "revoked"] } }, include: people, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 }),
    prisma.memberRecognition.aggregate({ where: { ...scope, memberId, status: "accredited" }, _count: { _all: true }, _sum: { effortMinutes: true } }),
    member.status === "active" ? projectSnapshot(scope, now) : Promise.resolve(null),
  ]);
  const pending = rows.filter(row => row.status === "pending").length;
  return {
    member: { id: member.id, name: member.name },
    bonus_points: RECOGNITION_BONUS, window_days: RECOGNITION_WINDOW_DAYS, max_pending: MAX_PENDING_RECOGNITIONS,
    can_request: own && member.status === "active" && pending < MAX_PENDING_RECOGNITIONS,
    can_add: reviewer && member.status === "active",
    can_review: reviewer,
    summary: {
      counted: rows.filter(row => row.status === "accredited" && row.effortDate >= since).length,
      accredited: accredited._count._all,
      hours: Math.round((accredited._sum.effortMinutes ?? 0) / 6) / 10,
      pending
    },
    reliability: snapshot?.reliabilityByMember.get(memberId) ?? null,
    items: rows.map(row => recognitionPayload(row, auth.userId))
  };
}

export async function createRecognition(auth: Auth, memberId: string, body: z.infer<typeof recognitionCreateSchema>) {
  const { own, reviewer } = recognitionAccess(auth, memberId);
  if (!own && !reviewer) throw forbidden("Only a project owner or admin can add a recognition.");
  const effortDate = assertEffortDate(body.effort_date);
  const status: RecognitionStatus = reviewer ? "accredited" : "pending";
  const scope = { tenantId: auth.tenantId, projectId: auth.projectId };
  const saved = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM members WHERE id = ${memberId} AND tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} FOR UPDATE`;
    const member = await tx.member.findFirst({ where: { ...scope, id: memberId, status: "active" }, select: { id: true, name: true } });
    if (!member) throw notFound("Active member not found");
    if (status === "pending" && await tx.memberRecognition.count({ where: { ...scope, memberId, status: "pending" } }) >= MAX_PENDING_RECOGNITIONS) {
      throw conflict(`You already have ${MAX_PENDING_RECOGNITIONS} requests awaiting an admin. Wait for a decision or withdraw one.`);
    }
    const row = await tx.memberRecognition.create({ data: {
      ...scope, memberId, title: body.title, note: body.note || null, effortDate,
      effortMinutes: body.effort_hours ? Math.round(body.effort_hours * 60) : null, status, requestedById: auth.userId,
      ...(reviewer ? { reviewedById: auth.userId, reviewedAt: new Date() } : {})
    }, include: people });
    await writeAudit({ ...scope, actorUserId: auth.userId, action: reviewer ? "recognition.accredited" : "recognition.requested", entityType: "member_recognition", entityId: row.id, after: recognitionPayload(row) }, tx);
    return { row, member };
  });
  await notifyProjectMembers(reviewer
    ? { ...scope, actorUserId: auth.userId, memberIds: [memberId], type: "recognition.accredited", title: "You received a recognition", body: `${saved.row.title} was accredited by your admin. Thank you for the extra effort.`, entityType: "member", entityId: memberId }
    : { ...scope, actorUserId: auth.userId, roles: REVIEWERS, type: "recognition.requested", title: `Recognition request · ${saved.member.name}`, body: `${saved.member.name} asked to recognize: ${saved.row.title}. Open the member profile to accredit or decline.`, entityType: "member", entityId: memberId }
  ).catch(() => undefined);
  return recognitionPayload(saved.row, auth.userId);
}

const transitions = {
  accredit: { from: "pending", to: "accredited", reviewer: true },
  decline: { from: "pending", to: "declined", reviewer: true },
  revoke: { from: "accredited", to: "revoked", reviewer: true },
  withdraw: { from: "pending", to: "withdrawn", reviewer: false },
} as const;

export async function updateRecognition(auth: Auth, memberId: string, recognitionId: string, body: z.infer<typeof recognitionActionSchema>) {
  const { own, reviewer } = recognitionAccess(auth, memberId);
  const rule = transitions[body.action];
  if (rule.reviewer ? !reviewer : !own) throw forbidden(rule.reviewer ? "Only another owner or admin can do this." : "Only the member can withdraw their request.");
  const scope = { tenantId: auth.tenantId, projectId: auth.projectId };
  const saved = await prisma.$transaction(async tx => {
    const before = await tx.memberRecognition.findFirst({ where: { ...scope, memberId, id: recognitionId }, include: people });
    if (!before) throw notFound("Recognition not found");
    // Conditional update: two admins (or an admin and the member) cannot both act on the same request.
    const changed = await tx.memberRecognition.updateMany({ where: { ...scope, memberId, id: recognitionId, status: rule.from }, data: {
      status: rule.to, ...(rule.reviewer ? { reviewedById: auth.userId, reviewedAt: new Date(), reviewNote: body.note || null } : {})
    } });
    if (!changed.count) throw conflict("This recognition was already updated. Refresh and try again.");
    const after = await tx.memberRecognition.findUniqueOrThrow({ where: { id: recognitionId }, include: people });
    await writeAudit({ ...scope, actorUserId: auth.userId, action: `recognition.${rule.to}`, entityType: "member_recognition", entityId: recognitionId, before: recognitionPayload(before), after: recognitionPayload(after) }, tx);
    return after;
  });
  if (rule.reviewer) {
    const message = rule.to === "accredited" ? { title: "Your recognition was accredited", body: `${saved.title} now counts toward your reliability.` }
      : rule.to === "declined" ? { title: "Recognition request declined", body: `${saved.title}: ${saved.reviewNote ?? "Declined by your admin."}` }
      : { title: "Recognition removed", body: `${saved.title}: ${saved.reviewNote ?? "Removed by your admin."}` };
    await notifyProjectMembers({ ...scope, actorUserId: auth.userId, memberIds: [memberId], type: `recognition.${rule.to}`, ...message, entityType: "member", entityId: memberId }).catch(() => undefined);
  }
  return recognitionPayload(saved, auth.userId);
}
