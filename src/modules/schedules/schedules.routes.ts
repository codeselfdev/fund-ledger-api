import { Router } from "express";
import { z } from "zod";
import { ScheduleStatus } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema, optionalPenaltyPolicySchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { createScheduleWithUnitAmount } from "./schedule-creation.service.js";
import { sendWhatsAppGroupMessage } from "../../core/whatsapp/whatsapp.service.js";

import { scheduleCollectionData, summarizeSchedule, dueRemaining } from "./schedule-summary.service.js";

const router = Router();

const scheduleBodySchema = z.object({
  name: z.string().min(2),
  unit_amount: z.number().int().positive(),
  due_date: z.coerce.date(),
  status: z.nativeEnum(ScheduleStatus).default("active"),
  penalty_policy: optionalPenaltyPolicySchema
});

const scheduleUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  due_date: z.coerce.date().optional(),
  status: z.nativeEnum(ScheduleStatus).optional(),
  penalty_policy: optionalPenaltyPolicySchema
});

const scheduleQuerySchema = z.object({
  include_system: z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, z.boolean().optional())
});

router.get("/", requireProject, requireRoles("any"), validateQuery(scheduleQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof scheduleQuerySchema>;
  const [schedules, collection] = await Promise.all([prisma.schedule.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.include_system ? {} : { purpose: "contribution" })
    },
    include: {
      dues: {
        select: { amount: true, paidAmount: true, waivedAmount: true, penaltyDue: true, penaltyPaid: true, status: true }
      }
    },
    orderBy: { createdAt: "desc" }
  }), scheduleCollectionData(auth.tenantId, auth.projectId)]);

  return ok(res, schedules.map((schedule) => {
    const totalPaid = schedule.dues.reduce((sum, due) => sum + due.paidAmount + due.penaltyPaid, 0);
    const totalDue = schedule.dues.reduce((sum, due) => sum + due.amount - due.waivedAmount + due.penaltyDue, 0);
    return {
      ...schedule,
      collection: summarizeSchedule(schedule.dues, collection.dues.filter(d => d.scheduleId === schedule.id).reduce((sum, d) => sum + (collection.pending.get(d.id)?.amount ?? 0), 0)),
      collected_percent: totalDue === 0 ? 0 : Math.round((totalPaid / totalDue) * 100)
    };
  }));
}));

router.get("/:id/member-summary", requireProject, requireRoles("staff"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const schedule = await prisma.schedule.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId, purpose: "contribution" } });
  if (!schedule) throw notFound("Schedule not found");
  const [collection, members] = await Promise.all([
    scheduleCollectionData(auth.tenantId, auth.projectId),
    prisma.member.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId, dues: { some: { scheduleId: id } } },
      select: { id: true, name: true, mobile: true, shares: true, status: true, profile: true }, orderBy: { createdAt: "desc" } })
  ]);
  const dues = collection.dues.filter(d => d.scheduleId === id);
  const items = members.flatMap(member => {
    const due = dues.find(d => d.memberId === member.id);
    if (!due) return [];
    const pending = collection.pending.get(due.id);
    const outstanding = dueRemaining(due);
    const photo = member.profile && typeof member.profile === "object" && !Array.isArray(member.profile) ? member.profile.photo_file_id : null;
    return [{ member: { ...member, profile: typeof photo === "string" ? { photo_file_id: photo } : null }, due: { ...due, outstanding }, pending_amount: pending?.amount ?? 0,
      pending_deposit_ids: pending?.depositIds ?? [], payment_state: outstanding === 0 ? "paid" : pending?.amount ? "pending" : "unpaid" }];
  });
  return ok(res, { schedule, collection: summarizeSchedule(dues, items.reduce((sum, row) => sum + row.pending_amount, 0)), items });
}));

router.post("/", requireProject, requireRoles("approver", "admin"), validateBody(scheduleBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof scheduleBodySchema>;
  const result = await createScheduleWithUnitAmount({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    name: body.name,
    unitAmount: body.unit_amount,
    dueDate: body.due_date,
    status: body.status,
    penaltyPolicy: body.penalty_policy,
    createdById: auth.userId
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "schedule.created",
    entityType: "schedule",
    entityId: result.schedule.id,
    after: {
      schedule: result.schedule,
      unit_amount: body.unit_amount,
      dues_created: result.duesCreated,
      auto_applied_total: result.autoAppliedTotal
    }
  });

  try {
    await notifyProjectMembers({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      type: "schedule.created",
      title: "New dues created",
      body: `${result.schedule.name} is now available for payment.`,
      entityType: "schedule",
      entityId: result.schedule.id
    });
  } catch (error) {
    console.error("[notifications] failed to announce payment schedule", error);
  }
  await sendWhatsAppGroupMessage({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    message: `New payment schedule: ${result.schedule.name}\nAmount per share: BDT ${body.unit_amount.toLocaleString("en-US")}\nDue: ${result.schedule.dueDate.toISOString().slice(0, 10)}`
  });

  return created(res, {
    ...result.schedule,
    unit_amount: body.unit_amount,
    dues_created: result.duesCreated,
    auto_applied_total: result.autoAppliedTotal
  });
}));

router.patch("/:id", requireProject, requireRoles("approver", "admin"), validateParams(idParamSchema), validateBody(scheduleUpdateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof scheduleUpdateSchema>;
  const before = await prisma.schedule.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Schedule not found");
  if (before.purpose === "previous_installment") {
    throw badRequest("System accounting schedules cannot be edited");
  }
  if (before.status === "closed" && body.status && body.status !== "closed") {
    throw badRequest("Closed schedules cannot be reopened");
  }

  const schedule = await prisma.schedule.update({
    where: { id },
    data: {
      name: body.name,
      dueDate: body.due_date,
      status: body.status,
      penaltyPolicy: body.penalty_policy
    }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "schedule.updated",
    entityType: "schedule",
    entityId: schedule.id,
    before,
    after: schedule
  });

  return ok(res, schedule);
}));

export { router as schedulesRouter };
