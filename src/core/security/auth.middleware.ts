import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "@prisma/client";
import { prisma } from "../prisma/client.js";
import { forbidden, unauthorized } from "../http/api-error.js";
import { hashToken, verifyAccessToken } from "./jwt.js";
import { hasAnyRole, type RoleGate } from "./roles.js";
import { ensureUserProjectMember } from "./member-link.service.js";

function bearerToken(req: Request) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) throw unauthorized();

    const payload = verifyAccessToken(token);
    const session = await prisma.session.findFirst({
      where: {
        id: payload.sessionId,
        userId: payload.userId,
        tenantId: payload.tenantId,
        tokenHash: hashToken(token),
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      include: { user: true }
    });

    if (!session || !session.user.isActive) {
      throw unauthorized("Invalid or expired session");
    }

    const requestedProjectId = req.header("x-project-id") ?? session.activeProjectId;
    let roles: Role[] = [];
    let memberId: string | null = null;

    if (requestedProjectId) {
      const memberships = await prisma.projectMembership.findMany({
        where: {
          tenantId: session.tenantId,
          projectId: requestedProjectId,
          userId: session.userId,
          isActive: true
        }
      });

      if (memberships.length === 0) {
        throw forbidden("No active role for this project");
      }

      roles = memberships.map((membership) => membership.role);
      const hasMemberRole = memberships.some((membership) => membership.role === "member");
      const linkedMember = memberships.find((membership) => membership.memberId);
      memberId = linkedMember?.memberId ?? null;

      if (!memberId || !hasMemberRole) {
        const ensured = await prisma.$transaction((tx) => ensureUserProjectMember(tx, {
          tenantId: session.tenantId,
          projectId: requestedProjectId,
          user: {
            id: session.userId,
            name: session.user.name,
            mobile: session.user.mobile,
            email: session.user.email
          },
          defaultShares: 0
        }));
        memberId = ensured.memberId;
        if (!roles.includes("member")) roles.push("member");
      }

      // Treat owner and admin as full-access management roles everywhere.
      if (roles.includes("owner") && !roles.includes("admin")) roles.push("admin");
      if (roles.includes("admin") && !roles.includes("owner")) roles.push("owner");
    }

    req.auth = {
      sessionId: session.id,
      userId: session.userId,
      tenantId: session.tenantId,
      projectId: requestedProjectId ?? null,
      roles,
      memberId
    };

    next();
  } catch (error) {
    next(error);
  }
};

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthorized());
  return next();
}

export function requireProject(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth?.projectId) return next(forbidden("An active project is required"));
  return next();
}

export function requireRoles(...gates: RoleGate[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(unauthorized());
    if (req.auth.roles.includes("owner") || req.auth.roles.includes("admin")) return next();
    if (gates.includes("any")) return next();
    if (hasAnyRole(req.auth.roles, gates)) return next();
    return next(forbidden());
  };
}
