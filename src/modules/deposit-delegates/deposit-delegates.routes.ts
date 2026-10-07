import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";
import { canUserPayOnBehalf, listDepositDelegatePermissions, upsertDepositDelegatePermission } from "../../core/security/deposit-delegate.service.js";
import { calculateDueBalance } from "../members/member-settlement.service.js";

const router = Router();

const delegateUpsertSchema = z.object({
  user_id: z.string().min(1).optional(),
  payer_member_id: z.string().min(1).optional(),
  beneficiary_member_id: z.string().min(1),
  is_active: z.boolean().default(true)
}).refine((value) => Boolean(value.user_id || value.payer_member_id), {
  message: "Either user_id or payer_member_id is required"
});

const delegatePatchSchema = z.object({
  is_active: z.boolean()
});

router.get("/deposit-delegates", requireProject, requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });

  const permissions = listDepositDelegatePermissions(tenant.contact, auth.projectId);
  const userIds = [...new Set(permissions.map((permission) => permission.user_id))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({
      where: { tenantId: auth.tenantId, id: { in: userIds } },
      select: { id: true, name: true, mobile: true, email: true, isActive: true }
    })
    : [];
  const memberships = userIds.length > 0
    ? await prisma.projectMembership.findMany({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        role: "member",
        isActive: true,
        userId: { in: userIds }
      },
      select: {
        userId: true,
        member: { select: { id: true, name: true, mobile: true, status: true } }
      }
    })
    : [];
  const userById = new Map(users.map((user) => [user.id, user]));
  const memberByUserId = new Map(memberships.map((membership) => [membership.userId, membership.member]));
  const beneficiaryIds = [...new Set(permissions.map((permission) => permission.beneficiary_member_id).filter((id): id is string => !!id))];
  const beneficiaries = beneficiaryIds.length > 0
    ? await prisma.member.findMany({
        where: { tenantId: auth.tenantId, projectId: auth.projectId, id: { in: beneficiaryIds } },
        select: { id: true, name: true, mobile: true, status: true }
      })
    : [];
  const beneficiaryById = new Map(beneficiaries.map((member) => [member.id, member]));

  return ok(res, permissions.map((permission) => ({
    ...permission,
    user: userById.get(permission.user_id) ?? null,
    member: memberByUserId.get(permission.user_id) ?? null,
    beneficiary: permission.beneficiary_member_id ? beneficiaryById.get(permission.beneficiary_member_id) ?? null : null
  })));
}));

router.get("/deposit-delegates/payable-members", requireProject, requireRoles("member", "accountant", "cashier", "admin"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const staffAccess = auth.roles.some((role) => role === "admin" || role === "accountant" || role === "cashier");
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { contact: true } });
  const permissions = listDepositDelegatePermissions(tenant.contact, auth.projectId)
    .filter((permission) => permission.user_id === auth.userId && permission.is_active);
  const canSeeAll = staffAccess || permissions.some((permission) => permission.beneficiary_member_id === null);
  const allowedIds = permissions
    .map((permission) => permission.beneficiary_member_id)
    .filter((id): id is string => !!id);
  if (!canSeeAll && allowedIds.length === 0) return ok(res, []);

  const members = await prisma.member.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      status: "active",
      ...(!canSeeAll ? { id: { in: allowedIds } } : {})
    },
    select: { id: true, name: true, mobile: true },
    orderBy: { name: "asc" }
  });
  const dues = members.length > 0 ? await prisma.due.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId: { in: members.map((member) => member.id) } }
  }) : [];
  const outstandingByMember = new Map<string, number>();
  for (const due of dues) {
    outstandingByMember.set(due.memberId, (outstandingByMember.get(due.memberId) ?? 0) + calculateDueBalance(due).total);
  }
  return ok(res, members.map((member) => ({ ...member, due_amount: outstandingByMember.get(member.id) ?? 0 })));
}));

router.get("/deposit-delegates/payable-members/:id/dues", requireProject, requireRoles("member", "accountant", "cashier", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const staffAccess = auth.roles.some((role) => role === "admin" || role === "accountant" || role === "cashier");
  if (!staffAccess && auth.memberId !== id) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { contact: true } });
    if (!canUserPayOnBehalf(tenant.contact, auth.projectId, auth.userId, id)) throw forbidden();
  }
  const member = await prisma.member.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId, status: "active" } });
  if (!member) throw notFound("Member not found");
  const dues = await prisma.due.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId: id },
    include: { schedule: true },
    orderBy: { dueDate: "asc" }
  });
  return ok(res, dues.map((due) => ({ ...due, outstanding: calculateDueBalance(due).total })));
}));

router.post("/deposit-delegates", requireProject, requireRoles("owner", "admin"), validateBody(delegateUpsertSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof delegateUpsertSchema>;

  const membership = await prisma.projectMembership.findFirst({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      role: "member",
      isActive: true,
      ...(body.user_id ? { userId: body.user_id } : {}),
      ...(body.payer_member_id ? { memberId: body.payer_member_id } : {})
    },
    include: { member: true, user: true }
  });
  if (!membership || !membership.user.isActive || membership.member?.status !== "active") {
    throw badRequest("Delegate permission can only be granted to an active member user in this project");
  }
  const beneficiary = await prisma.member.findFirst({
    where: { id: body.beneficiary_member_id, tenantId: auth.tenantId, projectId: auth.projectId, status: "active" }
  });
  if (!beneficiary) throw badRequest("Choose an active beneficiary member in this project");
  if (membership.memberId === beneficiary.id) throw badRequest("A member does not need delegation to pay their own dues");

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });
  const updated = upsertDepositDelegatePermission({
    contact: tenant.contact,
    projectId: auth.projectId,
    userId: membership.userId,
    beneficiaryMemberId: beneficiary.id,
    actorUserId: auth.userId,
    isActive: body.is_active
  });

  await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: updated.contact }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "deposit_delegate.upserted",
    entityType: "deposit_delegate",
    entityId: updated.permission.id,
    after: updated.permission
  });

  return created(res, updated.permission);
}));

router.patch("/deposit-delegates/:id", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), validateBody(delegatePatchSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof delegatePatchSchema>;

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { contact: true }
  });
  const permissions = listDepositDelegatePermissions(tenant.contact, auth.projectId);
  const target = permissions.find((permission) => permission.id === id);
  if (!target) throw notFound("Delegate permission not found");
  if (target.beneficiary_member_id === null && body.is_active) {
    throw badRequest("Project-wide legacy access cannot be re-enabled. Create a member link instead");
  }
  if (body.is_active) {
    const [payerMembership, beneficiary] = await Promise.all([
      prisma.projectMembership.findFirst({
        where: { tenantId: auth.tenantId, projectId: auth.projectId, userId: target.user_id, role: "member", isActive: true },
        include: { member: true, user: true }
      }),
      prisma.member.findFirst({
        where: { id: target.beneficiary_member_id!, tenantId: auth.tenantId, projectId: auth.projectId, status: "active" }
      })
    ]);
    if (!payerMembership?.user.isActive || payerMembership.member?.status !== "active" || !beneficiary) {
      throw badRequest("Both linked members must be active before enabling this permission");
    }
  }

  const updated = upsertDepositDelegatePermission({
    contact: tenant.contact,
    projectId: auth.projectId,
    userId: target.user_id,
    beneficiaryMemberId: target.beneficiary_member_id,
    actorUserId: auth.userId,
    isActive: body.is_active
  });

  await prisma.tenant.update({
    where: { id: auth.tenantId },
    data: { contact: updated.contact }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "deposit_delegate.updated",
    entityType: "deposit_delegate",
    entityId: updated.permission.id,
    before: target,
    after: updated.permission
  });

  return ok(res, updated.permission);
}));

export { router as depositDelegatesRouter };
