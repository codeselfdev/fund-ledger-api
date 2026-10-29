import { subscriptionContext } from "../../core/subscription/subscription.repository.js";
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { authenticateAccount } from '../../core/security/auth.middleware.js';
import { requireMasterSession } from '../../core/security/impersonation-policy.js';
import { requireMasterAdmin, unlockMasterAdmin } from '../../core/security/master-admin.policy.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { notFound } from '../../core/http/api-error.js';
import { internalActor } from '../../core/security/internal-api-key.middleware.js';
import { buildSupportRouter } from '../support/support.routes.js';
import { billingRequests, billingRequestCounts } from '../internal/billing-requests.service.js';
import { listInvoices, reviewInvoicePayment } from '../subscription/billing.service.js';
import { sendBillingReceipt } from '../subscription/billing-proof.service.js';
import { broadcastDraftSchema, broadcastSendSchema, createPlatformBroadcasts } from '../internal/platform-broadcasts.service.js';

const router = Router();
router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' }); next(); });
router.use(rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }), authenticateAccount);
router.get('/status', asyncHandler(async (req, res) => { await requireMasterSession(req); return ok(res, { available: true }); }));
router.post('/unlock', rateLimit({ windowMs: 60_000, limit: 10 }), asyncHandler(async (req, res) => {
  const body = z.object({ code: z.string().min(1).max(256) }).strict().parse(req.body);
  return ok(res, await unlockMasterAdmin(req, body.code));
}));
router.use(asyncHandler(async (req, res, next) => {
  const { session, config } = await requireMasterAdmin(req);
  const actor = `master:${session.userId}`;
  // Never trust an operator identity supplied by the browser.
  req.headers['x-internal-actor'] = actor;
  res.locals.broadcasts = createPlatformBroadcasts(undefined, undefined, undefined, config.code, true);
  await prisma.internalAudit.create({ data: { actor, action: 'master_admin.request',
    metadata: { session_id: session.id, method: req.method, path: req.originalUrl.split('?')[0] } } });
  next();
}));
router.use('/support', buildSupportRouter(true));
const page = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0) });
router.get('/billing-requests/counts', asyncHandler(async (_req, res) => ok(res, await billingRequestCounts())));
router.get('/billing-requests', asyncHandler(async (req, res) => {
  const q = page.extend({ status: z.enum(['open', 'submitted']).optional(), search: z.string().trim().max(120).optional() }).parse(req.query);
  return ok(res, await billingRequests(q.offset, q.status, q.search));
}));
router.get('/billing/:tenantId/invoices/:invoiceId', asyncHandler(async (req, res) => {
  const tenant = await prisma.tenant.findFirst({ include: { subscription: true },  where: { id: String(req.params.tenantId), deletionStartedAt: null } });
  const invoice = tenant && (await listInvoices(tenant.id)).find(row => row.id === String(req.params.invoiceId));
  if (!tenant || !invoice) throw notFound('Billing request not found.');
  return ok(res, { tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug }, invoice });
}));
router.post('/billing/:tenantId/invoices/:invoiceId/review', asyncHandler(async (req, res) => {
  const body = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(500).optional(), expected_payment_request_key: z.string().uuid() }).strict().parse(req.body);
  await prisma.internalAudit.create({ data: { actor: internalActor(req), tenantId: String(req.params.tenantId), action: 'billing.payment_review_requested', metadata: { invoice_id: String(req.params.invoiceId), decision: body.decision, payment_request_key: body.expected_payment_request_key } } });
  return ok(res, await reviewInvoicePayment(String(req.params.tenantId), String(req.params.invoiceId), body.decision, body.reason, body.expected_payment_request_key, internalActor(req)));
}));
router.get('/billing/:tenantId/invoices/:invoiceId/receipts/:receiptId', asyncHandler(async (req, res) =>
  sendBillingReceipt(req, res, String(req.params.tenantId), String(req.params.invoiceId), String(req.params.receiptId))));
router.get('/notifications/users', asyncHandler(async (req, res) => {
  const q = z.object({ search: z.string().trim().min(2).max(100) }).parse(req.query);
  return ok(res, await res.locals.broadcasts.searchUsers(q.search));
}));
router.post('/notifications/preview', asyncHandler(async (req, res) => ok(res, await res.locals.broadcasts.preview(internalActor(req), broadcastDraftSchema.parse(req.body)))));
router.post('/notifications', rateLimit({ windowMs: 60_000, limit: 5 }), asyncHandler(async (req, res) => ok(res, await res.locals.broadcasts.send(internalActor(req), broadcastSendSchema.parse(req.body)))));
router.get('/notifications', asyncHandler(async (req, res) => ok(res, await res.locals.broadcasts.history(page.parse(req.query).offset))));
router.post('/notifications/:id/retry', asyncHandler(async (req, res) => ok(res, await res.locals.broadcasts.retry(internalActor(req), String(req.params.id)))));
// Do not fall through to the customer support router or project routes.
router.use((_req, res) => { res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }); });
export { router as masterAdminRouter };
