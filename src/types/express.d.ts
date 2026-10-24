import type { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        impersonation?: { actorUserId: string; parentSessionId: string; expiresAt: string; reason: string | null };
        sessionId: string;
        userId: string;
        tenantId: string;
        projectId: string | null;
        sessionProjectId?: string | null;
        roles: Role[];
        memberId: string | null;
        memberIds?: string[];
      };
    }
  }
}

export {};
