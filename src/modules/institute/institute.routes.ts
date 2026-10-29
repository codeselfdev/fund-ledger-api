import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { saveRoutine } from './institute.routine.js';
import { instituteImport, importArea, importKind, importBody } from './institute.imports.js';
import { documentUrl } from './institute.files.js';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { asyncHandler } from '../../core/http/async-handler.js';
import { ApiError, notFound, forbidden } from '../../core/http/api-error.js';
import { ok } from '../../core/http/response.js';
import { requireProject } from '../../core/security/auth.middleware.js';
import { assertPersonCapacity } from '../../core/subscription/quota.service.js';
import { access, permit, studentWhere, student, group, mutate, assertRevision, notify, recipients, createUser, studentDto, json, type Access, type Tx } from './institute.service.js';
import { enabled, id, day, date, mobile, money, today, monthBounds, attendanceSchema, validateAttendance, fail, resultGrade, densePositions, gpa } from './institute.policy.js';
const router = Router();
router.use(requireProject, (_req, _res, next) => enabled() ? next() : next(notFound('Institute is not enabled.')));
const read = (path: string, area: string, fn: (a: Access, req: Request, res: Response) => Promise<unknown>) => router.get(path, asyncHandler(async (req, res) => { const a = await access(req); if (path !== '/me') permit(a, area); return ok(res, await fn(a, req, res)); }));
const write = (method: 'post' | 'put' | 'patch', path: string, area: string, fn: (tx: Tx, a: Access, req: Request) => Promise<unknown>, cashierSubmit = false) => router[method](path, asyncHandler(async (req, res) => { const a = await access(req); if (cashierSubmit) {
    permit(a, area);
    if (a.portal === 'auditor')
        throw forbidden();
}
else
    permit(a, area, true); return ok(res, await mutate(req, a, tx => fn(tx, a, req))); }));

router.post('/imports/:kind/preview', asyncHandler(async(req,res) => {
  const a=await access(req),kind=importKind.parse(req.params.kind); permit(a,importArea(kind),true);
  if(a.portal!=='office') throw forbidden();
  return ok(res,await instituteImport(prisma,a,kind,importBody.parse(req.body),false));
}));
router.post('/imports/:kind', asyncHandler(async(req,res) => {
  const a=await access(req),kind=importKind.parse(req.params.kind); permit(a,importArea(kind),true);
  if(a.portal!=='office') throw forbidden();
  const body=importBody.parse(req.body);
  return ok(res,await mutate(req,a,tx=>instituteImport(tx,a,kind,body,true),60000));
}));

const groupDto = (g: {
    id: string;
    name: string;
    section: string | null;
    academicYear: string;
    revision: number;
}) => ({ id: g.id, name: g.name, section: g.section, academic_year: g.academicYear, revision: g.revision });
const groupRows = async (a: Access) => { const students = a.family ? await prisma.instituteStudent.findMany({ where: studentWhere(a), select: { groupId: true } }) : []; return prisma.instituteGroup.findMany({ where: { ...a.scope, isActive: true, ...(a.family ? { id: { in: students.map(s => s.groupId) } } : a.portal === 'teacher' ? { id: { in: a.groupIds } } : {}) }, orderBy: { name: 'asc' } }); };
read('/me', 'home', async (a) => { const rows = await prisma.instituteStudent.findMany({ where: { ...studentWhere(a, true), ...(a.family ? { OR: [{ status: 'active' }, { leftOn: { gte: new Date(Date.now()-90*86400000) } }] } : {}) }, orderBy: { rollNo: 'asc' } }); return { can_verify_payments: ['owner','admin','accountant'].some(role => a.auth.builtinRoles?.includes(role as never)), portals: a.portals, settings: a.config, groups: (await groupRows(a)).map(groupDto), students: rows.map(s => ({ ...studentDto(s), can_pay: s.status === 'active' && (a.portal === 'student' && s.userId === a.auth.userId || a.links.some(l => l.studentId === s.id && l.canPay)) })), assignments: a.assignments.map(t => ({ group_id: t.groupId, subject_id: t.subjectId, is_class_teacher: t.isClassTeacher })), ...(a.auth.menuPermissions && !a.auth.builtinRoles?.some(r => ['owner', 'admin'].includes(r)) ? { permissions: a.auth.menuPermissions } : {}) }; });
read('/teachers','teachers',async a=>{if(a.portal!=='office')throw notFound();const subjects=await prisma.instituteSubject.findMany({where:a.scope});const assignments=await prisma.instituteTeacherAssignment.findMany({where:a.scope}),users=await tenantAccounts(prisma).findMany({where:{tenantId:a.scope.tenantId,id:{in:assignments.map(t=>t.userId)}},select:{id:true,name:true,mobile:true}});return assignments.map(t=>({user_id:t.userId,name:users.find(u=>u.id===t.userId)?.name??'',mobile:users.find(u=>u.id===t.userId)?.mobile??'',group_id:t.groupId,subject_id:t.subjectId,subject_name:subjects.find(s=>s.id===t.subjectId)?.name,is_class_teacher:t.isClassTeacher}));});
read('/home','home',async(a,req)=>{if(!['office','accounts','auditor'].includes(a.portal))throw notFound();const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(req.query.month),{start,end}=monthBounds(month,a.config.timezone),[invoices,payments,groups,students,pending]=await Promise.all([prisma.instituteFeeInvoice.findMany({where:{...a.scope,period:month}}),prisma.instituteFeePayment.findMany({where:{...a.scope,status:'verified',updatedAt:{gte:start,lt:end}}}),prisma.instituteGroup.findMany({where:{...a.scope,isActive:true}}),prisma.instituteStudent.findMany({where:{...a.scope,status:'active'}}),prisma.instituteFeePayment.count({where:{...a.scope,status:'submitted'}})]);return{month,collected:payments.reduce((n,p)=>n+p.amount,0),billed:invoices.reduce((n,i)=>n+i.amount,0),outstanding:invoices.filter(i=>i.status!=='waived').reduce((n,i)=>n+i.amount-i.paidAmount,0),payments_to_verify:pending,groups:groups.map(g=>{const ids=students.filter(s=>s.groupId===g.id).map(s=>s.id),rows=invoices.filter(i=>ids.includes(i.studentId));return{id:g.id,name:g.name,students:ids.length,collected:rows.reduce((n,i)=>n+i.paidAmount,0),due:rows.filter(i=>i.status!=='waived').reduce((n,i)=>n+i.amount-i.paidAmount,0)};})};});
read('/fees','fees',async(a,req)=>{if(a.family)throw notFound();const groupId=req.query.group_id===undefined?undefined:id.parse(req.query.group_id);if(groupId)await group(prisma,a,groupId);const students=await prisma.instituteStudent.findMany({where:{...studentWhere(a),groupId},orderBy:{rollNo:'asc'}}),invoices=await prisma.instituteFeeInvoice.findMany({where:{...a.scope,studentId:{in:students.map(s=>s.id)}}}),groups=await groupRows(a);return students.map(s=>{const rows=invoices.filter(i=>i.studentId===s.id);return{student_id:s.id,name:s.name,group_name:groups.find(g=>g.id===s.groupId)?.name??'',billed:rows.reduce((n,i)=>n+i.amount,0),paid:rows.reduce((n,i)=>n+i.paidAmount,0),outstanding:rows.filter(i=>i.status!=='waived').reduce((n,i)=>n+i.amount-i.paidAmount,0)};});});

read('/groups', 'groups', async (a) => (await groupRows(a)).map(groupDto));
write('post', '/groups', 'groups', async (tx, a, req) => { const b = z.object({ name: z.string().trim().min(1).max(120), section: z.string().max(32).optional(), academic_year: z.string().min(1).max(32) }).strict().parse(req.body); return groupDto(await tx.instituteGroup.create({ data: { ...a.scope, name: b.name, section: b.section, academicYear: b.academic_year } })); });
write('patch', '/groups/:id', 'groups', async (tx, a, req) => { const old = await group(tx, a, req.params.id), b = z.object({ revision: z.number().int(), name: z.string().min(1).max(120).optional(), is_active: z.boolean().optional() }).strict().parse(req.body); assertRevision(old, b.revision); return groupDto(await tx.instituteGroup.update({ where: { id: old.id }, data: { name: b.name, isActive: b.is_active, revision: { increment: 1 } } })); });
read('/students', 'students', async (a, req) => { const groupId = req.query.group_id === undefined ? undefined : id.parse(req.query.group_id); if (groupId)
    await group(prisma, a, groupId); return (await prisma.instituteStudent.findMany({ where: { ...studentWhere(a), groupId }, orderBy: { rollNo: 'asc' } })).map(studentDto); });
write('post', '/students/import', 'students', async (tx, a, req) => { const b = z.object({ group_id: id, rows: z.array(z.object({ name: z.string().trim().min(2).max(120), roll_no: z.string().trim().min(1).max(32), student_code: z.string().trim().min(1).max(64).optional(), mobile: mobile.optional() }).strict()).min(1).max(5000) }).strict().parse(req.body); await group(tx, a, b.group_id); if (new Set(b.rows.map(r => r.roll_no)).size !== b.rows.length)
    fail('VALIDATION', 'Duplicate rolls in the import.'); for (const r of b.rows) {
    await assertPersonCapacity(a.scope.tenantId, { mobile: r.mobile });
    const user = r.mobile ? await createUser(tx, a, r.mobile, r.name, 'member') : null;
    const old = r.student_code ? await tx.instituteStudent.findFirst({ where: { ...a.scope, studentCode: r.student_code, groupId: b.group_id } }) : null;
    const studentData = { name: r.name, studentCode: r.student_code, rollNo: r.roll_no, ...(user ? { userId: user.id } : {}) };
    if (old)
        await tx.instituteStudent.update({ where: { id: old.id }, data: { ...studentData, revision: { increment: 1 } } });
    else
        await tx.instituteStudent.upsert({ where: { projectId_groupId_rollNo: { projectId: a.scope.projectId, groupId: b.group_id, rollNo: r.roll_no } }, create: { ...a.scope, ...studentData, groupId: b.group_id, joinedOn: date(today(a.config.timezone)) }, update: { ...studentData, revision: { increment: 1 } } });
} return { imported: b.rows.length }; });
write('post', '/students/:id/guardians', 'students', async (tx, a, req) => { await student(tx, a, req.params.id); const b = z.object({ mobile, name: z.string().min(2), relation: z.string().min(1), can_pay: z.boolean() }).strict().parse(req.body); await assertPersonCapacity(a.scope.tenantId, b); const user = await createUser(tx, a, b.mobile, b.name, 'member'); const link = await tx.instituteGuardianLink.upsert({ where: { studentId_userId: { studentId: req.params.id, userId: user.id } }, create: { ...a.scope, studentId: req.params.id, userId: user.id, relation: b.relation, canPay: b.can_pay }, update: { relation: b.relation, canPay: b.can_pay, revision: { increment: 1 } } }); await tx.notification.create({ data: { ...a.scope, recipientUserId: user.id, actorUserId: a.auth.userId, type: 'institute.invitation', title: `You are linked to ${a.project.name}`, body: 'Sign in with your mobile number to open the guardian portal.', entityType: 'institute', entityId: link.id } }); return { id: link.id }; });
write('post', '/teachers', 'teachers', async (tx, a, req) => { const b = z.object({ mobile, name: z.string().min(2), assignments: z.array(z.object({ group_id: id, subject_id: id.optional(), is_class_teacher: z.boolean() }).strict()).min(1).max(100) }).strict().parse(req.body); await assertPersonCapacity(a.scope.tenantId, b); const user = await createUser(tx, a, b.mobile, b.name, 'teacher'); for (const assignment of b.assignments) {
    await group(tx, a, assignment.group_id);
    if (assignment.subject_id && !await tx.instituteSubject.findFirst({ where: { ...a.scope, id: assignment.subject_id } }))
        throw notFound();
    const old = await tx.instituteTeacherAssignment.findFirst({ where: { ...a.scope, userId: user.id, groupId: assignment.group_id, subjectId: assignment.subject_id ?? null } });
    if (old)
        await tx.instituteTeacherAssignment.update({ where: { id: old.id }, data: { isClassTeacher: assignment.is_class_teacher, revision: { increment: 1 } } });
    else
        await tx.instituteTeacherAssignment.create({ data: { ...a.scope, userId: user.id, groupId: assignment.group_id, subjectId: assignment.subject_id, isClassTeacher: assignment.is_class_teacher } });
} return { id: user.id }; });
read('/subjects', 'subjects', async (a) => (await prisma.instituteSubject.findMany({ where: { ...a.scope, ...(a.portal === 'teacher' ? { id: { in: a.assignments.flatMap(x => x.subjectId ? [x.subjectId] : []) } } : {}) } })).map(s => ({ id: s.id, name: s.name, code: s.code, pass_percent: s.passPercent, components: s.components })));
write('post', '/subjects', 'subjects', async (tx, a, req) => { const b = z.object({ name: z.string().min(1), code: z.string().min(1), components: z.array(z.object({ key: id, label: z.string().min(1), max: z.number().positive() })).min(1), pass_percent: z.number().min(0).max(100).default(33) }).strict().parse(req.body); if (b.components.reduce((n, c) => n + c.max, 0) !== 100 || new Set(b.components.map(c => c.key)).size !== b.components.length)
    fail('VALIDATION', 'Subject components must total 100 and have unique keys.'); return tx.instituteSubject.create({ data: { ...a.scope, name: b.name, code: b.code, components: b.components, passPercent: b.pass_percent } }); });
read('/routine', 'routine', async (a, req) => { const groupId = req.query.group_id === undefined ? undefined : id.parse(req.query.group_id); if (groupId)
    await group(prisma, a, groupId); const groups = await groupRows(a), slots = await prisma.instituteRoutineSlot.findMany({ where: { ...a.scope, groupId: groupId ?? { in: groups.map(g => g.id) }, ...(a.portal==='office' && req.query.include_all==='true' ? {} : { effectiveFrom: { lte: date(today(a.config.timezone)) }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date(today(a.config.timezone)) } }] }) }, orderBy: [{ weekday: 'asc' }, { startsAt: 'asc' }] }); const subjects = await prisma.instituteSubject.findMany({ where: { ...a.scope, id: { in: slots.map(s => s.subjectId) } } }), teachers = await tenantAccounts(prisma).findMany({ where: { tenantId: a.scope.tenantId, id: { in: slots.map(s => s.teacherUserId) } }, select: { id: true, name: true } }); return slots.map(s => ({ id: s.id, group_id: s.groupId, weekday: s.weekday, starts_at: s.startsAt, ends_at: s.endsAt, subject_name: subjects.find(x => x.id === s.subjectId)?.name ?? '', teacher_name: teachers.find(x => x.id === s.teacherUserId)?.name ?? '', teacher_user_id: s.teacherUserId, subject_id: s.subjectId, effective_from: s.effectiveFrom.toISOString().slice(0,10), effective_to: s.effectiveTo?.toISOString().slice(0,10), room: s.room })); });
write('put', '/routine/groups/:groupId', 'routine', (tx,a,req) => saveRoutine(tx,a,req.params.groupId,req.body));
async function sheetView(tx: Tx | typeof prisma, a: Access, groupId: string, dateText: string, session: number) { await group(tx, a, groupId); const dayValue = date(dateText), sheet = await tx.instituteAttendanceSheet.findUnique({ where: { projectId_groupId_date_session: { projectId: a.scope.projectId, groupId, date: dayValue, session } } }), roster = await tx.instituteStudent.findMany({ where: { ...a.scope, groupId, status: 'active', joinedOn: { lte: dayValue } }, orderBy: { rollNo: 'asc' } }), leaves = await tx.instituteLeaveRequest.findMany({ where: { ...a.scope, studentId: { in: roster.map(s => s.id) }, status: 'approved', fromDate: { lte: dayValue }, toDate: { gte: dayValue } } }), marks = sheet ? await tx.instituteAttendanceMark.findMany({ where: { ...a.scope, sheetId: sheet.id } }) : []; return { group_id: groupId, date: dateText, session, revision: sheet?.revision ?? 0, status: sheet ? 'saved' : 'not_marked', marks: roster.map(s => ({ student_id: s.id, name: s.name, roll_no: s.rollNo, status: marks.find(m => m.studentId === s.id)?.status ?? (leaves.some(l => l.studentId === s.id) ? 'leave' : null), leave_locked: leaves.some(l => l.studentId === s.id) })) }; }
read('/attendance/sheets', 'attendance', async (a, req) => { if (a.family)
    throw notFound(); const q = z.object({ group_id: id, date: day, session: z.coerce.number().int().min(1).max(24) }).parse(req.query); return sheetView(prisma, a, q.group_id, q.date, q.session); });
write('put', '/attendance/sheets', 'attendance', async (tx, a, req) => { const b = attendanceSchema.parse(req.body); if (a.family)
    throw notFound(); const current = await sheetView(tx, a, b.group_id, b.date, b.session); assertRevision(current, b.revision); if (b.date > today(a.config.timezone))
    fail('VALIDATION', 'Attendance cannot be saved for a future date.'); if (a.config.attendance_mode === 'daily' && b.session !== 1)
    fail('VALIDATION', 'Daily attendance uses session 1.'); if (current.status === 'saved' && b.date < today(a.config.timezone) && !b.reason)
    fail('VALIDATION', 'A correction reason is required.'); const locked = new Set(current.marks.filter(m => m.leave_locked).map(m => m.student_id)); validateAttendance(current.marks.map(m => m.student_id), locked, b.marks); let sheet = await tx.instituteAttendanceSheet.findUnique({ where: { projectId_groupId_date_session: { projectId: a.scope.projectId, groupId: b.group_id, date: date(b.date), session: b.session } } }); const changes = b.marks.filter(m => current.marks.find(v => v.student_id === m.student_id)?.status !== m.status).map(m => ({ studentId: m.student_id, from: current.marks.find(v => v.student_id === m.student_id)?.status, to: m.status })); const history = [...(sheet?.history as unknown[] ?? []), { at: new Date().toISOString(), by: a.auth.userId, reason: b.reason, changes }]; if (sheet)
    sheet = await tx.instituteAttendanceSheet.update({ where: { id: sheet.id }, data: { revision: { increment: 1 }, savedAt: new Date(), savedById: a.auth.userId, history: json(history) } });
else
    sheet = await tx.instituteAttendanceSheet.create({ data: { ...a.scope, groupId: b.group_id, date: date(b.date), session: b.session, revision: 1, savedAt: new Date(), savedById: a.auth.userId, history: json(history) } }); await tx.instituteAttendanceMark.deleteMany({ where: { ...a.scope, sheetId: sheet.id } }); await tx.instituteAttendanceMark.createMany({ data: b.marks.map(m => ({ ...a.scope, sheetId: sheet!.id, studentId: m.student_id, status: m.status })) }); let notified = 0; if (b.notify_absent)
    for (const c of changes) {
        if (c.to === 'absent' || c.to === 'late' || c.from === 'absent' || c.from === 'late')
            notified += await notify(tx, a, [c.studentId], current.status === 'saved' ? 'attendance.corrected' : 'attendance.saved', current.status === 'saved' ? 'Attendance was corrected' : 'Today’s attendance has been saved', sheet.id, current.status === 'saved' ? `attendance:${c.studentId}:${b.date}:correction:${sheet.revision}` : `attendance:${c.studentId}:${b.date}`);
    } return { revision: sheet.revision, counts: Object.fromEntries(['present', 'late', 'absent', 'leave'].map(status => [status, b.marks.filter(m => m.status === status).length])), notified }; });
read('/attendance/summary', 'attendance', async (a, req) => { if (!['office', 'auditor'].includes(a.portal))
    throw notFound(); const q = day.parse(req.query.date), groups = await groupRows(a); return Promise.all(groups.map(async (g) => { const s = await sheetView(prisma, a, g.id, q, 1); return { group_id: g.id, name: g.name, status: s.status, ...Object.fromEntries(['present', 'late', 'absent', 'leave'].map(status => [status, s.status === 'not_marked' ? 0 : s.marks.filter(m => m.status === status).length])) }; })); });
read('/attendance/students/:id', 'attendance', async (a, req) => { const s = await student(prisma, a, req.params.id), month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(req.query.month), start = date(`${month}-01`), end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)), sheets = await prisma.instituteAttendanceSheet.findMany({ where: { ...a.scope, groupId: s.groupId, date: { gte: start, lte: end } } }), marks = await prisma.instituteAttendanceMark.findMany({ where: { ...a.scope, studentId: s.id, sheetId: { in: sheets.map(v => v.id) } } }); const days = []; for (let n = 1; n <= end.getUTCDate(); n++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), n)), text = d.toISOString().slice(0, 10);
    if (d < s.joinedOn)
        continue;
    const sheetIds = sheets.filter(v => +v.date === +d).map(v => v.id), values = marks.filter(v => sheetIds.includes(v.sheetId));
    const status = a.config.week_off_days.includes(d.getUTCDay()) ? 'day_off' : values.some(v => v.status === 'absent') ? 'absent' : values.some(v => v.status === 'late') ? 'late' : values.some(v => v.status === 'present') ? 'present' : values.some(v => v.status === 'leave') ? 'leave' : 'not_marked';
    days.push({ date: text, status });
} const present = days.filter(d => d.status === 'present').length, late = days.filter(d => d.status === 'late').length, absent = days.filter(d => d.status === 'absent').length; return { days, present, late, absent, percentage: present + late + absent ? Math.round((present + late) / (present + late + absent) * 100) : null }; });
read('/leave-requests', 'leave', async (a, req) => { const students = await prisma.instituteStudent.findMany({ where: { ...studentWhere(a), ...(req.query.student_id ? { AND: { id: id.parse(req.query.student_id) } } : {}) } }), rows = await prisma.instituteLeaveRequest.findMany({ where: { ...a.scope, studentId: { in: students.map(s => s.id) } }, orderBy: { createdAt: 'desc' } }); return rows.map(r => ({ id: r.id, student_id: r.studentId, student_name: students.find(s => s.id === r.studentId)?.name, from_date: r.fromDate, to_date: r.toDate, reason: r.reason, status: r.status, revision: r.revision })); });
write('post', '/leave-requests', 'leave', async (tx, a, req) => { if (!a.family)
    throw forbidden(); const b = z.object({ student_id: id, from_date: day, to_date: day, reason: z.string().trim().min(2).max(500) }).strict().parse(req.body); await student(tx, a, b.student_id); if (b.to_date < b.from_date)
    fail('VALIDATION', 'Invalid leave dates.'); return tx.instituteLeaveRequest.create({ data: { ...a.scope, studentId: b.student_id, fromDate: date(b.from_date), toDate: date(b.to_date), reason: b.reason, requestedBy: a.auth.userId } }); });
write('post', '/leave-requests/:id/decide', 'leave', async (tx, a, req) => { if (a.family)
    throw forbidden(); const b = z.object({ revision: z.number().int(), status: z.enum(['approved', 'declined']) }).strict().parse(req.body), leave = await tx.instituteLeaveRequest.findFirst({ where: { ...a.scope, id: req.params.id } }); if (!leave)
    throw notFound(); const s = await student(tx, a, leave.studentId); if (a.portal === 'teacher' && !a.assignments.some(t => t.groupId === s.groupId && t.isClassTeacher))
    throw notFound(); assertRevision(leave, b.revision); await tx.instituteLeaveRequest.update({ where: { id: leave.id }, data: { status: b.status, decidedBy: a.auth.userId, revision: { increment: 1 } } }); return { notified: await notify(tx, a, [s.id], 'leave.decided', `Leave ${b.status}`, leave.id, `leave:${leave.id}:${leave.revision + 1}`) }; });
const paymentDto = (p: {
    id: string;
    studentId: string;
    amount: number;
    method: string;
    trxId: string | null;
    status: string;
    receiptId: string | null;
    revision: number;
}, name = '') => ({ id: p.id, student_id: p.studentId, student_name: name, amount: p.amount, method: p.method, trx_id: p.trxId, status: p.status, receipt_id: p.receiptId, revision: p.revision });
read('/fee-plans', 'fees', async (a) => { if (a.family)
    throw notFound(); return prisma.instituteFeePlan.findMany({ where: a.scope }); });
write('post', '/fee-plans', 'fees', async (tx, a, req) => { if (a.family)
    throw forbidden(); const b = z.object({ name: z.string().trim().min(2).max(120), amount: money, cycle: z.enum(['monthly', 'term', 'installment']), due_day: z.number().int().min(1).max(28), group_id: id.optional() }).strict().parse(req.body); if (b.group_id)
    await group(tx, a, b.group_id); return tx.instituteFeePlan.create({ data: { ...a.scope, name: b.name, amount: b.amount, cycle: b.cycle, dueDay: b.due_day, groupId: b.group_id } }); });
write('post', '/fee-invoices/generate', 'fees', async (tx, a, req) => { if (a.family)
    throw forbidden(); const b = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict().parse(req.body), plans = await tx.instituteFeePlan.findMany({ where: a.scope }); let generated = 0; for (const plan of plans) {
    const students = await tx.instituteStudent.findMany({ where: { ...a.scope, status: 'active', ...(plan.groupId ? { groupId: plan.groupId } : {}) } });
    for (const s of students) {
        const old = await tx.instituteFeeInvoice.findUnique({ where: { studentId_planId_period: { studentId: s.id, planId: plan.id, period: b.period } } });
        if (old)
            continue;
        await tx.instituteFeeInvoice.create({ data: { ...a.scope, studentId: s.id, planId: plan.id, period: b.period, amount: plan.amount, dueOn: date(`${b.period}-${String(plan.dueDay).padStart(2, '0')}`) } });
        generated++;
    }
} return { generated }; });
read('/fees/students/:id', 'fees', async (a, req) => { const s = await student(prisma, a, req.params.id, true); if (a.family && s.status !== 'active')
    throw notFound(); const [invoices, payments, plans] = await Promise.all([prisma.instituteFeeInvoice.findMany({ where: { ...a.scope, studentId: s.id }, orderBy: { dueOn: 'asc' } }), prisma.instituteFeePayment.findMany({ where: { ...a.scope, studentId: s.id }, orderBy: { createdAt: 'desc' } }), prisma.instituteFeePlan.findMany({ where: a.scope })]); return { invoices: invoices.map(inv => ({ id: inv.id, student_id: inv.studentId, title: plans.find(p => p.id === inv.planId)?.name ?? 'Fee', period: inv.period, amount: inv.amount, outstanding: inv.status === 'waived' ? 0 : Math.max(0, inv.amount - inv.paidAmount), due_on: inv.dueOn, status: inv.status })), payments: payments.map(p => paymentDto(p, s.name)), advance: payments.filter(p => p.status === 'verified').reduce((n, p) => n + p.advanceAmount, 0) }; });
read('/fee-payments', 'fees', async (a) => { if (a.family)
    throw notFound(); const payments = await prisma.instituteFeePayment.findMany({ where: { ...a.scope, status: 'submitted' }, orderBy: { createdAt: 'asc' } }), students = await prisma.instituteStudent.findMany({ where: { ...a.scope, id: { in: payments.map(p => p.studentId) } } }); return payments.map(p => paymentDto(p, students.find(s => s.id === p.studentId)?.name)); });
write('post', '/fee-payments', 'fees', async (tx, a, req) => { if (a.auth.menuPermissions && !a.auth.builtinRoles?.some(r => ['owner','admin'].includes(r)) && !a.auth.menuPermissions.institute_fees?.write) throw forbidden('Fee write access is required.'); const b = z.object({ student_id: id, invoice_ids: z.array(id).max(500), amount: money, method: z.enum(['cash', 'bkash', 'nagad', 'bank']), trx_id: z.string().trim().min(1).max(120).optional() }).strict().parse(req.body), s = await student(tx, a, b.student_id); if (a.family && a.portal !== 'student' && !a.links.some(l => l.studentId === s.id && l.canPay))
    throw forbidden('This guardian cannot pay.'); if (b.method !== 'cash' && !b.trx_id)
    fail('VALIDATION', 'A transaction ID is required.'); if (a.family && !a.config.family_can_pay_online && b.method !== 'cash')
    throw forbidden('Online payments are disabled.'); if (b.trx_id && await tx.instituteFeePayment.findFirst({ where: { ...a.scope, method: b.method, trxId: b.trx_id } }))
    fail('DUPLICATE_TRX_ID', 'This transaction ID was already submitted.', 409); if (new Set(b.invoice_ids).size !== b.invoice_ids.length)
    fail('VALIDATION', 'Duplicate invoice IDs.'); const count = await tx.instituteFeeInvoice.count({ where: { ...a.scope, studentId: s.id, id: { in: b.invoice_ids } } }); if (count !== b.invoice_ids.length)
    throw notFound(); const payment = await tx.instituteFeePayment.create({ data: { ...a.scope, studentId: s.id, invoiceIds: b.invoice_ids, amount: b.amount, method: b.method, trxId: b.trx_id, submittedBy: a.auth.userId } }); const staff = await tx.projectMembership.findMany({ where: { ...a.scope, isActive: true, role: { in: ['owner', 'admin', 'accountant'] } } }); for (const userId of new Set(staff.map(m => m.userId))) {
    const dedupe = `submitted:${userId}:${Math.floor(Date.now() / 600000)}`;
    if (!await tx.instituteNotificationDelivery.findFirst({ where: { ...a.scope, userId, dedupeKey: dedupe, channel: 'inbox' } })) {
        await tx.notification.create({ data: { ...a.scope, recipientUserId: userId, actorUserId: a.auth.userId, type: 'fee.payment.submitted', title: 'Fee payments are waiting to verify', body: 'Open the institute accounts portal.', entityType: 'institute', entityId: payment.id } });
        await tx.instituteNotificationDelivery.create({ data: { ...a.scope, userId, dedupeKey: dedupe, channel: 'inbox', status: 'sent', type: 'fee.payment.submitted', title: 'Payments waiting', body: '', entityId: payment.id } });
    }
} return paymentDto(payment, s.name); }, true);
write('post', '/fee-payments/:id/verify', 'fees', async (tx, a, req) => { if (a.family)
    throw forbidden(); const b = z.object({ revision: z.number().int().nonnegative(), account_id: id.optional() }).strict().parse(req.body), p = await tx.instituteFeePayment.findFirst({ where: { ...a.scope, id: req.params.id } }); if (!p)
    throw notFound(); if (p.status === 'verified')
    return { receipt_id: p.receiptId, notified: 0 }; if (p.status !== 'submitted')
    fail('PAYMENT_ALREADY_FINAL', 'This payment is already final.', 409); assertRevision(p, b.revision); const account = await tx.account.findFirst({ where: { ...a.scope, ...(b.account_id ? { id: b.account_id } : { isDefault: true }) } }); if (!account)
    fail('VALIDATION', 'Set up a default receiving account before verifying.'); let remaining = p.amount; const invoices = await tx.instituteFeeInvoice.findMany({ where: { ...a.scope, studentId: p.studentId, status: { in: ['open', 'partial'] } }, orderBy: [{ dueOn: 'asc' }, { id: 'asc' }] }); for (const inv of invoices) {
    if (!remaining)
        break;
    const amount = Math.min(remaining, inv.amount - inv.paidAmount);
    await tx.instituteFeeInvoice.update({ where: { id: inv.id }, data: { paidAmount: { increment: amount }, status: inv.paidAmount + amount === inv.amount ? 'paid' : 'partial', revision: { increment: 1 } } });
    remaining -= amount;
} const receipt = await tx.instituteFeeReceipt.create({ data: { ...a.scope, studentId: p.studentId, paymentId: p.id, receiptNo: `INS-${p.id}`, amount: p.amount, method: p.method, issuedBy: a.auth.userId } }); const updated = await tx.account.update({ where: { id: account!.id }, data: { balance: { increment: p.amount } } }); await tx.accountTransaction.create({ data: { ...a.scope, accountId: account!.id, direction: 'money_in', amount: p.amount, balanceAfter: updated.balance, referenceType: 'institute_fee_payment', referenceId: p.id, requestKey: `institute:${p.id}`, createdById: a.auth.userId, description: 'Institute fee receipt' } }); await tx.instituteFeePayment.update({ where: { id: p.id }, data: { status: 'verified', verifiedBy: a.auth.userId, receiptId: receipt.id, accountId: account!.id, advanceAmount: remaining, revision: { increment: 1 } } }); await tx.instituteDocument.create({ data: { ...a.scope, studentId: p.studentId, category: 'receipt', title: `Receipt ${receipt.receiptNo}`, receiptId: receipt.id, visibleFrom: new Date() } }); return { receipt_id: receipt.id, notified: await notify(tx, a, [p.studentId], 'fee.payment.verified', 'Payment verified · your receipt is ready', receipt.id, `verified:${p.id}`) }; });
write('post', '/fee-payments/:id/reject', 'fees', async (tx, a, req) => { if (a.family)
    throw forbidden(); const b = z.object({ revision: z.number().int().nonnegative(), reason: z.string().trim().min(2).max(500) }).strict().parse(req.body), p = await tx.instituteFeePayment.findFirst({ where: { ...a.scope, id: req.params.id } }); if (!p)
    throw notFound(); assertRevision(p, b.revision); if (p.status !== 'submitted')
    fail('PAYMENT_ALREADY_FINAL', 'This payment is already final.', 409); await tx.instituteFeePayment.update({ where: { id: p.id }, data: { status: 'rejected', revision: { increment: 1 }, history: json([{ at: new Date().toISOString(), by: a.auth.userId, reason: b.reason }]) } }); return { notified: await notify(tx, a, [p.studentId], 'fee.payment.rejected', 'Payment rejected · contact the office', p.id, `rejected:${p.id}`) }; });
write('post', '/fees/reminders', 'fees', async (tx, a, req) => { if (a.family)
    throw forbidden(); const b = z.object({ student_ids: z.array(id).min(1).max(1000) }).strict().parse(req.body); let notified = 0; for (const studentId of new Set(b.student_ids)) {
    await student(tx, a, studentId);
    const previous = await tx.instituteNotificationDelivery.findFirst({ where: { ...a.scope, dedupeKey: { startsWith: `fee-reminder:${studentId}:` }, createdAt: { gt: new Date(Date.now() - 48 * 3600000) } } });
    if (previous)
        fail('RATE_LIMITED', 'A reminder was sent less than 48 hours ago.', 429, { retry_after: Math.ceil((+previous.createdAt + 48 * 3600000 - Date.now()) / 1000) });
    notified += await notify(tx, a, [studentId], 'fee.reminder', 'A fee payment is due', studentId, `fee-reminder:${studentId}:${Date.now()}`);
} return { notified }; });
read('/posts', 'posts', async (a, req) => { const studentId = req.query.student_id === undefined ? undefined : id.parse(req.query.student_id); if (studentId)
    await student(prisma, a, studentId); const recipientRows = a.family ? await prisma.institutePostRecipient.findMany({ where: { ...a.scope, userId: a.auth.userId, studentId: studentId ?? { in: a.studentIds } } }) : []; const rows = await prisma.institutePost.findMany({ where: { ...a.scope, withdrawnAt: null, sentAt: { not: null }, ...(a.family ? { id: { in: recipientRows.map(r => r.postId) } } : a.portal === 'teacher' ? { authorUserId: a.auth.userId } : {}) }, orderBy: { sentAt: 'desc' }, take: 200 }); const authors = await tenantAccounts(prisma).findMany({ where: { tenantId: a.scope.tenantId, id: { in: rows.map(p => p.authorUserId) } }, select: { id: true, name: true } }); return rows.map(p => { const r = recipientRows.find(r => r.postId === p.id); return { id: p.id, kind: p.kind, title: p.title, body: p.body, author_name: authors.find(u => u.id === p.authorUserId)?.name ?? '', sent_at: p.sentAt, requires_ack: p.requiresAck, read_at: r?.readAt, ack_at: r?.ackAt, due_on: p.dueOn, file_ids: p.fileIds }; }); });
write('post', '/posts', 'posts', async (tx, a, req) => { if (a.family)
    throw forbidden(); const b = z.object({ kind: z.enum(['notice', 'homework', 'document']), title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000), group_ids: z.array(id).min(1).max(100), requires_ack: z.boolean(), due_on: day.optional(), file_ids: z.array(id).max(10) }).strict().parse(req.body); for (const groupId of b.group_ids)
    await group(tx, a, groupId); if (b.kind === 'document' && !b.file_ids.length)
    fail('VALIDATION', 'Attach a document.'); const uploads = await tx.upload.findMany({ where: { ...a.scope, id: { in: b.file_ids }, purpose: 'institute_document', deletedAt: null, ...(a.portal === 'teacher' ? { userId: a.auth.userId } : {}) } }); if (uploads.length !== new Set(b.file_ids).size)
    throw notFound(); const p = await tx.institutePost.create({ data: { ...a.scope, kind: b.kind, title: b.title, body: b.body, groupIds: b.group_ids, requiresAck: b.requires_ack, dueOn: b.due_on ? date(b.due_on) : null, fileIds: b.file_ids, authorUserId: a.auth.userId, sentAt: new Date() } }); const students = await tx.instituteStudent.findMany({ where: { ...a.scope, groupId: { in: b.group_ids }, status: 'active' } }), audience = await recipients(tx, a, students.map(s => s.id)); await tx.institutePostRecipient.createMany({ data: audience.map(r => ({ ...a.scope, postId: p.id, studentId: r.studentId, userId: r.userId })) }); for (const groupId of b.group_ids)
    for (const upload of uploads)
        await tx.instituteDocument.create({ data: { ...a.scope, groupId, postId: p.id, title: upload.fileName, category: b.kind, fileId: upload.id, visibleFrom: new Date() } }); return { notified: await notify(tx, a, students.map(s => s.id), 'post.sent', 'A new class post is ready', p.id, `post:${p.id}`) }; });
for (const action of ['read', 'ack'] as const)
    write('post', `/posts/:id/${action}`, 'posts', async (tx, a, req) => { const active = await tx.instituteStudent.findMany({ where: studentWhere(a), select: { id: true } }); const rows = await tx.institutePostRecipient.findMany({ where: { ...a.scope, postId: req.params.id, userId: a.auth.userId, studentId: { in: active.map(s=>s.id) } } }); if (!rows.length)
        throw notFound(); await tx.institutePostRecipient.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { readAt: new Date(), ...(action === 'ack' ? { ackAt: new Date() } : {}) } }); return { saved: true }; });
read('/posts/:id/stats', 'posts', async (a, req) => { const p = await prisma.institutePost.findFirst({ where: { ...a.scope, id: req.params.id, ...(a.portal === 'office' ? {} : { authorUserId: a.auth.userId }) } }); if (!p)
    throw notFound(); const rows = await prisma.institutePostRecipient.findMany({ where: { ...a.scope, postId: p.id } }); return { delivered: rows.length, read: rows.filter(r => r.readAt).length, acknowledged: rows.filter(r => r.ackAt).length }; });
write('post', '/posts/:id/remind', 'posts', async (tx, a, req) => { if (a.family)
    throw forbidden(); const p = await tx.institutePost.findFirst({ where: { ...a.scope, id: req.params.id, ...(a.portal === 'office' ? {} : { authorUserId: a.auth.userId }) } }); if (!p)
    throw notFound(); if (await tx.instituteNotificationDelivery.count({ where: { ...a.scope, dedupeKey: { startsWith: `post-remind:${p.id}:` }, createdAt: { gt: new Date(Date.now() - 12 * 3600000) } } }))
    fail('RATE_LIMITED', 'Wait 12 hours before another reminder.', 429); const unread = await tx.institutePostRecipient.findMany({ where: { ...a.scope, postId: p.id, readAt: null } }); return { notified: await notify(tx, a, Array.from(new Set(unread.map(r => r.studentId))), 'post.remind', 'A class post is waiting to be opened', p.id, `post-remind:${p.id}:${Date.now()}`, unread.map(r => r.userId)) }; });
read('/documents', 'documents', async (a, req) => {
  const studentId = req.query.student_id === undefined ? undefined : id.parse(req.query.student_id);
  const students = await prisma.instituteStudent.findMany({ where: { ...studentWhere(a,true), ...(a.family ? { OR: [{ status:'active' }, { leftOn:{gte:new Date(Date.now()-90*86400000)} }] } : {}) } });
  if (studentId && !students.some(s=>s.id===studentId)) throw notFound();
  const selected = studentId ? students.filter(s=>s.id===studentId) : students;
  const activeIds = selected.filter(s=>s.status==='active').map(s=>s.id), historyIds = selected.filter(s=>s.status!=='active').map(s=>s.id);
  const groupIds = a.family ? selected.filter(s=>s.status==='active').map(s=>s.groupId) : a.portal==='teacher' ? a.groupIds : undefined;
  const postRecipients = a.family ? await prisma.institutePostRecipient.findMany({ where:{...a.scope,userId:a.auth.userId,studentId:{in:activeIds}} }) : [];
  return (await prisma.instituteDocument.findMany({ where: {
    ...a.scope, visibleFrom:{lte:new Date()}, ...(a.portal==='teacher'?{receiptId:null,publicationId:null}:{}),
    ...(a.family ? { AND:{ OR:[{postId:null},{postId:{in:postRecipients.map(r=>r.postId)}}] } } : {}),
    OR:[{studentId:{in:a.family?activeIds:selected.map(s=>s.id)}},{groupId:groupIds?{in:groupIds}:{not:null}},...(a.family?[{studentId:{in:historyIds},OR:[{receiptId:{not:null}},{publicationId:{not:null}}]}]:[])]
  },orderBy:{visibleFrom:'desc'} })).map(d=>({id:d.id,title:d.title,category:d.category.startsWith('result:')?'Report card':d.category,visible_from:d.visibleFrom}));
});
write('post', '/documents', 'documents', async (tx, a, req) => { if (a.family)
    throw forbidden(); const b = z.object({ student_id: id.optional(), group_id: id.optional(), category: z.string().min(1), title: z.string().min(1), file_id: id, visible_from: z.string().datetime() }).strict().parse(req.body); if (Boolean(b.student_id) === Boolean(b.group_id))
    fail('VALIDATION', 'Choose a student or a group.'); if (b.student_id)
    await student(tx, a, b.student_id); if (b.group_id)
    await group(tx, a, b.group_id); if (['receipt', 'report_card'].includes(b.category))
    fail('VALIDATION', 'Receipts and report cards are generated.'); if (!await tx.upload.findFirst({ where: { ...a.scope, id: b.file_id, purpose: 'institute_document', deletedAt: null } }))
    throw notFound(); return tx.instituteDocument.create({ data: { ...a.scope, studentId: b.student_id, groupId: b.group_id, category: b.category, title: b.title, fileId: b.file_id, visibleFrom: new Date(b.visible_from) } }); });
read('/exams', 'results', async (a) => { const groups = await groupRows(a), groupIds = groups.map(g => g.id), publications = await prisma.instituteResultPublication.findMany({ where: { ...a.scope, groupId: { in: groupIds } } }); const exams = await prisma.instituteExam.findMany({ where: { ...a.scope, groupIds: { hasSome: groupIds }, ...(a.family ? { id: { in: publications.map(p => p.examId) } } : {}) }, orderBy: { createdAt: 'desc' } }), sheets = await prisma.instituteMarkSheet.findMany({ where: { ...a.scope, examId: { in: exams.map(e => e.id) }, groupId: { in: groupIds }, ...(a.portal === 'teacher' ? { subjectId: { in: a.assignments.flatMap(t => t.subjectId ? [t.subjectId] : []) } } : {}) } }); return exams.map(e => ({ id: e.id, name: e.name, group_ids: e.groupIds.filter(g => groupIds.includes(g)), revision: e.revision, publications: publications.filter(p => p.examId === e.id).map(p => ({ group_id: p.groupId, version: p.version })), sheets: a.family ? [] : sheets.filter(s => s.examId === e.id).map(s => ({ group_id: s.groupId, subject_id: s.subjectId, status: s.status })) })); });
write('post', '/exams', 'groups', async (tx, a, req) => { const b = z.object({ name: z.string().min(2).max(120), group_ids: z.array(id).min(1), subject_ids: z.array(id).min(1), starts_on: day, ends_on: day, grading: z.enum(['bd_gpa5', 'bands']).optional() }).strict().parse(req.body); if (b.ends_on < b.starts_on)
    fail('VALIDATION', 'Invalid exam dates.'); for (const groupId of b.group_ids)
    await group(tx, a, groupId); if (await tx.instituteSubject.count({ where: { ...a.scope, id: { in: b.subject_ids } } }) !== new Set(b.subject_ids).size)
    throw notFound(); const exam = await tx.instituteExam.create({ data: { ...a.scope, name: b.name, groupIds: Array.from(new Set(b.group_ids)), subjectIds: Array.from(new Set(b.subject_ids)), startsOn: date(b.starts_on), endsOn: date(b.ends_on), grading: b.grading } }); for (const groupId of exam.groupIds)
    for (const subjectId of exam.subjectIds)
        await tx.instituteMarkSheet.create({ data: { ...a.scope, examId: exam.id, groupId, subjectId } }); return { id: exam.id }; });
async function scopedSheet(tx: Tx | typeof prisma, a: Access, params: Request['params']) { await group(tx, a, params.groupId); const sheet = await tx.instituteMarkSheet.findFirst({ where: { ...a.scope, examId: params.id, groupId: params.groupId, subjectId: params.subjectId } }); if (!sheet)
    throw notFound(); if (a.portal === 'teacher' && (!a.assignments.some(t => t.groupId === sheet.groupId && t.subjectId === sheet.subjectId) || sheet.authorUserId && sheet.authorUserId !== a.auth.userId))
    throw notFound(); if (a.family)
    throw notFound(); return sheet; }
read('/exams/:id/sheets/:groupId/:subjectId', 'results', async (a, req) => { const sheet = await scopedSheet(prisma, a, req.params); if (sheet.status !== 'submitted' && a.portal !== 'teacher')
    throw notFound(); const students = await prisma.instituteStudent.findMany({ where: { ...a.scope, groupId: sheet.groupId, status: 'active' }, orderBy: { rollNo: 'asc' } }), marks = await prisma.instituteMark.findMany({ where: { ...a.scope, sheetId: sheet.id } }), subject = await prisma.instituteSubject.findFirstOrThrow({ where: { ...a.scope, id: sheet.subjectId } }); return { exam_id: sheet.examId, group_id: sheet.groupId, subject_id: sheet.subjectId, revision: sheet.revision, status: sheet.status, marks: students.map(s => { const mark = marks.find(m => m.studentId === s.id); return { student_id: s.id, name: s.name, absent: mark?.absent ?? false, components: mark?.components ?? Object.fromEntries((subject.components as {
            key: string;
        }[]).map(c => [c.key, null])) }; }) }; });
write('put', '/exams/:id/sheets/:groupId/:subjectId', 'results', async (tx, a, req) => { if (a.portal !== 'teacher')
    throw forbidden('Only the assigned teacher can edit their draft.'); const sheet = await scopedSheet(tx, a, req.params), b = z.object({ revision: z.number().int().nonnegative(), marks: z.array(z.object({ student_id: id, absent: z.boolean(), components: z.record(z.number().nullable()) }).strict()).max(5000) }).strict().parse(req.body); assertRevision(sheet, b.revision); if (sheet.status === 'submitted')
    fail('SHEET_LOCKED', 'An administrator must return this sheet.', 409); const subject = await tx.instituteSubject.findFirstOrThrow({ where: { ...a.scope, id: sheet.subjectId } }), components = subject.components as {
    key: string;
    max: number;
}[], students = await tx.instituteStudent.findMany({ where: { ...a.scope, groupId: sheet.groupId, status: 'active' } }); if (new Set(b.marks.map(m => m.student_id)).size !== b.marks.length || b.marks.some(m => !students.some(s => s.id === m.student_id)))
    throw notFound(); for (const m of b.marks) {
    for (const [key, value] of Object.entries(m.components)) {
        const c = components.find(c => c.key === key);
        if (!c || value !== null && (!Number.isFinite(value) || value < 0 || value > c.max))
            fail('MARKS_OUT_OF_RANGE', 'Marks are outside the component range.');
    }
} await tx.instituteMark.deleteMany({ where: { ...a.scope, sheetId: sheet.id } }); await tx.instituteMark.createMany({ data: b.marks.map(m => ({ ...a.scope, sheetId: sheet.id, studentId: m.student_id, absent: m.absent, components: json(m.components) })) }); const updated = await tx.instituteMarkSheet.update({ where: { id: sheet.id }, data: { authorUserId: a.auth.userId, revision: { increment: 1 }, history: json([...(sheet.history as unknown[]), { at: new Date().toISOString(), by: a.auth.userId, action: 'draft.saved' }]) } }); return { revision: updated.revision }; });
write('post', '/exams/:id/sheets/:groupId/:subjectId/submit', 'results', async (tx, a, req) => { if (a.portal !== 'teacher')
    throw forbidden(); const sheet = await scopedSheet(tx, a, req.params), b = z.object({ revision: z.number().int().nonnegative() }).strict().parse(req.body); assertRevision(sheet, b.revision); if (sheet.status === 'submitted')
    fail('SHEET_LOCKED', 'This sheet is submitted.', 409); const roster = await tx.instituteStudent.findMany({ where: { ...a.scope, groupId: sheet.groupId, status: 'active' } }), marks = await tx.instituteMark.findMany({ where: { ...a.scope, sheetId: sheet.id } }), subject = await tx.instituteSubject.findFirstOrThrow({ where: { ...a.scope, id: sheet.subjectId } }), components = subject.components as {
    key: string;
    max: number;
}[]; if (roster.some(s => { const mark = marks.find(m => m.studentId === s.id); return !mark || !mark.absent && components.some(c => { const value = (mark.components as Record<string, number | null>)[c.key]; return value === undefined || value === null || value < 0 || value > c.max; }); }))
    fail('RESULTS_INCOMPLETE', 'Every student needs complete marks or absent.', 409); const updated = await tx.instituteMarkSheet.update({ where: { id: sheet.id }, data: { status: 'submitted', revision: { increment: 1 } } }); await tx.instituteExam.update({ where: { id: sheet.examId }, data: { revision: { increment: 1 } } }); return { revision: updated.revision }; });
write('post', '/exams/:id/sheets/:groupId/:subjectId/return', 'results', async (tx, a, req) => { if (a.portal !== 'office')
    throw forbidden(); const sheet = await scopedSheet(tx, a, req.params), b = z.object({ revision: z.number().int(), reason: z.string().trim().min(2).max(500) }).strict().parse(req.body); assertRevision(sheet, b.revision); return tx.instituteMarkSheet.update({ where: { id: sheet.id }, data: { status: 'returned', revision: { increment: 1 }, history: json([...(sheet.history as unknown[]), { at: new Date().toISOString(), by: a.auth.userId, reason: b.reason }]) } }); });
for (const correction of [false, true])
    write('post', `/exams/:id/groups/:groupId/${correction ? 'corrections' : 'publish'}`, 'results', async (tx, a, req) => { if (a.portal !== 'office')
        throw forbidden(); await group(tx, a, req.params.groupId); const b = z.object({ revision: z.number().int().nonnegative(), show_position: z.boolean(), reason: z.string().trim().min(2).max(500).optional() }).strict().parse(req.body), exam = await tx.instituteExam.findFirst({ where: { ...a.scope, id: req.params.id, groupIds: { has: req.params.groupId } } }); if (!exam)
        throw notFound(); assertRevision(exam, b.revision); const previous = await tx.instituteResultPublication.findFirst({ where: { ...a.scope, examId: exam.id, groupId: req.params.groupId }, orderBy: { version: 'desc' } }); if (correction && (!previous || !b.reason) || !correction && previous)
        fail('VALIDATION', correction ? 'A previous publication and correction reason are required.' : 'Use a correction to publish another version.'); const sheets = await tx.instituteMarkSheet.findMany({ where: { ...a.scope, examId: exam.id, groupId: req.params.groupId } }); if (exam.subjectIds.some(id => !sheets.some(s => s.subjectId === id && s.status === 'submitted')))
        fail('RESULTS_INCOMPLETE', 'All subject sheets must be submitted.', 409, { subjects: exam.subjectIds.filter(id => !sheets.some(s => s.subjectId === id && s.status === 'submitted')) }); const subjects = await tx.instituteSubject.findMany({ where: { ...a.scope, id: { in: exam.subjectIds } } }), roster = await tx.instituteStudent.findMany({ where: { ...a.scope, groupId: req.params.groupId, status: 'active' } }), marks = await tx.instituteMark.findMany({ where: { ...a.scope, sheetId: { in: sheets.map(s => s.id) } } }); const grading = exam.grading ?? a.config.grading; const results = roster.map(s => { const values = subjects.map(subject => { const sheet = sheets.find(v => v.subjectId === subject.id)!, mark = marks.find(m => m.sheetId === sheet.id && m.studentId === s.id); if (!mark)
        fail('RESULTS_INCOMPLETE', 'A student is missing marks.', 409); const total = mark!.absent ? 0 : Object.values(mark!.components as Record<string, number | null>).reduce<number>((n, v) => n + (v ?? 0), 0); return { name: subject.name, total, grade: grading === 'bands' ? (mark!.absent || total < subject.passPercent ? 'Refer' : total >= 80 ? 'Distinction' : total >= 60 ? 'Merit' : 'Pass') : mark!.absent || total < subject.passPercent ? 'F' : gpa(total).grade, absent: mark!.absent, failed: mark!.absent || total < subject.passPercent }; }); const grade = resultGrade(values.map(v => v.total), grading, values.map(v => v.absent || v.failed)); return { student_id: s.id, exam_name: exam.name, total: values.reduce((n, v) => n + v.total, 0), ...grade, subjects: values.map(({ absent, failed, ...v }) => v) }; }); const showPosition = b.show_position && a.config.subtype !== 'training', positions = showPosition ? densePositions(results) : {}, version = (previous?.version ?? 0) + 1; const snapshot = results.map(r => ({ ...r, ...(r.passed && positions[r.student_id] ? { position: positions[r.student_id] } : {}) })); const published = await tx.instituteResultPublication.create({ data: { ...a.scope, examId: exam.id, groupId: req.params.groupId, version, showPosition, snapshot: json(snapshot), publishedBy: a.auth.userId, reason: b.reason } }); await tx.instituteExam.update({ where: { id: exam.id }, data: { revision: { increment: 1 } } }); for (const row of snapshot) { const oldDoc = await tx.instituteDocument.findFirst({ where: { ...a.scope, studentId: row.student_id, category: `result:${exam.id}` } }); if (oldDoc) await tx.instituteDocument.update({ where: { id: oldDoc.id }, data: { publicationId: published.id, revision: { increment: 1 } } }); else await tx.instituteDocument.create({ data: { ...a.scope, studentId: row.student_id, category: `result:${exam.id}`, title: `${exam.name} · Report card`, publicationId: published.id, visibleFrom: new Date() } }); } const old = (previous?.snapshot ?? []) as unknown as typeof snapshot, affected = snapshot.filter(r => JSON.stringify(old.find(o => o.student_id === r.student_id)) !== JSON.stringify(r)).map(r => r.student_id); return { version, notified: await notify(tx, a, affected, correction ? 'results.corrected' : 'results.published', correction ? 'A corrected result is ready' : 'Results have been published', published.id, `results:${published.id}`) }; });
read('/results/students/:id', 'results', async (a, req) => { if (a.portal === 'teacher') throw notFound(); const s = await student(prisma, a, req.params.id, true); if (a.family && s.status !== 'active' && (!s.leftOn || Date.now() - +s.leftOn > 90 * 86400000))
    throw notFound(); const examId = id.parse(req.query.exam_id), pub = await prisma.instituteResultPublication.findFirst({ where: { ...a.scope, examId, groupId: s.groupId }, orderBy: { version: 'desc' } }); if (!pub)
    fail('RESULT_NOT_PUBLISHED', 'This result has not been published.', 404); const rows = pub!.snapshot as unknown as {
    student_id: string;
}[], result = rows.find(r => r.student_id === s.id); if (!result)
    throw notFound(); return { ...result, version: pub!.version, corrected: pub!.version > 1 }; });
read('/documents/:id/view', 'documents', async (a, req) => documentUrl(a, req));
router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => { if (error instanceof ZodError)
    return res.status(422).json({ ok: false, error: { code: 'VALIDATION', message: error.issues[0]?.message, fields: Object.fromEntries(error.issues.map(i => [i.path.join('.'), i.message])) } }); if (error instanceof ApiError && error.code === 'REVISION_CONFLICT')
    return res.status(409).json({ ok: false, error: { code: error.code, message: error.message, current: (error as ApiError & {
                current: unknown;
            }).current } }); return next(error); });
export const instituteRouter = router;
