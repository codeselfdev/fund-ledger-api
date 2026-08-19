import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { MemberStatus, Prisma } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { isSelfOrRole, requireProjectContext } from "../../core/security/auth.context.js";
import { STAFF_ROLES } from "../../core/security/roles.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

const router = Router();
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }
});
const PREVIOUS_INSTALLMENT_SCHEDULE_NAME = "Previous installment";

const memberBodySchema = z.object({
  name: z.string().min(2),
  mobile: z.string().min(6),
  shares: z.number().int().positive(),
  address: z.string().optional(),
  email: z.string().email().optional(),
  previous_due_amount: z.number().int().min(0).optional()
});

const memberUpdateSchema = z.object({
  name: z.string().min(2).optional(),
  mobile: z.string().min(6).optional(),
  shares: z.number().int().positive().optional(),
  address: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  status: z.nativeEnum(MemberStatus).optional()
});

const memberQuerySchema = z.object({
  status: z.nativeEnum(MemberStatus).optional(),
  search: z.string().optional()
});

const memberImportRowSchema = z.object({
  name: z.string().min(2),
  mobile: z.string().min(6),
  shares: z.number().int().positive(),
  address: z.string().optional(),
  email: z.string().email().optional(),
  previous_due_amount: z.number().int().min(0).default(0)
});

type MemberImportRow = z.infer<typeof memberImportRowSchema>;

async function assertShareCap(input: {
  tenantId: string;
  projectId: string;
  shares: number;
  excludeMemberId?: string;
}) {
  const project = await prisma.project.findFirstOrThrow({
    where: { id: input.projectId, tenantId: input.tenantId }
  });
  const aggregate = await prisma.member.aggregate({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      status: "active",
      ...(input.excludeMemberId ? { id: { not: input.excludeMemberId } } : {})
    },
    _sum: { shares: true }
  });

  const total = (aggregate._sum.shares ?? 0) + input.shares;
  if (total > project.totalShares) {
    throw badRequest("Total member shares exceed project share cap", {
      total_shares: project.totalShares,
      requested_total: total
    });
  }
}

function parseCsvLine(line: string) {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseMemberImportCsv(content: string): MemberImportRow[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) throw badRequest("CSV file is empty");

  const lines = normalized.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw badRequest("CSV must include header and at least one data row");

  const headers = parseCsvLine(lines[0]).map((header, idx) => (idx === 0 ? header.replace(/^\ufeff/, "") : header).toLowerCase());
  const headerIndexes = new Map(headers.map((header, idx) => [header, idx]));
  for (const requiredHeader of ["name", "mobile", "shares"]) {
    if (!headerIndexes.has(requiredHeader)) {
      throw badRequest(`CSV missing required column: ${requiredHeader}`);
    }
  }

  const rows: MemberImportRow[] = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const rowNumber = lineIndex + 1;
    const cells = parseCsvLine(lines[lineIndex]);
    const read = (header: string) => {
      const index = headerIndexes.get(header);
      if (index === undefined) return "";
      return (cells[index] ?? "").trim();
    };

    const sharesRaw = read("shares");
    const previousDueRaw = read("previous_due_amount");
    const shares = Number(sharesRaw);
    const previousDue = previousDueRaw === "" ? 0 : Number(previousDueRaw);

    const candidate = {
      name: read("name"),
      mobile: read("mobile"),
      shares,
      address: read("address") || undefined,
      email: read("email") || undefined,
      previous_due_amount: previousDue
    };

    if (!Number.isFinite(shares)) {
      throw badRequest(`Invalid shares value at CSV row ${rowNumber}`);
    }
    if (!Number.isFinite(previousDue)) {
      throw badRequest(`Invalid previous_due_amount at CSV row ${rowNumber}`);
    }

    const parsed = memberImportRowSchema.safeParse(candidate);
    if (!parsed.success) {
      const fields = parsed.error.issues.reduce<Record<string, string>>((acc, issue) => {
        acc[issue.path.join(".") || "value"] = issue.message;
        return acc;
      }, {});
      throw badRequest(`Invalid CSV row ${rowNumber}`, fields);
    }

    rows.push(parsed.data);
  }

  return rows;
}

async function ensurePreviousInstallmentSchedule(tx: Prisma.TransactionClient, input: {
  tenantId: string;
  projectId: string;
  createdById: string;
}) {
  const existing = await tx.schedule.findFirst({
    where: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      name: PREVIOUS_INSTALLMENT_SCHEDULE_NAME
    },
    orderBy: { createdAt: "asc" }
  });
  if (existing) return existing;

  return tx.schedule.create({
    data: {
      tenantId: input.tenantId,
      projectId: input.projectId,
      name: PREVIOUS_INSTALLMENT_SCHEDULE_NAME,
      totalAmount: 0,
      dueDate: new Date(),
      status: "active",
      createdById: input.createdById
    }
  });
}

router.get("/", requireProject, requireRoles("owner", "staff"), validateQuery(memberQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const query = req.query as z.infer<typeof memberQuerySchema>;
  const members = await prisma.member.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? {
        OR: [
          { name: { contains: query.search, mode: "insensitive" } },
          { mobile: { contains: query.search } }
        ]
      } : {})
    },
    orderBy: { createdAt: "desc" }
  });

  const dueTotals = await prisma.due.groupBy({
    by: ["memberId"],
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      memberId: { in: members.map((member) => member.id) }
    },
    _sum: {
      amount: true,
      paidAmount: true,
      penaltyDue: true,
      penaltyPaid: true
    }
  });

  const dueByMember = new Map(dueTotals.map((item) => {
    const totalDue = (item._sum.amount ?? 0) + (item._sum.penaltyDue ?? 0);
    const totalPaid = (item._sum.paidAmount ?? 0) + (item._sum.penaltyPaid ?? 0);
    return [item.memberId, Math.max(0, totalDue - totalPaid)];
  }));

  return ok(res, members.map((member) => ({
    ...member,
    due_amount: dueByMember.get(member.id) ?? 0
  })));
}));

router.get("/import/csv-format", requireProject, requireRoles("owner", "accountant", "admin"), asyncHandler(async (_req, res) => {
  const csv = [
    "name,mobile,shares,address,email,previous_due_amount",
    "Rahim Uddin,+8801711000001,2,Road 12 House 3,rahim@example.com,15000"
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"member-import-format.csv\"");
  return res.status(200).send(csv);
}));

router.post("/import", requireProject, requireRoles("owner", "accountant", "admin"), importUpload.single("file"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  if (!req.file) throw badRequest("CSV file is required (form-data field name: file)");

  const rows = parseMemberImportCsv(req.file.buffer.toString("utf8"));
  if (rows.length === 0) throw badRequest("CSV file has no valid member rows");

  const seenMobiles = new Set<string>();
  for (const row of rows) {
    const mobileKey = row.mobile.trim();
    if (seenMobiles.has(mobileKey)) {
      throw badRequest("CSV contains duplicate mobile numbers", { mobile: mobileKey });
    }
    seenMobiles.add(mobileKey);
  }

  const [project, existingMembers, existingActiveShares] = await Promise.all([
    prisma.project.findFirstOrThrow({ where: { id: auth.projectId, tenantId: auth.tenantId } }),
    prisma.member.findMany({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        mobile: { in: rows.map((row) => row.mobile) }
      },
      select: { mobile: true }
    }),
    prisma.member.aggregate({
      where: { tenantId: auth.tenantId, projectId: auth.projectId, status: "active" },
      _sum: { shares: true }
    })
  ]);

  if (existingMembers.length > 0) {
    throw badRequest("Some member mobile numbers already exist in this project", {
      mobiles: existingMembers.map((member) => member.mobile)
    });
  }

  const importingShares = rows.reduce((sum, row) => sum + row.shares, 0);
  const requestedTotalShares = (existingActiveShares._sum.shares ?? 0) + importingShares;
  if (requestedTotalShares > project.totalShares) {
    throw badRequest("Total member shares exceed project share cap", {
      total_shares: project.totalShares,
      requested_total: requestedTotalShares
    });
  }

  const summary = await prisma.$transaction(async (tx) => {
    const createdMembers: string[] = [];
    let previousInstallmentSchedule: { id: string; dueDate: Date } | null = null;
    let previousDueTotal = 0;

    for (const row of rows) {
      const user = await tx.user.upsert({
        where: {
          tenantId_mobile: {
            tenantId: auth.tenantId,
            mobile: row.mobile
          }
        },
        update: {
          name: row.name,
          email: row.email
        },
        create: {
          tenantId: auth.tenantId,
          name: row.name,
          mobile: row.mobile,
          email: row.email
        }
      });

      const member = await tx.member.create({
        data: {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          userId: user.id,
          name: row.name,
          mobile: row.mobile,
          email: row.email,
          address: row.address,
          shares: row.shares
        }
      });
      createdMembers.push(member.id);

      await tx.projectMembership.upsert({
        where: {
          projectId_userId_role: {
            projectId: auth.projectId,
            userId: user.id,
            role: "member"
          }
        },
        update: { memberId: member.id, isActive: true },
        create: {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          userId: user.id,
          memberId: member.id,
          role: "member"
        }
      });

      if (row.previous_due_amount > 0) {
        if (!previousInstallmentSchedule) {
          const schedule = await ensurePreviousInstallmentSchedule(tx, {
            tenantId: auth.tenantId,
            projectId: auth.projectId,
            createdById: auth.userId
          });
          previousInstallmentSchedule = { id: schedule.id, dueDate: schedule.dueDate };
        }

        await tx.due.create({
          data: {
            tenantId: auth.tenantId,
            projectId: auth.projectId,
            scheduleId: previousInstallmentSchedule.id,
            memberId: member.id,
            amount: row.previous_due_amount,
            dueDate: previousInstallmentSchedule.dueDate,
            status: previousInstallmentSchedule.dueDate.getTime() > Date.now() ? "upcoming" : "due"
          }
        });
        previousDueTotal += row.previous_due_amount;
      }
    }

    if (previousInstallmentSchedule && previousDueTotal > 0) {
      await tx.schedule.update({
        where: { id: previousInstallmentSchedule.id },
        data: { totalAmount: { increment: previousDueTotal } }
      });
    }

    return {
      imported_count: createdMembers.length,
      previous_due_total: previousDueTotal,
      schedule_name: previousInstallmentSchedule ? PREVIOUS_INSTALLMENT_SCHEDULE_NAME : null
    };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member.bulk_imported",
    entityType: "member_import",
    entityId: auth.projectId,
    after: summary
  });

  return created(res, summary);
}));

router.get("/:id", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  if (!isSelfOrRole(auth, id, [...STAFF_ROLES, "owner"])) throw forbidden();

  const member = await prisma.member.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: {
      dues: {
        select: {
          amount: true,
          paidAmount: true,
          penaltyDue: true,
          penaltyPaid: true,
          status: true
        }
      }
    }
  });
  if (!member) throw notFound("Member not found");

  const summary = member.dues.reduce((totals, due) => {
    totals.payable += due.amount + due.penaltyDue;
    totals.paid += due.paidAmount + due.penaltyPaid;
    totals.outstanding += Math.max(0, due.amount + due.penaltyDue - due.paidAmount - due.penaltyPaid);
    return totals;
  }, { payable: 0, paid: 0, outstanding: 0 });

  return ok(res, { ...member, contribution_summary: summary });
}));

router.post("/", requireProject, requireRoles("owner", "accountant", "admin"), validateBody(memberBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof memberBodySchema>;
  await assertShareCap({ tenantId: auth.tenantId, projectId: auth.projectId, shares: body.shares });

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: {
        tenantId_mobile: {
          tenantId: auth.tenantId,
          mobile: body.mobile
        }
      },
      update: {
        name: body.name,
        email: body.email
      },
      create: {
        tenantId: auth.tenantId,
        name: body.name,
        mobile: body.mobile,
        email: body.email
      }
    });

    const member = await tx.member.create({
      data: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        userId: user.id,
        name: body.name,
        mobile: body.mobile,
        email: body.email,
        address: body.address,
        shares: body.shares
      }
    });

    await tx.projectMembership.upsert({
      where: {
        projectId_userId_role: {
          projectId: auth.projectId,
          userId: user.id,
          role: "member"
        }
      },
      update: { memberId: member.id, isActive: true },
      create: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        userId: user.id,
        memberId: member.id,
        role: "member"
      }
    });

    let previousDueScheduleId: string | null = null;
    const previousDueAmount = body.previous_due_amount ?? 0;
    if (previousDueAmount > 0) {
      const schedule = await ensurePreviousInstallmentSchedule(tx, {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        createdById: auth.userId
      });

      await tx.due.create({
        data: {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          scheduleId: schedule.id,
          memberId: member.id,
          amount: previousDueAmount,
          dueDate: schedule.dueDate,
          status: schedule.dueDate.getTime() > Date.now() ? "upcoming" : "due"
        }
      });

      await tx.schedule.update({
        where: { id: schedule.id },
        data: { totalAmount: { increment: previousDueAmount } }
      });
      previousDueScheduleId = schedule.id;
    }

    return { member, previousDueAmount, previousDueScheduleId };
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member.created",
    entityType: "member",
    entityId: result.member.id,
    after: result
  });

  return created(res, {
    ...result.member,
    previous_due_amount: result.previousDueAmount,
    previous_due_schedule_id: result.previousDueScheduleId
  });
}));

router.patch("/:id", requireProject, requireRoles("owner", "accountant", "admin"), validateParams(idParamSchema), validateBody(memberUpdateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof memberUpdateSchema>;
  const before = await prisma.member.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
  });
  if (!before) throw notFound("Member not found");

  if (body.shares) {
    await assertShareCap({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      shares: body.status === "inactive" ? 0 : body.shares,
      excludeMemberId: id
    });
  }

  const member = await prisma.$transaction(async (tx) => {
    const updated = await tx.member.update({
      where: { id },
      data: {
        name: body.name,
        mobile: body.mobile,
        shares: body.shares,
        address: body.address,
        email: body.email,
        status: body.status
      }
    });

    if (body.status === "inactive") {
      await tx.projectMembership.updateMany({
        where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId: id },
        data: { isActive: false }
      });
    }

    return updated;
  });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member.updated",
    entityType: "member",
    entityId: member.id,
    before,
    after: member
  });

  return ok(res, member);
}));

export { router as membersRouter };
