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

const router = Router();

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
    plan: tenant.plan,
    ...summary
  });
}));

// Customer organization roles never grant authority to approve their own subscription.
router.post("/renew", asyncHandler(async () => { throw forbidden("Only the billing service can approve a paid renewal"); }));
router.post("/trial", asyncHandler(async () => { throw forbidden("Trial periods cannot be reset by customers"); }));
const paymentSchema = z.object({ payment_reference: z.string().trim().min(3).max(200) });
router.get("/invoices", requireRoles("owner", "admin"), requireOrganizationManagement, asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
  return ok(res, invoicesFromContact(tenant.contact));
}));
router.post("/invoices/:invoiceId/payment", requireRoles("owner", "admin"), requireOrganizationManagement, validateBody(paymentSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return ok(res, await submitInvoicePayment(auth.tenantId, req.params.invoiceId!, auth.userId, paymentSchema.parse(req.body).payment_reference));
}));
export { router as subscriptionRouter };
