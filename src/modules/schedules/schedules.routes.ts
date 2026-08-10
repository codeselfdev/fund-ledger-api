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
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { createScheduleWithUnitAmount } from "./schedule-creation.service.js";

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

router.get("/", requireProject, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const schedules = await prisma.schedule.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId },
    include: {
      dues: {
        select: { amount: true, paidAmount: true, penaltyDue: true, penaltyPaid: true, status: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, schedules.map((schedule) => {
    const totalPaid = schedule.dues.reduce((sum, due) => sum + due.paidAmount + due.penaltyPaid, 0);
    const totalDue = schedule.dues.reduce((sum, due) => sum + due.amount + due.penaltyDue, 0);
    return {
      ...schedule,
      collected_percent: totalDue === 0 ? 0 : Math.round((totalPaid / totalDue) * 100)
    };
  }));
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

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    roles: ["member"],
    type: "schedule.created",
    title: "New dues created",
    body: `${result.schedule.name} is now available for payment.`,
    entityType: "schedule",
    entityId: result.schedule.id
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
