import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../core/prisma/client.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { ok } from "../../core/http/response.js";
import { authenticateAccount } from "../../core/security/auth.middleware.js";
import { requireAuthContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";

const router = Router();
const requestSchema = z.object({}).strict();

router.post("/account-deletion-requests", authenticateAccount, validateBody(requestSchema), asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const now = new Date();
  const request = await prisma.accountDeletionRequest.upsert({
    where: { userId: auth.userId },
    create: {
      userId: auth.userId,
      tenantId: auth.tenantId,
      requestedAt: now,
      dueAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    },
    // Retrying must preserve the original reference and deadline.
    update: {}
  });
  return ok(res, {
    id: request.id,
    status: request.status,
    requested_at: request.requestedAt.toISOString(),
    due_at: request.dueAt.toISOString(),
    support_email: "hello@appnesta.com"
  });
}));

router.get("/account-deletion-requests/current", authenticateAccount, asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const request = await prisma.accountDeletionRequest.findUnique({ where: { userId: auth.userId } });
  return ok(res, request ? {
    id: request.id,
    status: request.status,
    requested_at: request.requestedAt.toISOString(),
    due_at: request.dueAt.toISOString()
  } : null);
}));

export { router as accountDeletionRouter };
