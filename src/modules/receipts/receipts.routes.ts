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
import { buildReceiptPdf } from "./receipt-pdf.js";
import { readObject, StorageObjectNotFoundError } from "../../core/storage/object-storage.service.js";

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

router.get("/members/:id/receipts", requireProject, requireRoles("any"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  if (!isSelfOrRole(auth, id, [...STAFF_ROLES, "owner"])) throw forbidden();
  const receipts = await prisma.receipt.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, memberId: id },
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
  if (!isSelfOrRole(auth, receipt.memberId, [...STAFF_ROLES, "owner"])) throw forbidden();
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
  const receipt = await prisma.receipt.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { deposit: true, member: true, project: true }
  });
  if (!receipt) throw notFound("Receipt not found");
  if (!isSelfOrRole(auth, receipt.memberId, [...STAFF_ROLES, "owner"])) throw forbidden();
  
  const ownerMembership = await prisma.projectMembership.findFirst({
    where: { tenantId: auth.tenantId, projectId: receipt.projectId, role: "owner" },
    include: { user: true }
  });

  let projectLogo: Buffer | null = null;
  let projectLogoMimeType: string | null = null;
  if (receipt.project.logoFileId) {
    const logoRecord = await prisma.upload.findFirst({
      where: {
        id: receipt.project.logoFileId,
        tenantId: auth.tenantId,
        projectId: receipt.projectId
      }
    });
    if (logoRecord) {
      try {
        const logoObject = await readObject(logoRecord.storageKey);
        projectLogo = logoObject.buffer;
        projectLogoMimeType = (logoObject.contentType ?? logoRecord.mimeType).split(";", 1)[0].toLowerCase();
      } catch (error) {
        if (!(error instanceof StorageObjectNotFoundError)) {
          console.error("[receipt-pdf] failed to read project logo", error);
        }
      }
    }
  }

  const pdf = await buildReceiptPdf({
    receiptNo: receipt.receiptNo,
    amount: receipt.amount,
    issuedAt: receipt.issuedAt,
    memberName: receipt.member.name,
    memberMobile: receipt.member.mobile,
    memberAddress: receipt.member.address,
    projectName: receipt.project.name,
    projectAddress: receipt.project.address,
    projectLogo,
    projectLogoMimeType,
    method: receipt.method,
    reference: receipt.deposit.reference,
    ownerMobile: ownerMembership?.user.mobile ?? null,
    paymentPurpose: receipt.deposit.allocate === "advance" ? "Advance member contribution" : "Member contribution"
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${receipt.receiptNo}.pdf"`);
  return res.status(200).send(pdf);
}));

export { router as receiptsRouter };
