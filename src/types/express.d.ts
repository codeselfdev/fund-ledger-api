import type { Role } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        sessionId: string;
        userId: string;
        tenantId: string;
        projectId: string | null;
        roles: Role[];
        memberId: string | null;
      };
    }
  }
}

export {};
