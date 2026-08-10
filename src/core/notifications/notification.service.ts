import type { Role } from "@prisma/client";
import { prisma } from "../prisma/client.js";
import { sendPushMessage } from "./fcm.service.js";

type NotificationInput = {
  tenantId: string;
  projectId?: string | null;
  actorUserId?: string | null;
  type: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  roles?: Role[];
  memberIds?: string[];
};

export async function getRoleEmails(tenantId: string, projectId: string, roles: Role[]): Promise<string[]> {
  const memberships = await prisma.projectMembership.findMany({
    where: { tenantId, projectId, isActive: true, role: { in: roles } },
    include: { user: { select: { email: true } } }
  });

  return [...new Set(
    memberships
      .map((membership) => membership.user.email)
      .filter((email): email is string => !!email)
  )];
}

export async function notifyProjectMembers(input: NotificationInput) {
  const memberships = input.projectId
    ? await prisma.projectMembership.findMany({
        where: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          isActive: true,
          ...(input.roles?.length ? { role: { in: input.roles } } : {}),
          ...(input.memberIds?.length ? { memberId: { in: input.memberIds } } : {})
        },
        select: { userId: true }
      })
    : await prisma.user.findMany({
        where: {
          tenantId: input.tenantId,
          isActive: true
        },
        select: { id: true }
      }).then((users) => users.map((user) => ({ userId: user.id })));

  const recipientUserIds = [...new Set(
    memberships
      .map((membership) => membership.userId)
      .filter((userId) => userId !== input.actorUserId)
  )];

  if (recipientUserIds.length === 0) return { count: 0 };

  const created = await prisma.notification.createMany({
    data: recipientUserIds.map((recipientUserId) => ({
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      recipientUserId,
      actorUserId: input.actorUserId ?? null,
      type: input.type,
      title: input.title,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId
    }))
  });

  const usersWithToken = await prisma.user.findMany({
    where: {
      tenantId: input.tenantId,
      id: { in: recipientUserIds },
      isActive: true,
      deviceId: { not: null }
    },
    select: { deviceId: true }
  });

  try {
    const push = await sendPushMessage({
      tokens: usersWithToken.map((user) => user.deviceId ?? "").filter((token) => token.length > 0),
      title: input.title,
      body: input.body,
      data: {
        type: input.type,
        tenant_id: input.tenantId,
        project_id: input.projectId ?? "",
        entity_type: input.entityType ?? "",
        entity_id: input.entityId ?? ""
      }
    });

    if (push.invalid_tokens.length > 0) {
      await prisma.user.updateMany({
        where: {
          tenantId: input.tenantId,
          deviceId: { in: push.invalid_tokens }
        },
        data: { deviceId: null }
      });
    }
  } catch (error) {
    console.error("[notifications] failed to send FCM push", error);
  }

  return created;
}
