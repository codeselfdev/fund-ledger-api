import { Router } from "express";
import { z } from "zod";
import { requireProvisioningApiKey } from "../../core/security/api-key.middleware.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { created, ok } from "../../core/http/response.js";
import { validateBody } from "../../core/validation/validate.js";
import { issueInvoice, reviewInvoicePayment, invoicesFromContact } from "./billing.service.js";
import { prisma } from "../../core/prisma/client.js";
const router = Router();
router.use(requireProvisioningApiKey);
const invoiceSchema = z.object({ amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.string().length(3).default("BDT"), instructions: z.string().trim().min(1).max(2000) });
const reviewSchema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).optional() });
router.get("/:tenantId/invoices", asyncHandler(async (req, res) => {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.params.tenantId } });
  return ok(res, invoicesFromContact(tenant.contact));
}));
router.post("/:tenantId/invoices", validateBody(invoiceSchema), asyncHandler(async (req, res) => {
  const body = invoiceSchema.parse(req.body);
  return created(res, await issueInvoice(req.params.tenantId!, body.amount, body.currency.toUpperCase(), body.instructions));
}));
router.post("/:tenantId/invoices/:invoiceId/review", validateBody(reviewSchema), asyncHandler(async (req, res) => {
  const body = reviewSchema.parse(req.body);
  return ok(res, await reviewInvoicePayment(req.params.tenantId!, req.params.invoiceId!, body.decision, body.reason));
}));
export { router as platformBillingRouter };
