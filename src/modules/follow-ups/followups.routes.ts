import { Prisma, type PaymentCommitment } from "@prisma/client";
import { Router } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import { writeAudit } from "../../core/audit/audit.service.js";
import { ApiError, badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { created, ok } from "../../core/http/response.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { getMemberOutstanding } from "../dues/outstanding.service.js";
import { addDateDays, assertPromiseDate, callLogSchema, compareDateOnly, dateKey, dhakaToday, followupsQuerySchema, reliabilityQuerySchema, resolveCommitmentSchema, timelineQuerySchema } from "./followups.policy.js";
import { commitmentPayload, getFollowupList, getMemberFollowup, getReliabilityRanking } from "./followups.service.js";

const router = Router();
const readRoles = requireRoles("owner", "admin", "auditor");
const writeRoles = requireRoles("owner", "admin");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

router.get("/follow-ups", requireProject, readRoles, validateQuery(followupsQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { tab } = req.query as z.infer<typeof followupsQuerySchema>;
  return ok(res, await getFollowupList({ tenantId: auth.tenantId, projectId: auth.projectId }, tab));
}));

router.get("/follow-ups/reliability", requireProject, readRoles, validateQuery(reliabilityQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { tier } = req.query as z.infer<typeof reliabilityQuerySchema>;
  return ok(res, await getReliabilityRanking({ tenantId: auth.tenantId, projectId: auth.projectId }, tier));
}));

router.get("/members/:id/follow-up", requireProject, readRoles, validateParams(idParamSchema), validateQuery(timelineQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const cursor = Number((req.query as z.infer<typeof timelineQuerySchema>).cursor ?? 0);
  const detail = await getMemberFollowup({ tenantId: auth.tenantId, projectId: auth.projectId }, id, cursor);
  if (!detail) throw notFound("Member not found");
  return ok(res, detail);
}));

router.post("/members/:id/call-logs", requireProject, writeRoles, validateParams(idParamSchema), validateBody(callLogSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id: memberId } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof callLogSchema>;
  const member = await prisma.member.findFirst({ where: { id: memberId, tenantId: auth.tenantId, projectId: auth.projectId, status: "active" } });
  if (!member) throw notFound("Member not found");
  const outstanding = await getMemberOutstanding(auth.tenantId, auth.projectId, memberId);
  const promisedDate = body.commitment ? assertPromiseDate(body.commitment.promised_date) : null;
  if (body.commitment && body.commitment.amount > outstanding) {
    throw badRequest("Commitment amount cannot exceed outstanding dues", { "commitment.amount": `Maximum amount is ${outstanding}` });
  }

  let result: { callLog: unknown; commitment: PaymentCommitment | null };
  try {
    result = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM members WHERE id = ${memberId} AND tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} FOR UPDATE`;
      const today = dhakaToday();
      const pending = await tx.paymentCommitment.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId, status: "pending" }, orderBy: { createdAt: "desc" } });
      const expired = pending.filter(item => compareDateOnly(item.promisedDate, today) < 0);
      for (const item of expired) {
        const after = await tx.paymentCommitment.update({ where: { id: item.id }, data: { status: "broken" } });
        await tx.activity.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "commitment.broken", entityType: "payment_commitment", entityId: item.id, before: json(item), after: json(after) } });
      }

      const callLogId = nanoid();
      const callLog = await tx.memberCallLog.create({ data: {
        id: callLogId,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        memberId,
        outcome: body.outcome,
        summary: body.summary?.trim() || null,
        createdById: auth.userId
      } });
      await tx.activity.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "call_log.created", entityType: "member_call_log", entityId: callLog.id, after: json(callLog) } });

      if (!body.commitment || !promisedDate) return { callLog, commitment: null };
      const currentPending = pending.filter(item => compareDateOnly(item.promisedDate, today) >= 0);
      for (const item of currentPending) {
        const after = await tx.paymentCommitment.update({ where: { id: item.id }, data: { status: "rescheduled" } });
        await tx.activity.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "commitment.rescheduled", entityType: "payment_commitment", entityId: item.id, before: json(item), after: json(after) } });
      }
      const commitment = await tx.paymentCommitment.create({ data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        memberId,
        callLogId,
        amount: body.commitment.amount,
        promisedDate,
        summary: body.summary!.trim(),
        outstandingAtCreate: outstanding,
        createdById: auth.userId
      } });
      if (currentPending.length) {
        await tx.paymentCommitment.updateMany({ where: { id: { in: currentPending.map(item => item.id) } }, data: { supersededById: commitment.id } });
      }
      await tx.activity.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "commitment.created", entityType: "payment_commitment", entityId: commitment.id, after: json(commitment) } });
      return { callLog, commitment };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("Another payment commitment was created at the same time. Refresh and try again");
    throw error;
  }
  const active = result.commitment ?? await prisma.paymentCommitment.findFirst({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId, status: { in: ["pending", "broken"] } },
    orderBy: { createdAt: "desc" }
  });
  const callLog = result.callLog as { id: string; outcome: string; summary: string | null; calledAt: Date; createdAt: Date };
  return created(res, {
    call_log: { id: callLog.id, outcome: callLog.outcome, summary: callLog.summary, called_at: callLog.calledAt, created_at: callLog.createdAt },
    commitment: result.commitment ? commitmentPayload(result.commitment) : null,
    active_commitment: active ? commitmentPayload(active) : null
  });
}));

router.post("/commitments/:id/resolve", requireProject, writeRoles, validateParams(idParamSchema), validateBody(resolveCommitmentSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof resolveCommitmentSchema>;
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM payment_commitments WHERE id = ${id} AND tenant_id = ${auth.tenantId} AND project_id = ${auth.projectId} FOR UPDATE`;
    const before = await tx.paymentCommitment.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
    if (!before) throw notFound("Payment commitment not found");
    if (!["pending", "broken"].includes(before.status)) throw badRequest("Only an open commitment can be resolved");
    const after = await tx.paymentCommitment.update({ where: { id }, data: { status: body.status, resolveReason: body.reason, resolvedAt: new Date(), resolvedById: auth.userId } });
    await tx.activity.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: `commitment.${body.status}`, entityType: "payment_commitment", entityId: id, before: json(before), after: json(after) } });
    return after;
  });
  return ok(res, commitmentPayload(result));
}));

router.post("/members/:id/reminders", requireProject, writeRoles, validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id: memberId } = req.params as z.infer<typeof idParamSchema>;
  const [member, project, outstanding, openCommitments] = await Promise.all([
    prisma.member.findFirst({ where: { id: memberId, tenantId: auth.tenantId, projectId: auth.projectId, status: "active" } }),
    prisma.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId }, select: { name: true } }),
    getMemberOutstanding(auth.tenantId, auth.projectId, memberId),
    prisma.paymentCommitment.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId, status: { in: ["pending", "broken"] } }, orderBy: { createdAt: "desc" } })
  ]);
  if (!member || !project) throw notFound("Member not found");
  if (outstanding <= 0) throw new ApiError(422, "NO_OUTSTANDING_DUE", "This member has no outstanding due");
  const today = dhakaToday();
  let reminder;
  try {
    reminder = await prisma.memberReminder.create({ data: { tenantId: auth.tenantId, projectId: auth.projectId, memberId, reminderDate: today, outstanding, deliveredCount: 0, sentById: auth.userId } });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.memberReminder.findUnique({ where: { projectId_memberId_reminderDate: { projectId: auth.projectId, memberId, reminderDate: today } } });
      throw new ApiError(409, "REMINDER_ALREADY_SENT_TODAY", "A reminder was already sent today", { sent_today_at: existing?.sentAt ?? null });
    }
    throw error;
  }
  const openCommitment = openCommitments.find(item => item.status === "pending") ?? openCommitments.find(item => item.status === "broken") ?? null;
  const suffix = openCommitment ? ` You promised to pay by ${dateKey(openCommitment.promisedDate)}.` : "";
  let deliveredCount = 0;
  try {
    const delivered = await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      memberIds: [memberId],
      type: "payment.reminder",
      title: "Payment reminder",
      body: `You have ৳${outstanding.toLocaleString("en-IN")} due for ${project.name}.${suffix}`,
      entityType: "member",
      entityId: memberId
    });
    deliveredCount = delivered.count;
  } catch (error) {
    console.error("[follow-ups] reminder delivery failed", error);
  }
  reminder = await prisma.memberReminder.update({ where: { id: reminder.id }, data: { deliveredCount } });
  await writeAudit({ tenantId: auth.tenantId, projectId: auth.projectId, actorUserId: auth.userId, action: "member.reminded", entityType: "member", entityId: memberId, after: reminder });
  return ok(res, { sent_at: reminder.sentAt, delivered_count: deliveredCount, next_available_on: dateKey(addDateDays(today, 1)) });
}));

export { router as followupsRouter };
