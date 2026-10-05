import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { created } from "../../core/http/response.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { validateBody } from "../../core/validation/validate.js";
import { createAccountTransfer } from "./transfer.service.js";

const router = Router();

const transferSchema = z.object({
  from_account_id: z.string().min(1),
  to_account_id: z.string().min(1),
  amount: z.number().int().positive(),
  note: z.string().optional()
});

router.post("/", requireProject, requireRoles("accountant"), validateBody(transferSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof transferSchema>;
  const transfer = await createAccountTransfer({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    fromAccountId: body.from_account_id,
    toAccountId: body.to_account_id,
    amount: body.amount,
    note: body.note
  });
  return created(res, transfer);
}));

export { router as transfersRouter };
