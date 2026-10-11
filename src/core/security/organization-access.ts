import type { RequestHandler } from "express";
import { prisma } from "../prisma/client.js";
import { forbidden } from "../http/api-error.js";
import { requireAuthContext } from "./auth.context.js";

export const requireOrganizationManagement: RequestHandler = async (req, _res, next) => {
  try {
    const auth = requireAuthContext(req);
    const setup = await prisma.onboardingProgress.findUnique({
      where: { tenantId: auth.tenantId }, select: { projectId: true }
    });
    const original = setup?.projectId ? { id: setup.projectId } : await prisma.project.findFirst({
      where: { tenantId: auth.tenantId }, orderBy: { createdAt: "asc" }, select: { id: true }
    });
    if (!original) throw forbidden("Organization administration is required");
    const access = await prisma.projectMembership.findFirst({
      where: { tenantId: auth.tenantId, projectId: original.id, userId: auth.userId,
        isActive: true, role: { in: ["owner", "admin"] } }
    });
    if (!access) throw forbidden("Organization administration is required");
    next();
  } catch (error) { next(error); }
};
