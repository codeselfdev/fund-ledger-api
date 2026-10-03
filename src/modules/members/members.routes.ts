import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { MemberStatus, Prisma } from "@prisma/client";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, forbidden, notFound, serviceUnavailable } from "../../core/http/api-error.js";
import { created, ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { isSelfOrRole, requireProjectContext } from "../../core/security/auth.context.js";
import { STAFF_ROLES } from "../../core/security/roles.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";
import { writeAccountTransactionAudit, writeAudit } from "../../core/audit/audit.service.js";
import { issueOtp } from "../auth/auth.service.js";
import { describeMailFailure } from "../../core/mail/mailer.service.js";
import {
  PROJECT_SIGN_IN_OPTIONS,
  buildProjectInvitationLink,
  buildProjectInvitationSummary,
  resolveAppDownloadLink,
  sendProjectInvitationEmail
} from "../../core/invitations/project-invitation.service.js";
import {
  assertMemberCanExit,
  assertNoActiveManagementRoles,
  calculateDueBalance,
  getMemberSettlement,
  settleMemberBalance
} from "./member-settlement.service.js";

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

const memberSettlementSchema = z.object({
  reason: z.string().min(3).max(500),
  apply_advance_to_dues: z.boolean().default(true),
  write_off_remaining_dues: z.boolean().default(false),
  refund_remaining_advance: z.boolean().default(false)
}).refine((value) =>
  value.apply_advance_to_dues || value.write_off_remaining_dues || value.refund_remaining_advance, {
  message: "Select at least one settlement action"
});

const memberRemovalSchema = z.object({
  reason: z.string().min(3).max(500)
});

const transferTargetSchema = z.object({
  name: z.string().min(2).max(120),
  mobile: z.string().min(6).max(32),
  email: z.string().email().optional(),
  address: z.string().optional()
});

const memberTransferSchema = z.object({
  target_member_id: z.string().min(1).optional(),
  new_member: transferTargetSchema.optional(),
  reason: z.string().min(3).max(500)
}).refine((value) => Boolean(value.target_member_id) !== Boolean(value.new_member), {
  message: "Provide either target_member_id or new_member"
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

  return project;
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
      waivedAmount: true,
      penaltyDue: true,
      penaltyPaid: true
    }
  });

  const dueByMember = new Map(dueTotals.map((item) => {
    const totalDue = (item._sum.amount ?? 0) + (item._sum.penaltyDue ?? 0) - (item._sum.waivedAmount ?? 0);
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
      select: { id: true, mobile: true, status: true, shares: true }
    }),
    prisma.member.aggregate({
      where: { tenantId: auth.tenantId, projectId: auth.projectId, status: "active" },
      _sum: { shares: true }
    })
  ]);

  const existingByMobile = new Map(existingMembers.map((member) => [member.mobile, member]));
  const replacedActiveShares = existingMembers
    .filter((member) => member.status === "active")
    .reduce((sum, member) => sum + member.shares, 0);
  const importingShares = rows.reduce((sum, row) => sum + row.shares, 0);
  const requestedTotalShares = (existingActiveShares._sum.shares ?? 0) - replacedActiveShares + importingShares;
  if (requestedTotalShares > project.totalShares) {
    throw badRequest("Total member shares exceed project share cap", {
      total_shares: project.totalShares,
      requested_total: requestedTotalShares
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    const createdMembers: string[] = [];
    const reactivatedMembers: string[] = [];
    const updatedMembers: string[] = [];
    const invitationCandidates: Array<{
      memberId: string;
      name: string;
      mobile: string;
      email: string;
    }> = [];
    let previousInstallmentSchedule: { id: string; dueDate: Date } | null = null;
    let previousDueTotal = 0;
    let ignoredPreviousDueCount = 0;

    for (const row of rows) {
      const existingMember = existingByMobile.get(row.mobile);
      if (existingMember?.status === "inactive") {
        await assertMemberCanExit(auth.tenantId, auth.projectId, existingMember.id, tx);
      }

      const user = await tx.user.upsert({
        where: {
          tenantId_mobile: {
            tenantId: auth.tenantId,
            mobile: row.mobile
          }
        },
        update: {
          name: row.name,
          email: row.email,
          isActive: true
        },
        create: {
          tenantId: auth.tenantId,
          name: row.name,
          mobile: row.mobile,
          email: row.email
        }
      });

      const member = existingMember
        ? await tx.member.update({
            where: { id: existingMember.id },
            data: {
              userId: user.id,
              name: row.name,
              email: row.email,
              address: row.address,
              shares: row.shares,
              status: "active"
            }
          })
        : await tx.member.create({
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
      if (!existingMember) createdMembers.push(member.id);
      else if (existingMember.status === "inactive") reactivatedMembers.push(member.id);
      else updatedMembers.push(member.id);

      if ((!existingMember || existingMember.status === "inactive") && member.email) {
        invitationCandidates.push({
          memberId: member.id,
          name: member.name,
          mobile: member.mobile,
          email: member.email
        });
      }

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

      if (row.previous_due_amount > 0 && !existingMember) {
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
      } else if (row.previous_due_amount > 0) {
        ignoredPreviousDueCount += 1;
      }
    }

    if (previousInstallmentSchedule && previousDueTotal > 0) {
      await tx.schedule.update({
        where: { id: previousInstallmentSchedule.id },
        data: { totalAmount: { increment: previousDueTotal } }
      });
    }

    return {
      summary: {
        imported_count: rows.length,
        created_count: createdMembers.length,
        reactivated_count: reactivatedMembers.length,
        updated_count: updatedMembers.length,
        created_member_ids: createdMembers,
        reactivated_member_ids: reactivatedMembers,
        updated_member_ids: updatedMembers,
        previous_due_total: previousDueTotal,
        previous_due_ignored_count: ignoredPreviousDueCount,
        schedule_name: previousInstallmentSchedule ? PREVIOUS_INSTALLMENT_SCHEDULE_NAME : null
      },
      invitationCandidates
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  let invitationEmailsSent = 0;
  let invitationEmailsFailed = 0;
  for (const candidate of result.invitationCandidates) {
    const invitationLink = buildProjectInvitationLink(req, {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      role: "member",
      mobile: candidate.mobile,
      email: candidate.email,
      memberId: candidate.memberId
    });
    try {
      const sent = await sendProjectInvitationEmail({
        to: candidate.email,
        inviteeName: candidate.name,
        projectName: project.name,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        role: "member",
        mobile: candidate.mobile,
        email: candidate.email,
        memberId: candidate.memberId,
        invitationLink,
        appDownloadLink: resolveAppDownloadLink(invitationLink)
      });
      if (sent) invitationEmailsSent += 1;
      else invitationEmailsFailed += 1;
    } catch (error) {
      invitationEmailsFailed += 1;
      console.error("[mailer] failed to send member import invitation email", error);
    }
  }

  const responseSummary = {
    ...result.summary,
    invitation_emails_sent: invitationEmailsSent,
    invitation_emails_failed: invitationEmailsFailed
  };

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member.bulk_imported",
    entityType: "member_import",
    entityId: auth.projectId,
    after: responseSummary
  });

  return created(res, responseSummary);
}));

router.get("/:id/settlement", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  if (!isSelfOrRole(auth, id, [...STAFF_ROLES, "owner"])) throw forbidden();
  return ok(res, await getMemberSettlement(auth.tenantId, auth.projectId, id));
}));

router.post("/:id/invitation/resend", requireProject, requireRoles("owner", "accountant", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const member = await prisma.member.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { project: { select: { name: true } } }
  });
  if (!member) throw notFound("Member not found");
  if (!member.email) throw badRequest("Member email is required to send an invitation");

  const otp = await issueOtp(member.mobile, member.email);
  const invitationLink = buildProjectInvitationLink(req, {
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    role: "member",
    mobile: member.mobile,
    email: member.email,
    memberId: member.id
  });
  const appDownloadLink = resolveAppDownloadLink(invitationLink);

  let sent = false;
  let deliveryError: ReturnType<typeof describeMailFailure> | undefined;
  try {
    sent = await sendProjectInvitationEmail({
      to: member.email,
      inviteeName: member.name,
      projectName: member.project.name,
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      role: "member",
      mobile: member.mobile,
      email: member.email,
      memberId: member.id,
      invitationLink,
      appDownloadLink,
      otpEmailed: otp.emailed
    });
    if (!sent) deliveryError = describeMailFailure();
  } catch (error) {
    deliveryError = describeMailFailure(error);
    console.error("[mailer] failed to resend member invitation email", error);
  }

  const delivery = {
    sent,
    to: member.email,
    ...(deliveryError ? { error: deliveryError } : {})
  };
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: sent ? "member.invitation_resent" : "member.invitation_email_failed",
    entityType: "member",
    entityId: member.id,
    after: { delivery }
  });

  if (!sent) {
    throw serviceUnavailable("Member invitation email could not be sent", delivery);
  }

  return ok(res, {
    member_id: member.id,
    invitation_link: invitationLink,
    app_download_link: appDownloadLink,
    invitation_email: delivery,
    sign_in_options: PROJECT_SIGN_IN_OPTIONS
  });
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
          waivedAmount: true,
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
    totals.waived += due.waivedAmount;
    totals.outstanding += calculateDueBalance(due).total;
    return totals;
  }, { payable: 0, paid: 0, waived: 0, outstanding: 0 });

  return ok(res, { ...member, contribution_summary: summary });
}));

router.post("/", requireProject, requireRoles("owner", "accountant", "admin"), validateBody(memberBodySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof memberBodySchema>;
  const project = await assertShareCap({ tenantId: auth.tenantId, projectId: auth.projectId, shares: body.shares });

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

    const otp = await issueOtp(member.mobile, member.email);

    return { user, member, previousDueAmount, previousDueScheduleId, otp };
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

  const memberLink = buildProjectInvitationLink(req, {
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    role: "member",
    mobile: result.user.mobile,
    email: result.user.email,
    memberId: result.member.id
  });
  const appDownloadLink = resolveAppDownloadLink(memberLink);
  let invitationEmailSent = false;
  if (result.user.email) {
    try {
      invitationEmailSent = await sendProjectInvitationEmail({
        to: result.user.email,
        inviteeName: result.user.name,
        projectName: project.name,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        role: "member",
        mobile: result.user.mobile,
        email: result.user.email,
        memberId: result.member.id,
        invitationLink: memberLink,
        appDownloadLink,
        otpEmailed: result.otp.emailed
      });
    } catch (error) {
      console.error("[mailer] failed to send member invitation email", error);
    }
  }

  return created(res, {
    ...result.member,
    previous_due_amount: result.previousDueAmount,
    previous_due_schedule_id: result.previousDueScheduleId,
    otp: {
      sent: true,
      emailed: result.otp.emailed,
      ...(process.env.NODE_ENV === "production" ? {} : { dev_code: result.otp.code })
    },
    memberLink,
    member_link: memberLink,
    appDownloadLink,
    app_download_link: appDownloadLink,
    invitationEmail: {
      sent: invitationEmailSent,
      to: result.user.email
    },
    signInOptions: PROJECT_SIGN_IN_OPTIONS,
    onboardingSummary: buildProjectInvitationSummary({
      inviteeName: result.member.name,
      projectName: project.name,
      role: "member"
    })
  });
}));

router.post("/:id/settle", requireProject, requireRoles("accountant", "admin"), validateParams(idParamSchema), validateBody(memberSettlementSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof memberSettlementSchema>;
  const before = await getMemberSettlement(auth.tenantId, auth.projectId, id);

  const adjustment = await settleMemberBalance({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    memberId: id,
    actorUserId: auth.userId,
    reason: body.reason,
    applyAdvanceToDues: body.apply_advance_to_dues,
    writeOffRemainingDues: body.write_off_remaining_dues,
    refundRemainingAdvance: body.refund_remaining_advance
  });

  for (const refund of adjustment.refundTransactions) {
    await writeAccountTransactionAudit({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      actorUserId: auth.userId,
      transaction: refund.transaction,
      balanceBefore: refund.balanceBefore
    });
  }

  const after = await getMemberSettlement(auth.tenantId, auth.projectId, id);
  const summary = {
    applied_advance: adjustment.applied_advance,
    written_off_principal: adjustment.written_off_principal,
    written_off_penalty: adjustment.written_off_penalty,
    refunded_advance: adjustment.refunded_advance,
    advance_applications: adjustment.advance_applications,
    write_offs: adjustment.write_offs,
    refunds: adjustment.refunds,
    reason: body.reason
  };
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member.balance_settled",
    entityType: "member",
    entityId: id,
    before,
    after: { settlement: after, adjustment: summary }
  });

  return ok(res, { adjustment: summary, settlement: after });
}));

router.post("/:id/remove", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), validateBody(memberRemovalSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof memberRemovalSchema>;
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.member.findFirst({
      where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!before) throw notFound("Member not found");
    if (before.status === "inactive") throw badRequest("Member is already inactive");

    const settlement = await assertMemberCanExit(auth.tenantId, auth.projectId, id, tx);
    await assertNoActiveManagementRoles(auth.tenantId, auth.projectId, id, tx);

    const member = await tx.member.update({
      where: { id },
      data: { status: "inactive", shares: 0 }
    });
    await tx.projectMembership.updateMany({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        memberId: id,
        role: "member"
      },
      data: { isActive: false }
    });
    return { before, member, settlement };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member.removed",
    entityType: "member",
    entityId: id,
    before: result.before,
    after: { member: result.member, reason: body.reason, settlement: result.settlement }
  });

  return ok(res, { member: result.member, settlement: result.settlement, reason: body.reason });
}));

router.post("/:id/transfer", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), validateBody(memberTransferSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof memberTransferSchema>;
  if (body.target_member_id === id) throw badRequest("Source and target member must differ");

  const project = await prisma.project.findFirstOrThrow({
    where: { id: auth.projectId, tenantId: auth.tenantId }
  });
  const result = await prisma.$transaction(async (tx) => {
    const source = await tx.member.findFirst({
      where: { id, tenantId: auth.tenantId, projectId: auth.projectId }
    });
    if (!source) throw notFound("Member not found");
    if (source.status !== "active") throw badRequest("Only an active member can be transferred");

    const settlement = await assertMemberCanExit(auth.tenantId, auth.projectId, id, tx);
    await assertNoActiveManagementRoles(auth.tenantId, auth.projectId, id, tx);

    const existingTarget = body.target_member_id
      ? await tx.member.findFirst({
          where: { id: body.target_member_id, tenantId: auth.tenantId, projectId: auth.projectId }
        })
      : await tx.member.findFirst({
          where: { tenantId: auth.tenantId, projectId: auth.projectId, mobile: body.new_member!.mobile }
        });
    if (body.target_member_id && !existingTarget) throw notFound("Target member not found");
    if (existingTarget?.id === id) throw badRequest("Source and target member must differ");
    if (existingTarget?.status === "inactive") {
      await assertMemberCanExit(auth.tenantId, auth.projectId, existingTarget.id, tx);
      await assertNoActiveManagementRoles(auth.tenantId, auth.projectId, existingTarget.id, tx);
    }

    const identity = body.new_member ?? {
      name: existingTarget!.name,
      mobile: existingTarget!.mobile,
      email: existingTarget!.email ?? undefined,
      address: existingTarget!.address ?? undefined
    };
    let user = existingTarget?.userId
      ? await tx.user.findFirst({ where: { id: existingTarget.userId, tenantId: auth.tenantId } })
      : await tx.user.findFirst({ where: { tenantId: auth.tenantId, mobile: identity.mobile } });
    const userCreated = !user;
    if (!user) {
      user = await tx.user.create({
        data: {
          tenantId: auth.tenantId,
          name: identity.name,
          mobile: identity.mobile,
          email: identity.email
        }
      });
    } else {
      user = await tx.user.update({
        where: { id: user.id },
        data: {
          name: identity.name,
          ...(identity.email ? { email: identity.email } : {})
        }
      });
    }
    if (source.userId === user.id) throw badRequest("Membership cannot be transferred to the same user");

    const target = existingTarget
      ? await tx.member.update({
          where: { id: existingTarget.id },
          data: {
            userId: user.id,
            name: identity.name,
            mobile: identity.mobile,
            email: identity.email,
            address: identity.address,
            shares: { increment: source.shares },
            status: "active"
          }
        })
      : await tx.member.create({
          data: {
            tenantId: auth.tenantId,
            projectId: auth.projectId,
            userId: user.id,
            name: identity.name,
            mobile: identity.mobile,
            email: identity.email,
            address: identity.address,
            shares: source.shares
          }
        });

    const updatedSource = await tx.member.update({
      where: { id },
      data: { status: "inactive", shares: 0 }
    });
    await tx.projectMembership.updateMany({
      where: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        memberId: id,
        role: "member"
      },
      data: { isActive: false }
    });
    await tx.projectMembership.upsert({
      where: {
        projectId_userId_role: {
          projectId: auth.projectId,
          userId: user.id,
          role: "member"
        }
      },
      update: { memberId: target.id, isActive: true },
      create: {
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        userId: user.id,
        memberId: target.id,
        role: "member"
      }
    });
    return { source: updatedSource, sourceBefore: source, target, user, userCreated, settlement };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const otp = await issueOtp(result.user.mobile, result.user.email);
  const invitationLink = buildProjectInvitationLink(req, {
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    role: "member",
    mobile: result.user.mobile,
    email: result.user.email,
    memberId: result.target.id
  });
  const appDownloadLink = resolveAppDownloadLink(invitationLink);
  let invitationEmailSent = false;
  let invitationEmailError: ReturnType<typeof describeMailFailure> | undefined;
  if (result.user.email) {
    try {
      invitationEmailSent = await sendProjectInvitationEmail({
        to: result.user.email,
        inviteeName: result.user.name,
        projectName: project.name,
        tenantId: auth.tenantId,
        projectId: auth.projectId,
        role: "member",
        mobile: result.user.mobile,
        email: result.user.email,
        memberId: result.target.id,
        invitationLink,
        appDownloadLink,
        otpEmailed: otp.emailed
      });
      if (!invitationEmailSent) invitationEmailError = describeMailFailure();
    } catch (error) {
      invitationEmailError = describeMailFailure(error);
      console.error("[mailer] failed to send transferred member invitation email", error);
    }
  }

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "member.membership_transferred",
    entityType: "member_transfer",
    entityId: id,
    before: { member: result.sourceBefore, settlement: result.settlement },
    after: {
      source_member: result.source,
      target_member: result.target,
      target_user_id: result.user.id,
      transferred_shares: result.sourceBefore.shares,
      reason: body.reason
    }
  });

  return created(res, {
    source_member: result.source,
    target_member: result.target,
    transferred_shares: result.sourceBefore.shares,
    user_created: result.userCreated,
    invitation_link: invitationLink,
    app_download_link: appDownloadLink,
    invitation_email: {
      sent: invitationEmailSent,
      to: result.user.email,
      ...(invitationEmailError ? { error: invitationEmailError } : {})
    },
    sign_in_options: PROJECT_SIGN_IN_OPTIONS
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

  if (body.status === "inactive" && before.status !== "inactive") {
    if (!auth.roles.includes("owner") && !auth.roles.includes("admin")) {
      throw forbidden("Only an owner or admin can remove a member");
    }
    await assertMemberCanExit(auth.tenantId, auth.projectId, id);
    await assertNoActiveManagementRoles(auth.tenantId, auth.projectId, id);
  }
  if (body.status === "active" && before.status === "inactive" && body.shares === undefined) {
    throw badRequest("shares is required when reactivating a removed member");
  }

  if (body.shares) {
    await assertShareCap({
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      shares: body.status === "inactive" ? 0 : body.shares,
      excludeMemberId: id
    });
  }

  const member = await prisma.$transaction(async (tx) => {
    if (body.status === "inactive" && before.status !== "inactive") {
      await assertMemberCanExit(auth.tenantId, auth.projectId, id, tx);
      await assertNoActiveManagementRoles(auth.tenantId, auth.projectId, id, tx);
    }

    let updated = await tx.member.update({
      where: { id },
      data: {
        name: body.name,
        mobile: body.mobile,
        shares: body.status === "inactive" ? 0 : body.shares,
        address: body.address,
        email: body.email,
        status: body.status
      }
    });

    let userId = updated.userId;
    if (!userId && body.status === "active") {
      const user = await tx.user.upsert({
        where: {
          tenantId_mobile: {
            tenantId: auth.tenantId,
            mobile: updated.mobile
          }
        },
        update: { name: updated.name, email: updated.email },
        create: {
          tenantId: auth.tenantId,
          name: updated.name,
          mobile: updated.mobile,
          email: updated.email
        }
      });
      userId = user.id;
      updated = await tx.member.update({ where: { id }, data: { userId } });
    } else if (userId && (body.name !== undefined || body.mobile !== undefined || body.email !== undefined)) {
      await tx.user.update({
        where: { id: userId },
        data: {
          name: updated.name,
          mobile: updated.mobile,
          email: updated.email
        }
      });
    }

    if (body.status === "inactive") {
      await tx.projectMembership.updateMany({
        where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId: id, role: "member" },
        data: { isActive: false }
      });
    } else if (body.status === "active" && userId) {
      await tx.projectMembership.upsert({
        where: {
          projectId_userId_role: {
            projectId: auth.projectId,
            userId,
            role: "member"
          }
        },
        update: { memberId: id, isActive: true },
        create: {
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          userId,
          memberId: id,
          role: "member"
        }
      });
    }

    return updated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const auditAction = body.status === "inactive" && before.status !== "inactive"
    ? "member.removed"
    : body.status === "active" && before.status !== "active"
      ? "member.reactivated"
      : "member.updated";

  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: auditAction,
    entityType: "member",
    entityId: member.id,
    before,
    after: member
  });

  return ok(res, member);
}));

export { router as membersRouter };
