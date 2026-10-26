import { mergePermissions } from '../../core/security/menu-access.js';
import { Router, type Request } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { notFound } from '../../core/http/api-error.js';
import { readObject } from '../../core/storage/object-storage.service.js';
import { buildBillingPdf } from '../billing/billing.pdf.js';
import { access, permit, student, group, type Access } from './institute.service.js';
import { enabled } from './institute.policy.js';
export async function readableDocument(a: Access, id: string) {
  permit(a, 'documents');
  const doc = await prisma.instituteDocument.findFirst({ where: { ...a.scope, id, visibleFrom: { lte: new Date() } } });
  if (!doc) throw notFound();
  if (a.portal === 'teacher' && (doc.receiptId || doc.publicationId)) throw notFound();
  if (doc.studentId) {
    const s = await student(prisma, a, doc.studentId, true);
    if (a.family && s.status !== 'active' && ((!doc.receiptId && !doc.publicationId) || !s.leftOn || Date.now() - +s.leftOn > 90 * 86400000)) throw notFound();
  } else if (doc.groupId) {
    await group(prisma, a, doc.groupId);
  } else throw notFound();
  if (doc.postId && a.family && !await prisma.institutePostRecipient.findFirst({ where: { ...a.scope, postId: doc.postId, userId: a.auth.userId, studentId: { in: a.studentIds } } })) throw notFound();
  return doc;
}
export async function documentUrl(a: Access, req: Request) { const doc = await readableDocument(a, req.params.id), token = jwt.sign({ purpose: 'institute_document', documentId: doc.id, tenantId: a.scope.tenantId, projectId: a.scope.projectId, userId: a.auth.userId, sessionId: a.auth.sessionId, portal: a.portal }, env.jwtSecret, { expiresIn: 120, audience: 'institute-files' }); return { url: `${req.protocol}://${req.get('host')}/v1/institute-files/${encodeURIComponent(doc.id)}?token=${encodeURIComponent(token)}` }; }
export const instituteFilesRouter = Router();
instituteFilesRouter.get('/:id', asyncHandler(async (req, res) => { if (!enabled())
    throw notFound(); let signed: jwt.JwtPayload; try {
    signed = jwt.verify(String(req.query.token ?? ''), env.jwtSecret, { audience: 'institute-files', algorithms: ['HS256'] }) as jwt.JwtPayload;
}
catch {
    throw notFound();
} if (signed.purpose !== 'institute_document' || signed.documentId !== req.params.id)
    throw notFound(); const session = await prisma.session.findFirst({ where: { id: signed.sessionId, userId: signed.userId, tenantId: signed.tenantId, revokedAt: null, expiresAt: { gt: new Date() }, user: { isActive: true } } }); if (!session)
    throw notFound(); const memberships = await prisma.projectMembership.findMany({ where: { tenantId: signed.tenantId, projectId: signed.projectId, userId: signed.userId, isActive: true }, include: { customRole: true } }); if (!memberships.length)
    throw notFound(); req.auth = { userId: signed.userId, sessionId: signed.sessionId, tenantId: signed.tenantId, projectId: signed.projectId, roles: memberships.filter(m=>!m.customRoleId).map(m => m.role), builtinRoles: memberships.filter(m=>!m.customRoleId).map(m => m.role), customRoleOnly: !memberships.some(m=>!m.customRoleId), ...(memberships.some(m=>m.customRoleId) ? { menuPermissions: mergePermissions(memberships.flatMap(m=>m.customRole?[m.customRole]:[])) } : {}), memberId: null }; req.query.portal = signed.portal; const a = await access(req), doc = await readableDocument(a, req.params.id); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Disposition', `inline; filename="${doc.title.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf"`); if (doc.receiptId) {
    const receipt = await prisma.instituteFeeReceipt.findFirst({ where: { ...a.scope, id: doc.receiptId } });
    if (!receipt)
        throw notFound();
    const s = await student(prisma, a, receipt.studentId, true), buffer = await buildBillingPdf('Institute Fee Receipt', a.project.name, 'BDT', s.name, [`Receipt: ${receipt.receiptNo}`, `Amount: ${receipt.amount} taka`, `Method: ${receipt.method}`, `Issued: ${receipt.createdAt.toISOString().slice(0, 10)}`]);
    res.type('pdf');
    return res.send(buffer);
} if (doc.publicationId) { const publication = await prisma.instituteResultPublication.findFirst({ where: { ...a.scope, id: doc.publicationId } }); const row = (publication?.snapshot as unknown as { student_id: string; exam_name: string; grade: string; total: number; gpa?: number; subjects: { name: string; total: number; grade: string }[] }[] | undefined)?.find(r => r.student_id === doc.studentId); if (!row) throw notFound(); const s = await student(prisma,a,row.student_id,true); const buffer = await buildBillingPdf('Institute Report Card',a.project.name,'BDT',s.name,[row.exam_name,`Version: ${publication!.version}`,`Grade: ${row.grade}`,`Total: ${row.total}`,...(row.gpa !== undefined ? [`GPA: ${row.gpa.toFixed(2)}`] : []),...row.subjects.map(subject => `${subject.name}: ${subject.total} · ${subject.grade}`)]); res.type('pdf'); return res.send(buffer); } const upload = doc.fileId ? await prisma.upload.findFirst({ where: { ...a.scope, id: doc.fileId, purpose: 'institute_document', deletedAt: null } }) : null; if (!upload)
    throw notFound(); const object = await readObject(upload.storageKey); res.type(upload.mimeType); return res.send(object.buffer); }));
