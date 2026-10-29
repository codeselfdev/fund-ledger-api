import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../core/prisma/client.js";
import { badRequest, conflict } from "../../core/http/api-error.js";

const money = z.number().int().min(0).max(2147483647);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`); return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Choose a valid installment date");
export const fundImportSchema = z.object({
  request_id: z.string().uuid(),
  installment_name: z.string().trim().min(2).max(120),
  as_of_date: calendarDate,
  current_installment_due_date: calendarDate.optional(),
  rows: z.array(z.object({
    member_id: z.string().trim().min(1).max(100).optional(), advance_amount: money.optional(),
    serial: z.string().trim().max(100), mid: z.string().trim().min(1).max(100),
    name: z.string().trim().min(2).max(160), mobile: z.string().regex(/^\+[1-9]\d{6,14}$/),
    email: z.union([z.literal(""), z.string().trim().email().max(254)]), shares: z.number().int().min(0).max(2147483647),
    previous_due_amount: money, current_installment_amount: money, total_due_amount: money,
    previous_paid_amount: money, total_paid_amount: money, comment: z.string().max(2000),
  })).min(1).max(10000),
}).refine(input => !input.current_installment_due_date || input.current_installment_due_date >= input.as_of_date, {
  message: "Current installment due date must be on or after the start date", path: ["current_installment_due_date"],
});
export type FundImportInput = z.infer<typeof fundImportSchema>;
export interface FundImportContext { tenantId: string; projectId: string; userId: string }
type Db = Prisma.TransactionClient;
const mobileKey = (value: string) => {
  const clean = value.trim().replace(/[\s().-]/g, "");
  if (/^01\d{9}$/.test(clean)) return `+88${clean}`;
  if (/^1\d{9}$/.test(clean)) return `+880${clean}`;
  if (clean.startsWith("00")) return `+${clean.slice(2)}`;
  return clean.startsWith("+") ? clean : `+${clean}`;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validateFundRows(input: FundImportInput) {
  const mids = new Set<string>(), memberIds = new Set<string>(), emails = new Map<string, string>();
  for (const [i, row] of input.rows.entries()) {
    if (!row.member_id && row.shares < 1) throw badRequest(`Row ${i + 1}: new members need at least one share.`);
    if (row.member_id && memberIds.has(row.member_id)) throw badRequest(`Row ${i + 1}: a saved member can only appear once.`);
    if (row.member_id) memberIds.add(row.member_id);
    const mid = row.mid.toLowerCase();
    if (mids.has(mid)) throw badRequest(`Row ${i + 1}: MID must be unique. Repeated mobiles are allowed with different MIDs.`);
    mids.add(mid);
    const email = row.email.toLowerCase();
    if (email && emails.has(row.mobile) && emails.get(row.mobile) !== email) throw badRequest(`Row ${i + 1}: share rows using the same mobile must use the same email or leave it blank.`);
    if (email) emails.set(row.mobile, email);
    const currentPaid = row.previous_due_amount + row.current_installment_amount - row.total_due_amount;
    if (currentPaid < 0 || currentPaid > row.current_installment_amount) throw badRequest(`Row ${i + 1}: total due does not reconcile with previous due and the current installment.`);
    if (row.total_paid_amount !== row.previous_paid_amount + currentPaid) throw badRequest(`Row ${i + 1}: cumulative paid does not reconcile with previous paid.`);
    if (row.previous_due_amount + row.previous_paid_amount > 2147483647) throw badRequest(`Row ${i + 1}: previous installment amount is too large.`);
  }
}
export function fundImportSummary(input: FundImportInput) {
  const sum = (key: "shares" | "previous_due_amount" | "current_installment_amount" | "total_due_amount" | "previous_paid_amount" | "total_paid_amount") => input.rows.reduce((n, row) => n + row[key], 0);
  return { members: input.rows.length, shares: sum("shares"), previous_due: sum("previous_due_amount"), current_installment: sum("current_installment_amount"), total_due: sum("total_due_amount"), previous_paid: sum("previous_paid_amount"), current_paid: sum("previous_due_amount") + sum("current_installment_amount") - sum("total_due_amount"), total_paid: sum("total_paid_amount"), advance: input.rows.reduce((total, row) => total + (row.advance_amount ?? 0), 0), email_invitations: new Set(input.rows.filter(row => row.email).map(row => `${row.mobile}:${row.email.toLowerCase()}`)).size };
}
async function plan(db: Db, context: FundImportContext, input: FundImportInput) {
  validateFundRows(input);
  const scope = { tenantId: context.tenantId, projectId: context.projectId };
  const [project, members, dues, schedules, deposits] = await Promise.all([
    db.project.findFirstOrThrow({ where: { id: context.projectId, tenantId: context.tenantId } }),
    db.member.findMany({ where: scope, orderBy: { createdAt: "asc" } }),
    db.due.count({ where: scope }), db.schedule.count({ where: scope }), db.deposit.count({ where: scope }),
  ]);
  if (project.projectType !== "fund_shares") throw badRequest("Existing-fund import is available for Fund / Shares projects.");
  if (dues || schedules || deposits) throw conflict("Opening history can only be imported before this fund has schedules, dues or deposits. Existing balances will not be overwritten.");
  const used = new Set<string>();
  const matches = input.rows.map(row => {
    let member;
    if (row.member_id) {
      member = members.find(item => item.id === row.member_id && item.status === "active");
      if (!member || used.has(member.id)) throw badRequest("A saved member is missing, inactive or included more than once. Reload the members and review again.");
      if (mobileKey(member.mobile) !== mobileKey(row.mobile) || member.shares !== row.shares || (member.mid && member.mid !== row.mid)) throw conflict("A saved member changed after loading. Reload the members and review again.");
      if (members.some(item => item.id !== member!.id && item.mid?.toLowerCase() === row.mid.toLowerCase())) throw conflict("This MID belongs to another saved member.");
    } else {
      member = members.find(item => !used.has(item.id) && item.mid === row.mid)
        ?? members.find(item => !used.has(item.id) && !item.mid && mobileKey(item.mobile) === mobileKey(row.mobile) && item.status === "active");
    }
    if (member) used.add(member.id);
    return member ?? null;
  });
  const summary = fundImportSummary(input);
  const assigned = summary.shares + members.filter(member => member.status === "active" && !used.has(member.id)).reduce((n, member) => n + member.shares, 0);
  if (!Number.isSafeInteger(assigned) || assigned > project.totalShares) throw badRequest(`The file would assign ${assigned} shares; this project's limit is ${project.totalShares}.`);
  if (summary.previous_due + summary.previous_paid > 2147483647 || summary.current_installment > 2147483647) throw badRequest("The opening schedule total exceeds the supported amount range.");
  const reviewToken = hash({ context: scope, input, project: [project.totalShares, project.updatedAt], members: members.map(member => [member.id, member.mid, member.shares, member.updatedAt]) });
  return { summary, matches, project, assigned_shares: assigned, review_token: reviewToken, existing_members: used.size, matched_member_ids: [...used] };
}
export async function previewFundImport(context: FundImportContext, input: FundImportInput) {
  const result = await plan(prisma, context, input);
  return { current_installment_start_date: input.as_of_date, current_installment_due_date: input.current_installment_due_date ?? input.as_of_date, review_token: result.review_token, summary: result.summary, existing_members: result.existing_members, matched_member_ids: result.matched_member_ids };
}
export async function commitFundImport(context: FundImportContext, input: FundImportInput, reviewToken: string) {
  const id = `fund-import:${hash([context.tenantId, context.projectId, input.request_id])}`;
  const digest = hash(input);
  const replay = async () => {
    const record = await prisma.activity.findUnique({ where: { id } });
    if (!record) return null;
    const saved = record.after as { digest?: string; result?: Record<string, unknown> };
    if (saved?.digest !== digest) throw conflict("This import request was already used with different rows. Review the file again.");
    return { result: { ...saved.result, replayed: true }, invitations: [], projectName: "" };
  };
  const previous = await replay(); if (previous) return previous;
  try {
    return await prisma.$transaction(async tx => {
      const prepared = await plan(tx, context, input);
      if (prepared.review_token !== reviewToken) throw conflict("The file or project changed after review. Review the import again.");
      await tx.activity.create({ data: { id, tenantId: context.tenantId, projectId: context.projectId, actorUserId: context.userId, action: "fund.opening_imported", entityType: "fund_import", entityId: input.request_id, after: { digest } } });
      const startDate = new Date(`${input.as_of_date}T00:00:00Z`);
      const dueDate = new Date(`${input.current_installment_due_date ?? input.as_of_date}T00:00:00Z`), previousDate = new Date(startDate.getTime() - 86400000);
      const previousTotal = prepared.summary.previous_paid + prepared.summary.previous_due;
      const previousSchedule = previousTotal ? await tx.schedule.create({ data: {
        tenantId: context.tenantId, projectId: context.projectId, name: "Opening history before current installment", totalAmount: previousTotal,
        dueDate: previousDate, purpose: "previous_installment", status: "active", createdById: context.userId,
      } }) : null;
      const currentSchedule = await tx.schedule.create({ data: {
        tenantId: context.tenantId, projectId: context.projectId, name: input.installment_name, totalAmount: prepared.summary.current_installment,
        dueDate, purpose: "contribution", status: "active", createdById: context.userId,
      } });
      const users = new Map<string, string>(), invited = new Set<string>();
      const invitations: { memberId: string; name: string; mobile: string; email: string }[] = [];
      const ids: string[] = [];
      for (const [index, row] of input.rows.entries()) {
        const existing = prepared.matches[index];
        let userId = existing?.userId ?? users.get(row.mobile);
        if (!userId) {
          const email = input.rows.find(item => item.mobile === row.mobile && item.email)?.email || undefined;
          const user = await tx.user.upsert({ where: { tenantId_mobile: { tenantId: context.tenantId, mobile: row.mobile } },
            update: { ...(email ? { email } : {}), isActive: true }, create: { tenantId: context.tenantId, name: row.name, mobile: row.mobile, email } });
          userId = user.id; users.set(row.mobile, user.id);
        }
        users.set(row.mobile, userId);
        const oldProfile = existing?.profile && typeof existing.profile === "object" && !Array.isArray(existing.profile) ? existing.profile : {};
        const data = { userId, mid: row.mid, name: row.name, mobile: existing?.mobile ?? row.mobile, email: row.email || null, shares: row.shares, status: "active" as const,
          profile: { ...oldProfile, opening_import: { request_id: input.request_id, as_of_date: input.as_of_date, current_installment_start_date: input.as_of_date, current_installment_due_date: input.current_installment_due_date ?? input.as_of_date, serial: row.serial, comment: row.comment, previous_paid: row.previous_paid_amount, current_paid: row.total_paid_amount - row.previous_paid_amount, total_paid: row.total_paid_amount, advance_amount: row.advance_amount ?? 0 } } };
        const member = existing ? await tx.member.update({ where: { id: existing.id }, data }) : await tx.member.create({ data: { ...data, tenantId: context.tenantId, projectId: context.projectId } });
        ids.push(member.id);
        // One login can own several distinct share/member records. Keep its first
        // link stable; authorization resolves all records owned by that user.
        await tx.projectMembership.upsert({ where: { projectId_userId_role: { projectId: context.projectId, userId, role: "member" } },
          update: { isActive: true }, create: { tenantId: context.tenantId, projectId: context.projectId, userId, role: "member", memberId: member.id } });
        const makeDue = async (scheduleId: string, amount: number, paidAmount: number, date: Date) => {
          if (!amount) return;
          await tx.due.create({ data: { tenantId: context.tenantId, projectId: context.projectId, memberId: member.id, scheduleId, amount, paidAmount,
            dueDate: date, paidAt: paidAmount === amount ? date : null, status: paidAmount === amount ? "paid" : date.getTime() > Date.now() ? "upcoming" : "due" } });
        };
        if (previousSchedule) await makeDue(previousSchedule.id, row.previous_due_amount + row.previous_paid_amount, row.previous_paid_amount, previousDate);
        await makeDue(currentSchedule.id, row.current_installment_amount, row.total_paid_amount - row.previous_paid_amount, dueDate);
        if ((row.advance_amount ?? 0) > 0) {
          // Historical credit is available to future installments, without
          // posting money to an account or creating a new payment receipt.
          await tx.deposit.create({ data: {
            tenantId: context.tenantId, projectId: context.projectId, memberId: member.id,
            amount: row.advance_amount!, method: "cash", allocate: "advance", status: "confirmed",
            submittedById: context.userId, confirmedAt: dueDate,
            reference: `Opening advance from fund import ${input.request_id}`,
          } });
        }
        if (row.email && !invited.has(`${row.mobile}:${row.email.toLowerCase()}`)) {
          invited.add(`${row.mobile}:${row.email.toLowerCase()}`); invitations.push({ memberId: member.id, name: row.name, mobile: row.mobile, email: row.email });
        }
      }
      if (prepared.project.totalShares > 0 && prepared.assigned_shares >= prepared.project.totalShares) {
        await tx.onboardingProgress.updateMany({ where: { tenantId: context.tenantId, projectId: context.projectId, shareholdersStepStatus: "pending" }, data: { shareholdersStepStatus: "done" } });
      }
      const result = { imported_count: ids.length, member_ids: ids, summary: prepared.summary, current_schedule_id: currentSchedule.id, invitation_emails_sent: 0, invitation_emails_failed: 0 };
      await tx.activity.update({ where: { id }, data: { after: JSON.parse(JSON.stringify({ digest, result })) } });
      return { result, invitations, projectName: prepared.project.name };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120000 });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") { const saved = await replay(); if (saved) return saved; }
    throw error;
  }
}
