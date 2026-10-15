import { Router } from 'express';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { requireProject } from '../../core/security/auth.middleware.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { badRequest, conflict, notFound } from '../../core/http/api-error.js';
import { ok } from '../../core/http/response.js';
import { validateBody } from '../../core/validation/validate.js';
import { financialTransaction } from '../accounting/transaction.js';
import { MAX_PINS, availableCatalog, defaultPins, visiblePins, preferenceSchema, resetSchema } from './shortcuts.policy.js';
const router = Router();
router.use(requireProject, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
async function context(req: Parameters<typeof requireProjectContext>[0]) {
    const auth = requireProjectContext(req);
    const project = await prisma.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId, isActive: true } });
    if (!project)
        throw notFound('Active project not found');
    return { auth, project, where: { tenantId: auth.tenantId, projectId: auth.projectId, userId: auth.userId } };
}
router.get('/', asyncHandler(async (req, res) => {
    const { auth, project, where } = await context(req);
    const available = availableCatalog(project.projectType, auth.roles), keys = available.tools.map(t => t.key);
    const preference = await prisma.shortcutPreference.findFirst({ where });
    const defaults = defaultPins(project.projectType, auth.roles, project.portalSettings);
    return ok(res, { ...available, pinned: preference ? visiblePins(preference.pinned, keys) : defaults, defaults, version: preference?.version ?? 0, max_pins: MAX_PINS });
}));
router.put('/preferences', validateBody(preferenceSchema), asyncHandler(async (req, res) => {
    const { auth, project, where } = await context(req), body = preferenceSchema.parse(req.body);
    const keys = availableCatalog(project.projectType, auth.roles).tools.map(t => t.key);
    if (body.pinned.some(key => !keys.includes(key)))
        throw badRequest('A selected tool is unavailable for this project or your current role');
    const saved = await save(where, body.pinned, body.version);
    return ok(res, { pinned: visiblePins(saved.pinned, keys), version: saved.version });
}));
router.post('/reset', validateBody(resetSchema), asyncHandler(async (req, res) => {
    const { auth, project, where } = await context(req), body = resetSchema.parse(req.body);
    const defaults = defaultPins(project.projectType, auth.roles, project.portalSettings);
    const saved = await save(where, defaults, body.version);
    return ok(res, { pinned: defaults, version: saved.version });
}));
async function save(where: {
    tenantId: string;
    projectId: string;
    userId: string;
}, pinned: string[], version: number) {
    return financialTransaction(async (tx) => {
        const old = await tx.shortcutPreference.findFirst({ where });
        if ((old?.version ?? 0) !== version) {
            if (old?.version === version + 1 && JSON.stringify(old.pinned) === JSON.stringify(pinned))
                return old;
            throw conflict('Shortcuts changed on another device. Reload the latest layout before saving.');
        }
        return old ? tx.shortcutPreference.update({ where: { id: old.id }, data: { pinned, version: { increment: 1 } } }) : tx.shortcutPreference.create({ data: { ...where, pinned, version: 1 } });
    });
}
export { router as shortcutsRouter };
