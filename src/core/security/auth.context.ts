import type { Request } from "express";
import type { Role } from "@prisma/client";
import { forbidden, unauthorized } from "../http/api-error.js";

export function requireAuthContext(req: Request) {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireProjectContext(req: Request) {
  const auth = requireAuthContext(req);
  if (!auth.projectId) throw forbidden("An active project is required");
  return auth as typeof auth & { projectId: string };
}

export function isSelfOrRole(auth: { memberId: string | null; roles: Role[] }, memberId: string, roles: Role[]) {
  return auth.memberId === memberId || auth.roles.some((role) => roles.includes(role));
}
