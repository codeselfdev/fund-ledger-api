import { z } from 'zod';
import { id, day, date, fail } from './institute.policy.js';
import { notFound } from '../../core/http/api-error.js';
import { group, assertRevision, type Tx, type Access } from './institute.service.js';
export async function saveRoutine(tx: Tx, a: Access, groupId: string, input: unknown, preview = false) {
    const g = await group(tx, a, groupId), b = z.object({ revision: z.number().int(), slots: z.array(z.object({ weekday: z.number().int().min(0).max(6), starts_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), ends_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), subject_id: id, teacher_user_id: id, room: z.string().optional(), effective_from: day, effective_to: day.optional() })).max(100) }).strict().parse(input);
    assertRevision(g, b.revision);
    for (const slot of b.slots) {
        if (slot.ends_at <= slot.starts_at || slot.effective_to && slot.effective_to < slot.effective_from)
            fail('VALIDATION', 'Invalid routine time range.');
        if (!await tx.instituteSubject.findFirst({ where: { ...a.scope, id: slot.subject_id } }) || !await tx.instituteTeacherAssignment.findFirst({ where: { ...a.scope, userId: slot.teacher_user_id, groupId: g.id } }))
            throw notFound();
    }
    const others = await tx.instituteRoutineSlot.findMany({ where: { ...a.scope, groupId: { not: g.id }, teacherUserId: { in: b.slots.map(s => s.teacher_user_id) } } });
    const all = [...b.slots.map(s => ({ groupId: g.id, weekday: s.weekday, startsAt: s.starts_at, endsAt: s.ends_at, teacherUserId: s.teacher_user_id, effectiveFrom: date(s.effective_from), effectiveTo: s.effective_to ? date(s.effective_to) : null })), ...others];
    for (let x = 0; x < all.length; x++)
        for (let y = x + 1; y < all.length; y++) {
            const l = all[x], r = all[y];
            if ((l.groupId === g.id || r.groupId === g.id) && l.weekday === r.weekday && (l.groupId === r.groupId || l.teacherUserId === r.teacherUserId) && l.startsAt < r.endsAt && r.startsAt < l.endsAt && (!l.effectiveTo || l.effectiveTo >= r.effectiveFrom) && (!r.effectiveTo || r.effectiveTo >= l.effectiveFrom))
                fail('ROUTINE_CONFLICT', 'The group or teacher already has a session at this time.', 409);
        }
    if (preview) return { revision: g.revision };
    await tx.instituteRoutineSlot.deleteMany({ where: { ...a.scope, groupId: g.id } });
    await tx.instituteRoutineSlot.createMany({ data: b.slots.map(s => ({ ...a.scope, groupId: g.id, weekday: s.weekday, startsAt: s.starts_at, endsAt: s.ends_at, subjectId: s.subject_id, teacherUserId: s.teacher_user_id, room: s.room, effectiveFrom: date(s.effective_from), effectiveTo: s.effective_to ? date(s.effective_to) : null })) });
    return tx.instituteGroup.update({ where: { id: g.id }, data: { revision: { increment: 1 } } });
}
