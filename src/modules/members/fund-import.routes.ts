import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { created, ok } from "../../core/http/response.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";
import { buildProjectInvitationLink, resolveAppDownloadLink, sendProjectInvitationEmail } from "../../core/invitations/project-invitation.service.js";
import { commitFundImport, fundImportSchema, previewFundImport } from "./fund-import.service.js";
const router = Router();
router.use(requireProject, requireRoles("owner", "admin", "accountant"));
router.post("/preview", validateBody(fundImportSchema), asyncHandler(async (req, res) => {
  return ok(res, await previewFundImport(requireProjectContext(req), fundImportSchema.parse(req.body)));
}));
const commitSchema = fundImportSchema.and(z.object({ review_token: z.string().length(64), confirm: z.literal(true) }));
router.post("/", validateBody(commitSchema), asyncHandler(async (req, res) => {
  const context = requireProjectContext(req), body = commitSchema.parse(req.body);
  const saved = await commitFundImport(context, fundImportSchema.parse(body), body.review_token);
  let sent = 0, failed = 0;
  for (const row of saved.invitations) {
    const invitationLink = buildProjectInvitationLink(req, { ...row, tenantId: context.tenantId, projectId: context.projectId, role: "member" });
    try {
      const success = await sendProjectInvitationEmail({ to: row.email, inviteeName: row.name, projectName: saved.projectName, tenantId: context.tenantId, projectId: context.projectId, role: "member", ...row, invitationLink, appDownloadLink: resolveAppDownloadLink(invitationLink) });
      if (success) sent++; else failed++;
    } catch { failed++; }
  }
  return created(res, { ...saved.result, ...(!("replayed" in saved.result) ? { invitation_emails_sent: sent, invitation_emails_failed: failed } : {}) });
}));
export { router as fundImportRouter };
