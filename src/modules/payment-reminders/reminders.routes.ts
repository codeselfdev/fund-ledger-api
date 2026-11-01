import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { writeAudit } from "../../core/audit/audit.service.js";
import { conflict, notFound } from "../../core/http/api-error.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { fromInput, ruleSchema, settingsSchema } from "./reminders.policy.js";
import { assertSendLimit, ensureReminderSetup, loadRules, reminderOverview, reminderPreview, reminderProject, rulePayload } from "./reminders.service.js";

/** Owners and admins decide when members/customers with unpaid dues are reminded; accountants can view. */
const router = Router();
const read = requireRoles("owner", "admin", "accountant"), write = requireRoles("owner", "admin");
const ruleParams = z.object({ id: z.string().min(1).max(100) });
const scopeOf = (req: Parameters<typeof requireProjectContext>[0]) => { const a = requireProjectContext(req); return { tenantId: a.tenantId, projectId: a.projectId, userId: a.userId }; };

router.get("/payment-reminders", requireProject, read, asyncHandler(async (req, res) => {
  const { userId: _user, ...scope } = scopeOf(req);
  return ok(res, await reminderOverview(scope));
}));

router.put("/payment-reminders/settings", requireProject, write, validateBody(settingsSchema), asyncHandler(async (req, res) => {
  const { userId, ...scope } = scopeOf(req), body = settingsSchema.parse(req.body);
  const project = await reminderProject(scope);
  const { settings: before } = await ensureReminderSetup(scope);
  if (body.pause_for_promises !== undefined && project.projectType !== "fund_shares") delete body.pause_for_promises;
  const after = await prisma.paymentReminderSettings.update({ where: { projectId: scope.projectId }, data: {
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.preferred_time ? { preferredTime: body.preferred_time } : {}),
    ...(body.sending_days ? { sendingDays: [...new Set(body.sending_days)].sort() } : {}),
    ...(body.off_day_rule ? { offDayRule: body.off_day_rule } : {}),
    ...(body.treat_holidays !== undefined ? { treatHolidays: body.treat_holidays } : {}),
    ...(body.pause_for_promises !== undefined ? { pauseForPromises: body.pause_for_promises } : {}),
    updatedById: userId,
  } });
  await writeAudit({ ...scope, actorUserId: userId, action: "payment_reminders.settings_updated", entityType: "project", entityId: scope.projectId, before, after });
  return ok(res, await reminderOverview(scope));
}));

router.post("/payment-reminders/preview", requireProject, read, validateBody(ruleSchema), asyncHandler(async (req, res) => {
  const { userId: _user, ...scope } = scopeOf(req);
  return ok(res, await reminderPreview(scope, fromInput(ruleSchema.parse(req.body))));
}));

router.post("/payment-reminders/rules", requireProject, write, validateBody(ruleSchema), asyncHandler(async (req, res) => {
  const { userId, ...scope } = scopeOf(req), rule = fromInput(ruleSchema.parse(req.body));
  await reminderProject(scope); await ensureReminderSetup(scope);
  assertSendLimit([...(await loadRules(scope)), rule]);
  try {
    const row = await prisma.paymentReminderRule.create({ data: { ...scope, kind: rule.kind, days: rule.days, ownTime: rule.ownTime, repeatEvery: rule.repeatEvery, repeatCount: rule.repeatCount, message: rule.message, enabled: rule.enabled } });
    await writeAudit({ ...scope, actorUserId: userId, action: "payment_reminders.rule_created", entityType: "payment_reminder_rule", entityId: row.id, after: row });
    return created(res, { rule: rulePayload({ ...rule, id: row.id }), overview: await reminderOverview(scope) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("A reminder already exists for that day. Edit it instead.");
    throw error;
  }
}));

router.put("/payment-reminders/rules/:id", requireProject, write, validateParams(ruleParams), validateBody(ruleSchema), asyncHandler(async (req, res) => {
  const { userId, ...scope } = scopeOf(req), { id } = ruleParams.parse(req.params), rule = fromInput(ruleSchema.parse(req.body));
  await reminderProject(scope);
  const before = await prisma.paymentReminderRule.findFirst({ where: { id, ...scope } });
  if (!before) throw notFound("Reminder not found");
  assertSendLimit([...(await loadRules(scope)).filter(row => row.id !== id), rule]);
  try {
    const after = await prisma.paymentReminderRule.update({ where: { id }, data: { kind: rule.kind, days: rule.days, ownTime: rule.ownTime, repeatEvery: rule.repeatEvery, repeatCount: rule.repeatCount, message: rule.message, enabled: rule.enabled } });
    await writeAudit({ ...scope, actorUserId: userId, action: "payment_reminders.rule_updated", entityType: "payment_reminder_rule", entityId: id, before, after });
    return ok(res, { rule: rulePayload({ ...rule, id }), overview: await reminderOverview(scope) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("A reminder already exists for that day. Edit it instead.");
    throw error;
  }
}));

router.delete("/payment-reminders/rules/:id", requireProject, write, validateParams(ruleParams), asyncHandler(async (req, res) => {
  const { userId, ...scope } = scopeOf(req), { id } = ruleParams.parse(req.params);
  await reminderProject(scope);
  const before = await prisma.paymentReminderRule.findFirst({ where: { id, ...scope } });
  if (!before) throw notFound("Reminder not found");
  await prisma.paymentReminderRule.delete({ where: { id } });
  await writeAudit({ ...scope, actorUserId: userId, action: "payment_reminders.rule_deleted", entityType: "payment_reminder_rule", entityId: id, before });
  return ok(res, await reminderOverview(scope));
}));

export { router as paymentRemindersRouter };
