import { Router } from "express";
import { z } from "zod";
import { DueStatus } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { isSelfOrRole, requireProjectContext } from "../../core/security/auth.context.js";
import { STAFF_ROLES } from "../../core/security/roles.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";

const router = Router();

const duesQuerySchema = z.object({
  status: z.nativeEnum(DueStatus).optional()
});

const waivePenaltySchema = z.object({
  reason: z.string().min(3)
});

function requireMember(auth: { memberId: string | null }) {
  if (!auth.memberId) throw forbidden("A linked member record is required");
  return auth.memberId;
}

router.get("/me/dues", requireProject, requireRoles("member"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const memberId = requireMember(auth);
  const dues = await prisma.due.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId },
    include: { schedule: true },
    orderBy: { dueDate: "asc" }
  });

  return ok(res, dues.map((due) => ({
    ...due,
    outstanding: Math.max(0, due.amount + due.penaltyDue - due.paidAmount - due.penaltyPaid)
  })));
}));

router.get("/me/summary", requireProject, requireRoles("member"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const memberId = requireMember(auth);

  const [member, dues, deposits] = await Promise.all([
    prisma.member.findFirstOrThrow({ where: { id: memberId, tenantId: auth.tenantId, projectId: auth.projectId } }),
    prisma.due.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId } }),
    prisma.deposit.findMany({ where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId } })
  ]);

  const verifiedContribution = deposits
    .filter((deposit) => deposit.status === "confirmed")
    .reduce((sum, deposit) => sum + deposit.amount, 0);
  const pending = deposits
    .filter((deposit) => deposit.status === "pending_accountant" || deposit.status === "pending_approver")
    .reduce((sum, deposit) => sum + deposit.amount, 0);
  const outstanding = dues.reduce((sum, due) =>
    sum + Math.max(0, due.amount + due.penaltyDue - due.paidAmount - due.penaltyPaid), 0);
  const penaltyDue = dues.reduce((sum, due) => sum + Math.max(0, due.penaltyDue - due.penaltyPaid), 0);
  const project = await prisma.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId } });

  return ok(res, {
    verified_contribution: verifiedContribution,
    pending,
    outstanding,
    penalty_due: penaltyDue,
    share_percent: project.totalShares === 0 ? 0 : (member.shares / project.totalShares) * 100
  });
}));

router.get("/dues", requireProject, requireRoles("staff"), validateQuery(duesQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof duesQuerySchema>;
  const dues = await prisma.due.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.status ? { status: query.status } : {})
    },
    include: { member: true, schedule: true },
    orderBy: { dueDate: "asc" }
  });

  return ok(res, dues);
}));

router.get("/dues/:id/penalty", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const due = await prisma.due.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { penalties: true }
  });
  if (!due) throw notFound("Due not found");
  if (!isSelfOrRole(auth, due.memberId, STAFF_ROLES)) throw forbidden();

  return ok(res, {
    due_id: due.id,
    penalty_due: due.penaltyDue,
    penalty_paid: due.penaltyPaid,
    current_total: Math.max(0, due.penaltyDue - due.penaltyPaid),
    next_accrual_date: null,
    lines: due.penalties
  });
}));

router.post("/dues/:id/penalty/waive", requireProject, requireRoles("approver"), validateParams(idParamSchema), validateBody(waivePenaltySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof waivePenaltySchema>;
  const due = await prisma.due.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!due) throw notFound("Due not found");
  if (due.penaltyDue <= due.penaltyPaid) throw badRequest("No outstanding penalty to waive");

  const before = due;
  const updated = await prisma.$transaction(async (tx) => {
    await tx.duePenaltyEntry.updateMany({
      where: { tenantId: auth.tenantId, projectId: auth.projectId, dueId: id, waivedAt: null },
      data: { waivedAt: new Date(), waivedById: auth.userId, reason: body.reason }
    });

    return tx.due.update({
      where: { id },
      data: {
        penaltyDue: due.penaltyPaid,
        status: due.paidAmount >= due.amount ? "paid" : due.status
      }
    });
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "due.penalty_waived",
    entityType: "due",
    entityId: id,
    before,
    after: { due: updated, reason: body.reason }
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    memberIds: [due.memberId],
    type: "due.penalty_waived",
    title: "Penalty waived",
    body: "An accrued penalty was waived on your due.",
    entityType: "due",
    entityId: id
  });

  return ok(res, updated);
}));

export { router as duesRouter };
