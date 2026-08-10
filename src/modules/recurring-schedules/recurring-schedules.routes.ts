import { Router } from "express";
import { z } from "zod";
import { RecurringFrequency } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { resolveInitialNextRunAt } from "./recurring-schedules.service.js";
import { optionalPenaltyPolicySchema } from "../../core/validation/common.schemas.js";

const router = Router();

const recurringScheduleCreateSchema = z.object({
  name: z.string().min(2),
  unit_amount: z.number().int().positive(),
  frequency: z.nativeEnum(RecurringFrequency),
  starts_on: z.coerce.date(),
  is_active: z.boolean().default(true),
  penalty_policy: optionalPenaltyPolicySchema
});

const recurringScheduleUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  unit_amount: z.number().int().positive().optional(),
  frequency: z.nativeEnum(RecurringFrequency).optional(),
  starts_on: z.coerce.date().optional(),
  is_active: z.boolean().optional(),
  penalty_policy: optionalPenaltyPolicySchema
}).refine((value) => (
  value.name !== undefined
  || value.unit_amount !== undefined
  || value.frequency !== undefined
  || value.starts_on !== undefined
  || value.is_active !== undefined
  || value.penalty_policy !== undefined
), { message: "At least one field is required" });

router.get("/", requireProject, requireRoles("approver", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const items = await prisma.recurringSchedule.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId },
    orderBy: { createdAt: "desc" }
  });

  return ok(res, items.map((item) => ({
    id: item.id,
    name: item.name,
    unit_amount: item.unitAmount,
    frequency: item.frequency,
    starts_on: item.startsOn,
    next_run_at: item.nextRunAt,
    is_active: item.isActive,
    penalty_policy: item.penaltyPolicy,
    last_run_at: item.lastRunAt,
    last_run_status: item.lastRunStatus,
    last_run_message: item.lastRunMessage
  })));
}));

router.post("/", requireProject, requireRoles("approver", "admin"), validateBody(recurringScheduleCreateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof recurringScheduleCreateSchema>;
  const nextRunAt = resolveInitialNextRunAt(body.starts_on, body.frequency);

  const recurring = await prisma.recurringSchedule.create({
    data: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      name: body.name,
      unitAmount: body.unit_amount,
      frequency: body.frequency,
      startsOn: body.starts_on,
      nextRunAt,
      isActive: body.is_active,
      penaltyPolicy: body.penalty_policy,
      createdById: auth.userId
    }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "recurring_schedule.created",
    entityType: "recurring_schedule",
    entityId: recurring.id,
    after: recurring
  });

  return created(res, {
    id: recurring.id,
    name: recurring.name,
    unit_amount: recurring.unitAmount,
    frequency: recurring.frequency,
    starts_on: recurring.startsOn,
    next_run_at: recurring.nextRunAt,
    is_active: recurring.isActive,
    penalty_policy: recurring.penaltyPolicy
  });
}));

router.patch("/:id", requireProject, requireRoles("approver", "admin"), validateParams(idParamSchema), validateBody(recurringScheduleUpdateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof recurringScheduleUpdateSchema>;

  const before = await prisma.recurringSchedule.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Recurring schedule not found");

  const startsOn = body.starts_on ?? before.startsOn;
  const frequency = body.frequency ?? before.frequency;
  const nextRunAt = resolveInitialNextRunAt(startsOn, frequency);

  const recurring = await prisma.recurringSchedule.update({
    where: { id },
    data: {
      name: body.name,
      unitAmount: body.unit_amount,
      frequency,
      startsOn,
      nextRunAt,
      isActive: body.is_active,
      penaltyPolicy: body.penalty_policy
    }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "recurring_schedule.updated",
    entityType: "recurring_schedule",
    entityId: recurring.id,
    before,
    after: recurring
  });

  return ok(res, {
    id: recurring.id,
    name: recurring.name,
    unit_amount: recurring.unitAmount,
    frequency: recurring.frequency,
    starts_on: recurring.startsOn,
    next_run_at: recurring.nextRunAt,
    is_active: recurring.isActive,
    penalty_policy: recurring.penaltyPolicy,
    last_run_at: recurring.lastRunAt,
    last_run_status: recurring.lastRunStatus,
    last_run_message: recurring.lastRunMessage
  });
}));

router.delete("/:id", requireProject, requireRoles("approver", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const before = await prisma.recurringSchedule.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Recurring schedule not found");

  const recurring = await prisma.recurringSchedule.update({
    where: { id },
    data: { isActive: false }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "recurring_schedule.deactivated",
    entityType: "recurring_schedule",
    entityId: recurring.id,
    before,
    after: recurring
  });

  return ok(res, { id: recurring.id, is_active: recurring.isActive });
}));

export { router as recurringSchedulesRouter };
