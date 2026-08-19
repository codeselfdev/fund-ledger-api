import { Prisma, ScheduleStatus } from "@prisma/client";
import { badRequest } from "../../core/http/api-error.js";
import { prisma } from "../../core/prisma/client.js";
import { ensureUserProjectMember } from "../../core/security/member-link.service.js";

type CreateScheduleWithUnitAmountInput = {
  tenantId: string;
  projectId: string;
  name: string;
  unitAmount: number;
  dueDate: Date;
  status: ScheduleStatus;
  penaltyPolicy?: unknown;
  createdById: string;
  recurringScheduleId?: string;
};

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function applyAdvanceToNewDues(tx: Prisma.TransactionClient, input: {
  tenantId: string;
  projectId: string;
  scheduleId: string;
  dues: Array<{ id: string; memberId: string; amount: number }>;
}) {
  const memberIds = [...new Set(input.dues.map((due) => due.memberId))];
  if (memberIds.length === 0) return { autoAppliedTotal: 0 };

  const advances = await tx.deposit.findMany({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      status: "confirmed",
      allocate: "advance",
      memberId: { in: memberIds }
    },
    include: { allocations: { select: { amount: true } } },
    orderBy: { createdAt: "asc" }
  });

  const advancesByMember = new Map<string, Array<{ id: string; remaining: number }>>();
  for (const advance of advances) {
    const consumed = advance.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    const remaining = Math.max(0, advance.amount - consumed);
    if (remaining <= 0) continue;
    const list = advancesByMember.get(advance.memberId) ?? [];
    list.push({ id: advance.id, remaining });
    advancesByMember.set(advance.memberId, list);
  }

  let autoAppliedTotal = 0;
  for (const due of input.dues) {
    const memberAdvances = advancesByMember.get(due.memberId) ?? [];
    if (memberAdvances.length === 0) continue;

    let dueRemaining = due.amount;
    let appliedForDue = 0;
    for (const advance of memberAdvances) {
      if (dueRemaining <= 0) break;
      if (advance.remaining <= 0) continue;

      const applied = Math.min(dueRemaining, advance.remaining);
      if (applied <= 0) continue;
      advance.remaining -= applied;
      dueRemaining -= applied;
      appliedForDue += applied;
      autoAppliedTotal += applied;

      await tx.depositAllocation.create({
        data: {
          tenantId: input.tenantId,
          projectId: input.projectId,
          depositId: advance.id,
          dueId: due.id,
          scheduleId: input.scheduleId,
          amount: applied
        }
      });
    }

    if (appliedForDue > 0) {
      await tx.due.update({
        where: { id: due.id },
        data: {
          paidAmount: { increment: appliedForDue },
          status: dueRemaining <= 0 ? "paid" : "partial"
        }
      });
    }
  }

  return { autoAppliedTotal };
}

export async function createScheduleWithUnitAmount(input: CreateScheduleWithUnitAmountInput) {
  const dueStatus = input.dueDate.getTime() > Date.now() ? "upcoming" : "due";

  const result = await prisma.$transaction(async (tx) => {
    const activeUsers = await tx.projectMembership.findMany({
      where: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        isActive: true
      },
      distinct: ["userId"],
      select: {
        user: {
          select: {
            id: true,
            name: true,
            mobile: true,
            email: true
          }
        }
      }
    });

    for (const activeUser of activeUsers) {
      await ensureUserProjectMember(tx, {
        tenantId: input.tenantId,
        projectId: input.projectId,
        user: activeUser.user,
        defaultShares: 0
      });
    }

    const activeMembers = await tx.member.findMany({
      where: { tenantId: input.tenantId, projectId: input.projectId, status: "active" },
      orderBy: { createdAt: "asc" },
      select: { id: true }
    });
    if (activeMembers.length === 0) throw badRequest("At least one active member is required");

    const totalAmount = input.unitAmount * activeMembers.length;
    const schedule = await tx.schedule.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        recurringScheduleId: input.recurringScheduleId,
        name: input.name,
        unitAmount: input.unitAmount,
        totalAmount,
        dueDate: input.dueDate,
        status: input.status,
        penaltyPolicy: toJsonValue(input.penaltyPolicy),
        createdById: input.createdById
      }
    });

    const dues = await Promise.all(activeMembers.map((member) => tx.due.create({
      data: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        scheduleId: schedule.id,
        memberId: member.id,
        amount: input.unitAmount,
        dueDate: input.dueDate,
        status: dueStatus
      },
      select: { id: true, memberId: true, amount: true }
    })));

    const autoApplied = await applyAdvanceToNewDues(tx, {
      tenantId: input.tenantId,
      projectId: input.projectId,
      scheduleId: schedule.id,
      dues
    });

    return {
      schedule,
      duesCreated: dues.length,
      autoAppliedTotal: autoApplied.autoAppliedTotal
    };
  });

  return result;
}
