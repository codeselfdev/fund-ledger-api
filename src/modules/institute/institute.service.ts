import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { queueInstituteNotifications } from './institute.notifications.js';
import type { Request } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma } from '../../core/prisma/client.js';
import { requireProjectContext } from '../../core/security/auth.context.js';
import { ApiError, forbidden, notFound } from '../../core/http/api-error.js';
import { financialTransaction } from '../accounting/transaction.js';
import { fail, portalSchema, portals, settings, today, pushNotBefore, type Portal } from './institute.policy.js';
export type Tx = Prisma.TransactionClient;
export type Access = Awaited<ReturnType<typeof access>>;
export const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export async function access(req: Request) {
    const auth = requireProjectContext(req), project = await prisma.project.findFirst({ where: { id: auth.projectId, tenantId: auth.tenantId, isActive: true } });
    if (!project || project.projectType !== 'institute')
        throw notFound();
    const scope = { tenantId: auth.tenantId, projectId: auth.projectId }, config = settings(project.instituteSettings);
    const [links, self, assignments] = await Promise.all([
        prisma.instituteGuardianLink.findMany({ where: { ...scope, userId: auth.userId } }),
        prisma.instituteStudent.findMany({ where: { ...scope, userId: auth.userId } }),
        prisma.instituteTeacherAssignment.findMany({ where: { ...scope, userId: auth.userId } }),
    ]);
    const available = portals(auth.customRoleOnly ? [] : auth.builtinRoles ?? auth.roles, links.length > 0, self.length > 0, assignments.length > 0);
    const selected = req.query.portal === undefined ? available[0] : portalSchema.parse(req.query.portal);
    if (!selected || !available.includes(selected))
        throw notFound();
    const family = selected === 'guardian' || selected === 'student', studentIds = selected === 'student' ? self.map(s => s.id) : links.map(l => l.studentId), groupIds = assignments.map(a => a.groupId);
    return { auth, project, scope, config, portal: selected as Portal, portals: available, links, self, assignments, family, studentIds, groupIds };
}
export function permit(a: Access, area: string, write = false) {
    const allowed: Record<Portal, string[]> = { office: ['home', 'setup', 'students', 'groups', 'subjects', 'teachers', 'roles', 'settings', 'attendance', 'routine', 'leave', 'fees', 'posts', 'documents', 'results'], accounts: ['home', 'students', 'groups', 'routine', 'fees'], teacher: ['home', 'students', 'groups', 'subjects', 'attendance', 'routine', 'leave', 'posts', 'documents', 'results'], guardian: ['home', 'students', 'groups', 'subjects', 'attendance', 'routine', 'leave', 'fees', 'posts', 'documents', 'results'], student: ['home', 'students', 'groups', 'subjects', 'attendance', 'routine', 'leave', 'fees', 'posts', 'documents', 'results'], auditor: ['home', 'students', 'groups', 'subjects', 'attendance', 'routine', 'leave', 'fees', 'posts', 'documents', 'results'] };
    if (!allowed[a.portal].includes(area))
        throw notFound();
    if (write && (a.portal === 'auditor' || a.portal === 'accounts' && area !== 'fees' || a.portal === 'teacher' && !['attendance', 'leave', 'posts', 'documents', 'results'].includes(area) || a.family && !['leave', 'fees', 'posts'].includes(area)))
        throw forbidden();
    if (write && area === 'fees' && !a.family && a.auth.builtinRoles?.includes('cashier') && !a.auth.builtinRoles.some(r => ['owner', 'admin', 'accountant'].includes(r)))
        throw forbidden('A cashier submits collections; an accountant verifies them.');
    if (a.auth.menuPermissions && !a.auth.builtinRoles?.some(r => ['owner', 'admin'].includes(r)) && !a.auth.menuPermissions[`institute_${area==='subjects'&&a.portal!=='office'?'results':area}`]?.[write ? 'write' : 'read'])
        throw forbidden('Institute menu access is restricted.');
}
export function studentWhere(a: Access, history = false): Prisma.InstituteStudentWhereInput {
    return { ...a.scope, ...(a.family ? { id: { in: a.studentIds }, ...(history ? {} : { status: 'active' }) } : a.portal === 'teacher' ? { groupId: { in: a.groupIds } } : {}) };
}
export async function student(tx: Tx | PrismaClient, a: Access, id: string, history = false) { const row = await tx.instituteStudent.findFirst({ where: { ...studentWhere(a, history), id, ...(a.family ? { AND: { id: { in: a.studentIds } } } : {}) } }); if (!row)
    throw notFound(); return row; }
export async function group(tx: Tx | PrismaClient, a: Access, id: string) { const where: Prisma.InstituteGroupWhereInput = { ...a.scope, id }; if (a.portal === 'teacher')
    where.id = { in: a.groupIds, equals: id }; if (a.family) {
    const s = await tx.instituteStudent.findFirst({ where: { ...studentWhere(a), groupId: id } });
    if (!s)
        throw notFound();
} const row = await tx.instituteGroup.findFirst({ where }); if (!row)
    throw notFound(); return row; }
export function assertRevision(row: {
    revision: number;
}, revision: number) { if (row.revision !== revision) {
    const e = new ApiError(409, 'REVISION_CONFLICT', 'This record changed. Reload before saving.');
    (e as ApiError & {
        current: unknown;
    }).current = json(row);
    throw e;
} }
export async function mutate(req: Request, a: Access, operation: (tx: Tx) => Promise<unknown>, timeoutMs = 5000) {
    const key = req.header('Idempotency-Key');
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))
        fail('VALIDATION', 'An Idempotency-Key UUID is required.');
    const payloadHash = createHash('sha256').update(JSON.stringify([req.method, req.path, a.portal, req.body])).digest('hex');
    return financialTransaction(async (tx) => {
        const previous = await tx.instituteWriteReceipt.findUnique({ where: { projectId_userId_key: { projectId: a.scope.projectId, userId: a.auth.userId, key: key! } } });
        if (previous) {
            if (previous.payloadHash !== payloadHash)
                fail('IDEMPOTENCY_CONFLICT', 'This key was used for a different request.', 409);
            return previous.response;
        }
        const response = await operation(tx);
        await tx.instituteWriteReceipt.create({ data: { ...a.scope, userId: a.auth.userId, key: key!, payloadHash, response: json(response) } });
        await tx.activity.create({ data: { ...a.scope, actorUserId: a.auth.userId, action: `institute.${req.method.toLowerCase()}`, entityType: 'institute', entityId: req.path, after: json({ path: req.path }) } });
        return response;
    }, timeoutMs);
}
export async function recipients(tx: Tx, a: Access, studentIds: string[]) { if (!studentIds.length)
    return []; const [links, self] = await Promise.all([tx.instituteGuardianLink.findMany({ where: { ...a.scope, studentId: { in: studentIds } } }), tx.instituteStudent.findMany({ where: { ...a.scope, id: { in: studentIds }, status: 'active', userId: { not: null } } })]); return [...links.map(l => ({ studentId: l.studentId, userId: l.userId })), ...self.map(s => ({ studentId: s.id, userId: s.userId! }))].filter((r, i, all) => all.findIndex(x => x.studentId === r.studentId && x.userId === r.userId) === i); }
export async function notify(tx: Tx, a: Access, studentIds: string[], type: string, title: string, entityId: string, dedupe: string, onlyUsers?: string[]) {
  const users = Array.from(new Set((await recipients(tx,a,studentIds)).map(r=>r.userId))).filter(userId=>!onlyUsers||onlyUsers.includes(userId));
  return queueInstituteNotifications(tx,{...a.scope,actorUserId:a.auth.userId,userIds:users,timezone:a.config.timezone,type,title,entityId,dedupe,sms:type==='fee.reminder'});
}
export async function createUser(tx: Tx, a: Access, mobile: string, name: string, role: 'teacher' | 'member') {
    const user = await tenantAccounts(tx).upsert({ where: { tenantId_mobile: { tenantId: a.scope.tenantId, mobile } }, create: { tenantId: a.scope.tenantId, mobile, name }, update: {} });
    if (!user.isActive)
        throw forbidden('This account is inactive.');
    const existing = await tx.projectMembership.findFirst({ where: { ...a.scope, userId: user.id, role, customRoleId: null } });
    if (!existing)
        await tx.projectMembership.create({ data: { ...a.scope, userId: user.id, role, isActive: true } });
    else if (!existing.isActive)
        await tx.projectMembership.update({ where: { id: existing.id }, data: { isActive: true } });
    return user;
}
export const studentDto = (s: {
    id: string;
    name: string;
    rollNo: string;
    studentCode: string | null;
    groupId: string;
    status: string;
    userId: string | null;
}) => ({ id: s.id, name: s.name, roll_no: s.rollNo, student_code: s.studentCode, group_id: s.groupId, status: s.status, user_id: s.userId });
