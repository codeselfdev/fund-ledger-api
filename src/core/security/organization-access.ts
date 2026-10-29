import type { RequestHandler } from "express";
import type { Prisma } from "@prisma/client";
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


/** The original organization's owner pays; a project-level admin/owner is not its payer. */
export async function organizationBillingProject(tenantId: string, db: Prisma.TransactionClient = prisma) {
  const setup = await db.onboardingProgress.findUnique({where:{tenantId},select:{projectId:true}});
  return setup?.projectId ?? (await db.project.findFirst({where:{tenantId},orderBy:{createdAt:"asc"},select:{id:true}}))?.id ?? null;
}
export async function isOrganizationOwner(tenantId: string, userId: string, db: Prisma.TransactionClient = prisma) {
  const projectId = await organizationBillingProject(tenantId, db);
  return Boolean(projectId && await db.projectMembership.findFirst({where:{tenantId,projectId,userId,isActive:true,role:"owner"}}));
}
export const requireOrganizationOwnership: RequestHandler = async (req, _res, next) => {
  try {
    const auth = requireAuthContext(req);
    if (!await isOrganizationOwner(auth.tenantId,auth.userId)) throw forbidden("Only the organization owner can create its projects or manage its subscription.");
    next();
  } catch(error) { next(error); }
};
