import type { Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { calculateDueBalance } from "../members/member-settlement.service.js";

type DueReader = Pick<Prisma.TransactionClient, "due">;

export async function getMemberOutstanding(
  tenantId: string,
  projectId: string,
  memberId: string,
  db: DueReader = prisma
) {
  const dues = await db.due.findMany({
    where: {
      tenantId,
      projectId,
      memberId,
      status: { notIn: ["paid", "waived"] }
    },
    select: {
      amount: true,
      paidAmount: true,
      waivedAmount: true,
      penaltyDue: true,
      penaltyPaid: true
    }
  });
  return dues.reduce((sum, due) => sum + calculateDueBalance(due).total, 0);
}
