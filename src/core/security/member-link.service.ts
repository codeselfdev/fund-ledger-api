import type { Prisma } from "@prisma/client";

type EnsureUserProjectMemberInput = {
  tenantId: string;
  projectId: string;
  user: {
    id: string;
    name: string;
    mobile: string;
    email?: string | null;
  };
  defaultShares?: number;
};

function normalizeShares(value: number | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value as number));
}

async function resolveSeedShares(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; projectId: string },
  desiredShares: number,
  excludeMemberId?: string
) {
  if (desiredShares <= 0) return 0;

  const project = await tx.project.findFirst({
    where: { id: input.projectId, tenantId: input.tenantId },
    select: { totalShares: true }
  });
  if (!project) return 0;

  const aggregate = await tx.member.aggregate({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      status: "active",
      ...(excludeMemberId ? { id: { not: excludeMemberId } } : {})
    },
    _sum: { shares: true }
  });
  const currentlyAssigned = aggregate._sum.shares ?? 0;
  return currentlyAssigned + desiredShares <= project.totalShares ? desiredShares : 0;
}

export async function ensureUserProjectMember(
  tx: Prisma.TransactionClient,
  input: EnsureUserProjectMemberInput
) {
  const desiredSeedShares = normalizeShares(input.defaultShares);
  let member = await tx.member.findFirst({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.user.id
    }
  });

  if (!member) {
    member = await tx.member.findFirst({
      where: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        mobile: input.user.mobile
      }
    });
  }

  if (!member) {
    const seededShares = await resolveSeedShares(tx, {
      tenantId: input.tenantId,
      projectId: input.projectId
    }, desiredSeedShares);

    member = await tx.member.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.user.id,
        name: input.user.name,
        mobile: input.user.mobile,
        email: input.user.email ?? undefined,
        shares: seededShares,
        status: "active"
      }
    });
  } else {
    const promotedShares = desiredSeedShares > member.shares
      ? await resolveSeedShares(tx, {
        tenantId: input.tenantId,
        projectId: input.projectId
      }, desiredSeedShares, member.id)
      : member.shares;

    member = await tx.member.update({
      where: { id: member.id },
      data: {
        userId: input.user.id,
        status: "active",
        ...(promotedShares > member.shares ? { shares: promotedShares } : {}),
        ...(member.email ? {} : { email: input.user.email ?? undefined })
      }
    });
  }

  await tx.projectMembership.upsert({
    where: {
      projectId_userId_role: {
        projectId: input.projectId,
        userId: input.user.id,
        role: "member"
      }
    },
    update: {
      memberId: member.id,
      isActive: true
    },
    create: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.user.id,
      role: "member",
      memberId: member.id
    }
  });

  await tx.projectMembership.updateMany({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.user.id,
      memberId: null
    },
    data: { memberId: member.id }
  });

  return { memberId: member.id, shares: member.shares };
}
