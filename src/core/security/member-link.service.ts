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

export async function ensureUserProjectMember(
  tx: Prisma.TransactionClient,
  input: EnsureUserProjectMemberInput
) {
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
    member = await tx.member.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        userId: input.user.id,
        name: input.user.name,
        mobile: input.user.mobile,
        email: input.user.email ?? undefined,
        shares: input.defaultShares ?? 0,
        status: "active"
      }
    });
  } else {
    member = await tx.member.update({
      where: { id: member.id },
      data: {
        userId: input.user.id,
        status: "active",
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

  return { memberId: member.id };
}
