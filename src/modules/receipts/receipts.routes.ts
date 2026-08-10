import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { forbidden, notFound } from "../../core/http/api-error.js";
import { ok } from "../../core/http/response.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { isSelfOrRole, requireProjectContext } from "../../core/security/auth.context.js";
import { STAFF_ROLES } from "../../core/security/roles.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateParams } from "../../core/validation/validate.js";

const router = Router();

router.get("/me/receipts", requireProject, requireRoles("member"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  if (!auth.memberId) throw forbidden("A linked member record is required");

  const receipts = await prisma.receipt.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId: auth.memberId },
    include: { deposit: true },
    orderBy: { issuedAt: "desc" }
  });

  return ok(res, receipts);
}));

async function receiptForAccess(auth: ReturnType<typeof requireProjectContext>, id: string) {
  const receipt = await prisma.receipt.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { deposit: true, member: true }
  });
  if (!receipt) throw notFound("Receipt not found");
  if (!isSelfOrRole(auth, receipt.memberId, STAFF_ROLES)) throw forbidden();
  return receipt;
}

router.get("/receipts/:id", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  return ok(res, await receiptForAccess(auth, id));
}));

router.get("/receipts/:id/pdf", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const receipt = await receiptForAccess(auth, id);
  return ok(res, {
    receipt,
    pdf_url: null,
    message: "PDF rendering can be connected to a document service here"
  });
}));

export { router as receiptsRouter };
