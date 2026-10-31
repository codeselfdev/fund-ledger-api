import multer from "multer";
import { uploadPromotionalPoster } from "./promotional-poster.service.js";
import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { prisma } from "../../core/prisma/client.js";
import { requireInternalApiKey, internalActor } from "../../core/security/internal-api-key.middleware.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { badRequest, conflict, notFound } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { tenantQuota } from "../../core/subscription/quota.service.js";
import { assistantStatus } from "../assistant/assistant.service.js";
import { buildSupportRouter } from "../support/support.routes.js";
import { overallUsage, tenantSummaries, summariesFor } from "./monitoring.service.js";
import { manualPaymentSchema, recordManualPayment } from "./payments.service.js";
import { organizationWorkbook } from "./export.service.js";
import { beginCleanup, cleanupPreview, runCleanup } from "./cleanup.service.js";
import { customerDetails } from "./customers.service.js";
import { platformAlerts, retryPlatformAlert } from "./alerts.service.js";
import { deletionRequests, deletionRequest, reviewDeletionRequest, deletionPreview, executeAccountDeletion } from './account-deletion.service.js';
import { billingRequests, billingRequestCounts } from './billing-requests.service.js';
import { broadcastDraftSchema, broadcastSendSchema, platformBroadcasts } from './platform-broadcasts.service.js';
import { appGuideTokenUsage } from '../app-guide/app-guide.service.js';
import { aiCreditGrantSchema, grantAiCredits, aiCreditTenants, aiCreditHistory, aiCreditSortFields } from './ai-credits.service.js';
const router = Router();
router.use(requireInternalApiKey, rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const page = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), search: z.string().trim().max(120).optional() });
router.use("/support", buildSupportRouter(true));
const posterUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 999999, files: 1, fields: 0, parts: 2 } }).single('file');
router.post('/notifications/poster', rateLimit({ windowMs: 60000, limit: 10 }), (req, res, next) => {
  internalActor(req);
  posterUpload(req, res, error => error ? next(badRequest('Choose one JPG, PNG or WebP poster below 1 MB.')) : next());
}, asyncHandler(async (req, res) => {
  if (!req.file) throw badRequest('Choose a poster image.');
  return ok(res, await uploadPromotionalPoster(internalActor(req), req.file.buffer));
}));
router.get('/app-guide/usage', asyncHandler(async (req, res) => ok(res, await appGuideTokenUsage(z.coerce.number().int().min(1).max(366).catch(30).parse(req.query.days)))));
router.get('/notifications/audience', asyncHandler(async (_req, res) => ok(res, await platformBroadcasts.reach())));
router.get('/notifications/users', asyncHandler(async (req, res) => {
  internalActor(req);
  const { search } = z.object({ search: z.string().trim().min(2).max(100) }).parse(req.query);
  return ok(res, await platformBroadcasts.searchUsers(search));
}));
router.post('/notifications/preview', asyncHandler(async (req, res) => ok(res, await platformBroadcasts.preview(internalActor(req), broadcastDraftSchema.parse(req.body)))));
router.post('/notifications', rateLimit({ windowMs: 60000, limit: 5 }), asyncHandler(async (req, res) => ok(res, await platformBroadcasts.send(internalActor(req), broadcastSendSchema.parse(req.body)))));
router.get('/notifications', asyncHandler(async (req, res) => {
    const q = page.parse(req.query);
    return ok(res, await platformBroadcasts.history(q.offset));
}));
router.post('/notifications/:id/retry', asyncHandler(async (req, res) => ok(res, await platformBroadcasts.retry(internalActor(req), String(req.params.id)))));
router.get('/account-deletion-requests', asyncHandler(async (req, res) => {
    const q = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), status: z.enum(['pending', 'in_review', 'needs_information', 'processing', 'processing_failed', 'completed', 'rejected']).optional() }).parse(req.query);
    return ok(res, await deletionRequests(q.offset, q.status));
}));
router.get('/account-deletion-requests/:id', asyncHandler(async (req, res) => ok(res, await deletionRequest(String(req.params.id)))));
router.get('/account-deletion-requests/:id/preview', asyncHandler(async (req, res) => ok(res, await deletionPreview(String(req.params.id)))));
router.post('/account-deletion-requests/:id/delete', asyncHandler(async (req, res) => {
    const input = z.object({ identity_verified: z.literal(true), confirmation: z.string().max(200), retention_note: z.string().trim().min(20).max(2000) }).strict().parse(req.body);
    return ok(res, await executeAccountDeletion(String(req.params.id), input, internalActor(req)));
}));
router.post('/account-deletion-requests/:id/review', asyncHandler(async (req, res) => {
    const input = z.object({ status: z.enum(['in_review', 'needs_information']), expected_status: z.enum(['pending', 'in_review', 'needs_information']), note: z.string().trim().min(3).max(2000) }).strict().parse(req.body);
    return ok(res, await reviewDeletionRequest(String(req.params.id), input, internalActor(req)));
}));
router.get('/billing-requests/counts', asyncHandler(async (_req, res) => ok(res, await billingRequestCounts())));
router.get('/billing-requests', asyncHandler(async (req, res) => {
    const q = page.extend({ status: z.enum(['open', 'submitted']).optional() }).parse(req.query);
    return ok(res, await billingRequests(q.offset, q.status, q.search));
}));
router.get("/alerts", asyncHandler(async (req, res) => { const q = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), unread: z.enum(["true", "false"]).optional(), kind: z.enum(["signup", "support_message", "account_deletion", "billing_upgrade", "billing_payment"]).optional() }).parse(req.query); return ok(res, await platformAlerts(q.offset, q.unread === "true", q.kind)); }));
router.post("/alerts/:id/read", asyncHandler(async (req, res) => { internalActor(req); const row = await prisma.platformAlert.updateMany({ where: { id: String(req.params.id) }, data: { readAt: new Date() } }); if (!row.count)
    throw notFound("Alert not found"); return ok(res, { read: true }); }));
router.post("/alerts/:id/retry", asyncHandler(async(req,res) => { internalActor(req); return ok(res,await retryPlatformAlert(String(req.params.id))); }));
router.get("/summary", asyncHandler(async (_req, res) => ok(res, await overallUsage())));
router.get('/ai-credits', asyncHandler(async (req, res) => {
    const q = page.extend({ sort: z.enum(aiCreditSortFields).default('used'), direction: z.enum(['asc', 'desc']).default('desc') }).parse(req.query);
    return ok(res, await aiCreditTenants(q.offset, q.search, q.sort, q.direction));
}));
router.get('/tenants/:id/ai-credits', asyncHandler(async (req, res) => {
    const q = page.parse(req.query);
    return ok(res, await aiCreditHistory(String(req.params.id), q.offset));
}));
router.post('/tenants/:id/ai-credits', asyncHandler(async (req, res) =>
    ok(res, await grantAiCredits(String(req.params.id), aiCreditGrantSchema.parse(req.body), internalActor(req)))));
router.get("/tenants", asyncHandler(async (req, res) => { const q = page.parse(req.query); return ok(res, await tenantSummaries(q.offset, q.search)); }));
router.get("/tenants/:id", asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({ include: { subscription: true }, where: { id: String(req.params.id) } });
    if (!tenant)
        throw notFound("Organization not found");
    const [summary, quota, assistant] = await Promise.all([summariesFor([tenant]), tenantQuota(tenant.id), assistantStatus(tenant.id)]);
    const [customer, projects] = await Promise.all([customerDetails(tenant.id), prisma.project.findMany({ where: { tenantId: tenant.id }, select: { id: true, name: true, totalShares: true, projectType: true, isActive: true } })]);
    return ok(res, { ...summary[0], quota, assistant, customer, projects });
}));
router.get("/tenants/:id/payments", asyncHandler(async (req, res) => {
    const q = page.parse(req.query), rows = await prisma.platformPayment.findMany({ where: { tenantId: String(req.params.id) }, orderBy: [{ paidAt: "desc" }, { id: "desc" }], skip: q.offset, take: 51 });
    return ok(res, { payments: rows.slice(0, 50), next_offset: rows.length > 50 ? q.offset + 50 : null });
}));
router.post("/tenants/:id/payments", asyncHandler(async (req, res) => ok(res, await recordManualPayment(String(req.params.id), manualPaymentSchema.parse(req.body), internalActor(req)))));
router.get("/tenants/:id/export.xlsx", rateLimit({ windowMs: 60000, limit: 5 }), asyncHandler(async (req, res) => {
    const actor = internalActor(req), q = z.object({ project_id: z.string().min(1).max(100).optional() }).parse(req.query), id = String(req.params.id);
    const file = await organizationWorkbook(id, q.project_id);
    await prisma.internalAudit.create({ data: { tenantId: id, actor, action: "tenant.exported", metadata: { project_id: q.project_id ?? null, bytes: file.buffer.length } } });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.send(file.buffer);
}));
router.post("/tenants/:id/cleanup", asyncHandler(async (req, res) => {
    const b = z.object({ dry_run: z.boolean().default(true), confirm: z.boolean().optional(), preview_token: z.string().max(2000).optional(), confirmation: z.string().max(200).optional() }).strict().parse(req.body ?? {});
    if (b.dry_run)
        return ok(res, await cleanupPreview(String(req.params.id)));
    if (b.confirm !== true || !b.preview_token || !b.confirmation)
        throw badRequest("Review a dry run and provide confirm, preview_token and the exact organization confirmation");
    return ok(res, await beginCleanup(String(req.params.id), b.preview_token, b.confirmation, internalActor(req)));
}));
router.get("/cleanup-jobs/:id", asyncHandler(async (req, res) => { const job = await prisma.tenantDeletionJob.findUnique({ where: { id: String(req.params.id) } }); if (!job)
    throw notFound("Cleanup job not found"); return ok(res, job); }));
router.post("/cleanup-jobs/:id/run", asyncHandler(async (req, res) => ok(res, await runCleanup(String(req.params.id), internalActor(req)))));
export { router as internalRouter };
