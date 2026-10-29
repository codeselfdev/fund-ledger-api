import { subscriptionContext } from "../../core/subscription/subscription.repository.js";
import { sendBillingReceipt } from './billing-proof.service.js';
import { Router } from "express";
import { z } from "zod";
import { requireProvisioningApiKey } from "../../core/security/api-key.middleware.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { created, ok } from "../../core/http/response.js";
import { validateBody } from "../../core/validation/validate.js";
import { issueInvoice, reviewInvoicePayment, listInvoices } from "./billing.service.js";
import { prisma } from "../../core/prisma/client.js";
const router = Router();
router.use(requireProvisioningApiKey);
const invoiceSchema = z.object({ amount: z.number().int().positive().max(2147483647), currency: z.string().length(3).default("BDT"), instructions: z.string().trim().min(1).max(2000), package: z.enum(["starter", "business", "custom"]).optional(), billing_cycle: z.enum(["monthly", "yearly"]).default("yearly") });
const reviewSchema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).optional(), expected_payment_request_key: z.string().uuid().optional() });
router.get("/:tenantId/invoices", asyncHandler(async (req, res) => {
  const tenant = await prisma.tenant.findUniqueOrThrow({ include: { subscription: true },  where: { id: req.params.tenantId } });
  return ok(res, await listInvoices(tenant.id));
}));
router.post("/:tenantId/invoices", validateBody(invoiceSchema), asyncHandler(async (req, res) => {
  const body = invoiceSchema.parse(req.body);
  return created(res, await issueInvoice(req.params.tenantId!, body.amount, body.currency.toUpperCase(), body.instructions, body.package ? { package: body.package, billing_cycle: body.billing_cycle } : undefined));
}));
router.post("/:tenantId/invoices/:invoiceId/review", validateBody(reviewSchema), asyncHandler(async (req, res) => {
  const body = reviewSchema.parse(req.body);
  return ok(res, await reviewInvoicePayment(req.params.tenantId!, req.params.invoiceId!, body.decision, body.reason, body.expected_payment_request_key));
}));
router.get('/:tenantId/invoices/:invoiceId/receipts/:receiptId', asyncHandler(async(req,res) => sendBillingReceipt(req,res,String(req.params.tenantId),String(req.params.invoiceId),String(req.params.receiptId))));
export { router as platformBillingRouter };
