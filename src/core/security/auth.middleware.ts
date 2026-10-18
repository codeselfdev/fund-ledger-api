import { recordUserActivity } from "./client-activity.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Role } from "@prisma/client";
import { prisma } from "../prisma/client.js";
import { forbidden, unauthorized } from "../http/api-error.js";
import { hashToken, verifyAccessToken } from "./jwt.js";
import { hasAnyRole, type RoleGate } from "./roles.js";
import { ensureUserProjectMember } from "./member-link.service.js";
import { effectiveProjectRoles } from "./project-access.js";

function bearerToken(req: Request) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function authenticateSession(resolveProject: boolean): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = bearerToken(req);
      if (!token) throw unauthorized();

      let payload: ReturnType<typeof verifyAccessToken>;
      try { payload = verifyAccessToken(token); }
      catch { throw unauthorized("Invalid or expired session"); }
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

      const requestedProjectId = resolveProject ? (req.header("x-project-id") ?? session.activeProjectId) : null;
      let roles: Role[] = [];
      let memberId: string | null = null;
      let memberIds: string[] = [];

      if (requestedProjectId) {
        const memberships = await prisma.projectMembership.findMany({
          where: {
            tenantId: session.tenantId,
            projectId: requestedProjectId,
            userId: session.userId,
            isActive: true,
            project: { isActive: true }
          }
        });

        if (memberships.length === 0) {
          throw forbidden("No active role for this project");
        }

        roles = memberships.map((membership) => membership.role);
        const hasMemberRole = memberships.some((membership) => membership.role === "member");
        const linkedMember = memberships.find((membership) => membership.role === "member" && membership.memberId);
        memberId = linkedMember?.memberId ?? null;

        // Repair a missing link only for users explicitly assigned the member role.
        // Management/access roles must never create a financial Member record.
        if (hasMemberRole && !memberId) {
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
        }

        if (hasMemberRole) {
          const owned = await prisma.member.findMany({ where: { tenantId: session.tenantId, projectId: requestedProjectId, userId: session.userId, status: "active" }, select: { id: true } });
          memberIds = owned.map(row => row.id);
          const requestedMemberId = req.header("x-member-id");
          if (requestedMemberId) {
            if (!memberIds.includes(requestedMemberId)) throw forbidden("This share record does not belong to your account");
            memberId = requestedMemberId;
          }
        }

        // Permissions belong only to the requested project's active memberships.
        roles = effectiveProjectRoles(roles);
      }

      await recordUserActivity(session.userId, session.user.lastActiveAt);

      req.auth = {
        sessionId: session.id,
        userId: session.userId,
        tenantId: session.tenantId,
        projectId: requestedProjectId ?? null,
        sessionProjectId: session.activeProjectId ?? null,
        roles,
        memberIds,
        memberId
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}

export const authenticate = authenticateSession(true);
// Privacy requests must work even after project access or a subscription ends.
export const authenticateAccount = authenticateSession(false);

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
