import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma/client.js";

type AuditInput = {
  tenantId: string;
  projectId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
};

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function writeAudit(input: AuditInput) {
  return prisma.activity.create({
    data: {
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      before: toJson(input.before),
      after: toJson(input.after)
    }
  });
}
