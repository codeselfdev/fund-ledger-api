import multer from 'multer';
import { billingPaymentSchema, sendBillingReceipt } from './billing-proof.service.js';
import { forbidden } from "../../core/http/api-error.js";
import { invoicesFromContact, submitInvoicePayment } from "./billing.service.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireRoles } from "../../core/security/auth.middleware.js";
import { requireOrganizationManagement } from "../../core/security/organization-access.js";
import { requireAuthContext } from "../../core/security/auth.context.js";
import { evaluateSubscription, renewTenantSubscription, startTenantTrial } from "../../core/subscription/subscription.service.js";
import { validateBody } from "../../core/validation/validate.js";
import { writeAudit } from "../../core/audit/audit.service.js";

import { PACKAGES, packageId } from "../../core/subscription/packages.js";
import { tenantQuota, assertDocumentCapacity, assertProjectCapacity, assertPersonCapacity } from "../../core/subscription/quota.service.js";
import { selectPackage } from "./package-selection.service.js";
const router = Router();
router.get("/packages", requireRoles("any"), (_req, res) => ok(res, Object.values(PACKAGES)));
router.get("/quota", requireRoles("any"), asyncHandler(async (req, res) => ok(res, await tenantQuota(requireAuthContext(req).tenantId))));
router.post("/upload-check", requireRoles("any"), asyncHandler(async (req, res) => ok(res, await assertDocumentCapacity(requireAuthContext(req).tenantId))));
router.post("/project-check", requireRoles("owner", "admin"), requireOrganizationManagement, asyncHandler(async (req, res) => ok(res, await assertProjectCapacity(requireAuthContext(req).tenantId))));
const personSchema = z.object({ user_id: z.string().optional(), mobile: z.string().optional(), email: z.string().optional() }).strict();
router.post("/person-check", requireRoles("owner", "admin", "accountant"), validateBody(personSchema), asyncHandler(async (req, res) => ok(res, await assertPersonCapacity(requireAuthContext(req).tenantId, personSchema.parse(req.body)))));
const packageSchema = z.object({ package: z.enum(["starter", "business"]), billing_cycle: z.enum(["monthly", "yearly"]) }).strict();
router.post("/upgrade", requireRoles("owner", "admin"), requireOrganizationManagement, validateBody(packageSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req), body = packageSchema.parse(req.body);
  return ok(res, await selectPackage(auth.tenantId, auth.userId, body.package, body.billing_cycle));
}));

const trialBodySchema = z.object({
  trial_days: z.number().int().min(1).max(365)
});

router.get("/", requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: auth.tenantId },
    select: { id: true, name: true, plan: true, contact: true }
  });

  const summary = evaluateSubscription(tenant.contact);
  return ok(res, {
    tenant_id: tenant.id,
    tenant_name: tenant.name,
    can_manage_billing: auth.roles.includes("owner") || auth.roles.includes("admin"),
    plan: packageId(tenant.contact),
    ...summary
  });
}));

// Customer organization roles never grant authority to approve their own subscription.
router.post("/renew", asyncHandler(async () => { throw forbidden("Only the billing service can approve a paid renewal"); }));
router.post("/trial", asyncHandler(async () => { throw forbidden("Trial periods cannot be reset by customers"); }));
const paymentUpload = multer({ storage: multer.memoryStorage(), limits: { files: 1, fileSize: 5_000_001, fields: 3, fieldSize: 1000 } }).single('receipt');
router.get("/invoices", requireRoles("owner", "admin"), requireOrganizationManagement, asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
  return ok(res, invoicesFromContact(tenant.contact));
}));
router.post("/invoices/:invoiceId/payment", requireRoles("owner", "admin"), requireOrganizationManagement, paymentUpload, validateBody(billingPaymentSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return ok(res, await submitInvoicePayment(auth.tenantId, req.params.invoiceId!, auth.userId, billingPaymentSchema.parse(req.body), req.file));
}));
router.get('/invoices/:invoiceId/receipts/:receiptId', requireRoles('owner', 'admin'), requireOrganizationManagement, asyncHandler(async (req,res) => {
  const auth = requireAuthContext(req);
  return sendBillingReceipt(req,res,auth.tenantId,String(req.params.invoiceId),String(req.params.receiptId));
}));
export { router as subscriptionRouter };
