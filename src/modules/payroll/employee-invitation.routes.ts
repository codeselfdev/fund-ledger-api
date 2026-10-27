import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireRoles } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ok } from '../../core/http/response.js';
import { employeeInvitationSchema, inviteEmployee } from './employee-invitation.service.js';
const router = Router();
router.post('/employees/:id/invitation', requireRoles('owner', 'admin'), rateLimit({ windowMs: 60000, limit: 10 }), asyncHandler(async (req, res) => {
  return ok(res, await inviteEmployee(requireProjectContext(req), req.params.id, employeeInvitationSchema.parse(req.body), req));
}));
export { router as employeeInvitationRouter };
