import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { penaltyPolicySchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateQuery } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();

const policyQuerySchema = z.object({
  schedule_id: z.string().optional(),
  scope: z.enum(["client", "project"]).optional()
});

router.get("/penalty-policy", requireProject, requireRoles("any"), validateQuery(policyQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof policyQuerySchema>;
  const [tenant, project, schedule] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } }),
    prisma.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId } }),
    query.schedule_id
      ? prisma.schedule.findFirst({ where: { id: query.schedule_id, tenantId: auth.tenantId, projectId: auth.projectId } })
      : Promise.resolve(null)
  ]);

  if (query.schedule_id && !schedule) throw notFound("Schedule not found");

  return ok(res, {
    policy: schedule?.penaltyPolicy ?? project.penaltyPolicy ?? tenant.penaltyPolicy ?? {
      enabled: false,
      grace_months: 0
    },
    resolved_from: schedule?.penaltyPolicy ? "schedule" : project.penaltyPolicy ? "project" : tenant.penaltyPolicy ? "client" : "default"
  });
}));

router.put("/penalty-policy", requireProject, requireRoles("owner"), validateQuery(policyQuerySchema), validateBody(penaltyPolicySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof policyQuerySchema>;
  const body = req.body as z.infer<typeof penaltyPolicySchema>;
  const scope = query.scope ?? "project";

  if (scope === "client") {
    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
    const tenant = await prisma.tenant.update({
      where: { id: auth.tenantId },
      data: { penaltyPolicy: body }
    });

    await writeAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      action: "penalty_policy.client_updated",
      entityType: "tenant",
      entityId: auth.tenantId,
      before,
      after: tenant
    });

    return ok(res, tenant.penaltyPolicy);
  }

  if (scope !== "project") throw badRequest("scope must be client or project");
  const before = await prisma.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId } });
  const project = await prisma.project.update({
    where: { id: auth.projectId },
    data: { penaltyPolicy: body }
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "penalty_policy.project_updated",
    entityType: "project",
    entityId: auth.projectId,
    before,
    after: project
  });

  return ok(res, project.penaltyPolicy);
}));

export { router as penaltiesRouter };
