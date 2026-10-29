import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, notFound, serviceUnavailable } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { buildProjectInvitationLink, resolveAppDownloadLink, sendProjectInvitationEmail } from "../../core/invitations/project-invitation.service.js";
import { env } from "../../config/env.js";

const router = Router();
router.get("/:id/invitation", requireProject, requireRoles("owner", "admin"), asyncHandler(async (req, res) => {
  const a = requireProjectContext(req);
  const member = await prisma.member.findFirst({ where: { id: req.params.id, tenantId: a.tenantId, projectId: a.projectId } });
  if (!member) throw notFound("Member not found");
  const [seen, last] = await Promise.all([
    member.userId ? prisma.appInstallation.findFirst({ where: { tenantId: a.tenantId, userId: member.userId, platform: { in: ["android", "ios"] } }, orderBy: { firstSeenAt: "asc" } }) : null,
    prisma.activity.findFirst({ where: { tenantId: a.tenantId, projectId: a.projectId, action: "member.email_invitation", entityId: member.id }, orderBy: { createdAt: "desc" } }),
  ]);
  return ok(res, { email: member.email, first_app_seen_at: seen?.firstSeenAt ?? null, last_invitation: last?.after ?? null });
}));
router.post("/:id/invitation", requireProject, requireRoles("owner", "admin"), rateLimit({ windowMs: 60000, limit: 10 }), asyncHandler(async (req, res) => {
  const b = z.object({ request_key: z.string().uuid() }).strict().parse(req.body), a = requireProjectContext(req);
  if (!env.smtp.user || !env.smtp.pass) throw serviceUnavailable("Invitation email is not configured. Ask Fund Nesta support to configure email delivery.");
  const id = `member-invite:${createHash("sha256").update(JSON.stringify([a.tenantId, a.projectId, req.params.id, b.request_key])).digest("hex")}`;
  const prepared = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM members WHERE id = ${req.params.id} AND tenant_id = ${a.tenantId} AND project_id = ${a.projectId} FOR UPDATE`;
    const member = await tx.member.findFirst({ where: { id: req.params.id, tenantId: a.tenantId, projectId: a.projectId, status: "active" } });
    if (!member) throw notFound("Active member not found");
    const email = z.string().email().safeParse(member.email?.trim());
    if (!email.success) throw badRequest("Save a valid member email in Personal information before sending an invitation");
    const old = await tx.activity.findUnique({ where: { id } });
    if (old) {
      const saved = old.after as { email?: string; status?: string };
      if (saved.email !== email.data) throw conflict("Member email changed. Refresh and send a new invitation.");
      return { replay: saved, member, projectName: "" };
    }
    const recent = await tx.activity.findFirst({ where: { tenantId: a.tenantId, projectId: a.projectId, action: "member.email_invitation", entityId: member.id, createdAt: { gt: new Date(Date.now() - 60000) } } });
    if (recent) throw conflict("An invitation was requested recently. Wait a minute before resending.");
    let user = member.userId ? await tenantAccounts(tx).findFirst({ where: { id: member.userId, tenantId: a.tenantId } }) : await tenantAccounts(tx).findUnique({ where: { tenantId_mobile: { tenantId: a.tenantId, mobile: member.mobile } } });
    if (user?.email && user.email.toLowerCase() !== email.data.toLowerCase()) throw conflict("Member and login account emails differ. Update the linked account before inviting.");
    if (!user) user = await tenantAccounts(tx).create({ data: { tenantId: a.tenantId, name: member.name, mobile: member.mobile, email: email.data } });
    else user = await tenantAccounts(tx).update({ where: { id: user.id }, data: { email: email.data, isActive: true } });
    await tx.member.update({ where: { id: member.id }, data: { userId: user.id } });
    await tx.projectMembership.upsert({ where: { projectId_userId_role: { projectId: a.projectId, userId: user.id, role: "member" } }, update: { isActive: true }, create: { tenantId: a.tenantId, projectId: a.projectId, userId: user.id, memberId: member.id, role: "member" } });
    const project = await tx.project.findFirstOrThrow({ where: { id: a.projectId, tenantId: a.tenantId } });
    await tx.activity.create({ data: { id, tenantId: a.tenantId, projectId: a.projectId, actorUserId: a.userId, action: "member.email_invitation", entityType: "member", entityId: member.id, after: { email: email.data, status: "sending", requested_at: new Date().toISOString() } } });
    return { replay: null, member: { ...member, email: email.data }, projectName: project.name };
  });
  if (prepared.replay) return ok(res, { ...prepared.replay, replayed: true });
  const member = prepared.member;
  const invitationLink = buildProjectInvitationLink(req, { tenantId: a.tenantId, projectId: a.projectId, role: "member", memberId: member.id, email: member.email, mobile: member.mobile });
  let sent = false;
  try { sent = await sendProjectInvitationEmail({ tenantId: a.tenantId, projectId: a.projectId, role: "member", memberId: member.id, to: member.email!, email: member.email, mobile: member.mobile, inviteeName: member.name, projectName: prepared.projectName, invitationLink, appDownloadLink: env.app.downloadUrl ?? "https://play.google.com/store/apps/details?id=com.fundnesta.appnesta.app" }); }
  catch { sent = false; }
  const result = { email: member.email!, status: sent ? "sent" : "failed", requested_at: new Date().toISOString() };
  await prisma.activity.update({ where: { id }, data: { after: result } });
  return ok(res, result);
}));
export { router as memberInvitationRouter };
