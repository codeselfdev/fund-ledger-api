import { z } from 'zod';
import { dateSchema } from '../accounting/workflow.js';
import { id, money, requestKey } from '../billing/billing.policy.js';
import { mobile } from './payroll.policy.js';
import type { EmploymentTerms, EmployeeProfile, OfficeProject } from './portal.types.js';
const text = z.string().trim().max(2000), name = z.string().trim().min(2).max(120), ref = id.nullable();
export const employmentType = z.enum(['permanent', 'contractual', 'part_time']);
export const termsSchema = z.object({ type: employmentType, basic: money, medical: money, transport: money, pfMember: z.boolean(), probationMonths: z.number().int().min(0).max(24), noticeDays: z.number().int().min(0).max(365), contractStart: dateSchema.nullable(), contractEnd: dateSchema.nullable(), monthlyFee: money, hourlyRate: money, weeklyHours: z.number().finite().min(1).max(84), workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).strict().superRefine((t, c) => {
  if (new Set(t.workingDays).size !== t.workingDays.length) c.addIssue({ code: 'custom', message: 'Choose each work day once' });
  if (t.type === 'permanent' && t.basic <= 0 || t.type === 'contractual' && (t.monthlyFee <= 0 || !t.contractStart || !t.contractEnd || t.contractStart > t.contractEnd) || t.type === 'part_time' && t.hourlyRate <= 0) c.addIssue({ code: 'custom', message: 'Complete the pay and dates for this employment type' });
  if (t.type !== 'permanent' && t.pfMember) c.addIssue({ code: 'custom', message: 'PF membership applies to permanent employees' });
});
const profileFields = { email: z.union([z.string().trim().email().max(200), z.literal('')]), nationalId: text, birthDate: dateSchema.nullable(), bloodGroup: z.string().trim().max(10), address: text, emergencyContact: text, bankAccount: text, reportsToId: ref, departmentId: ref, designationId: ref, workLocation: z.enum(['office', 'field', 'hybrid']), locationRequired: z.boolean() };
export const employeeCreateSchema = z.object({ ...profileFields, name, mobile: z.string().max(30).transform(mobile).pipe(z.string().regex(/^01[3-9]\d{8}$/)), joiningDate: dateSchema, terms: termsSchema, assignments: z.array(z.object({ projectId: id, role: z.string().trim().max(120), percent: z.number().int().min(1).max(100) }).strict()).max(100), requestedDocuments: z.array(z.string().trim().min(1).max(120)).max(20), request_key: requestKey }).strict().refine(v => new Set(v.assignments.map(a => a.projectId)).size === v.assignments.length && v.assignments.reduce((n,a) => n+a.percent,0) <= 100, 'Project allocations must be unique and total at most 100%');
export const profileSchema = z.object({ ...profileFields, name, mobile: z.string().max(30).transform(mobile).pipe(z.string().regex(/^01[3-9]\d{8}$/)), revision: z.number().int().nonnegative(), employeeRevision: z.number().int().nonnegative(), request_key: requestKey }).strict();
export const promotionSchema = z.object({ designationId: id, basic: money.refine(n => n > 0), effectiveDate: dateSchema, reason: z.string().trim().min(3).max(2000), revision: z.number().int().nonnegative(), employeeRevision: z.number().int().nonnegative(), request_key: requestKey }).strict();
export const departmentSchema = z.object({ name, code: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9_-]+$/), headId: ref, parentId: ref, request_key: requestKey }).strict();
export const designationSchema = z.object({ departmentId: id, title: name, grade: z.number().int().min(1).max(20), minSalary: money.refine(n => n > 0), maxSalary: money, reportsToId: ref, types: z.array(employmentType).min(1).max(3), request_key: requestKey }).strict().refine(v => v.maxSalary >= v.minSalary && new Set(v.types).size === v.types.length, 'Use a valid salary band and unique employment types');
export const officeProjectSchema = z.object({ code: z.string().trim().min(1).max(30), name, kind: z.enum(['internal', 'client']), departmentId: ref, leadId: ref, startDate: dateSchema, endDate: dateSchema, description: text, status: z.enum(['active', 'completed']), site: z.enum(['office', 'site']), address: text, latitude: z.number().finite().min(-90).max(90).nullable(), longitude: z.number().finite().min(-180).max(180).nullable(), radiusM: z.number().int().min(25).max(5000), team: z.array(z.object({ employeeId: id, role: z.string().trim().max(120), percent: z.number().int().min(1).max(100) }).strict()).min(1).max(1000), revision: z.number().int().nonnegative().optional(), request_key: requestKey }).strict().refine(v => v.endDate >= v.startDate && new Set(v.team.map(t => t.employeeId)).size === v.team.length && (v.latitude === null) === (v.longitude === null) && (v.site === 'office' || v.latitude !== null), 'Check project dates, unique team members and site coordinates');
export const taskCreateSchema = z.object({ employeeId: id, projectId: id, title: z.string().trim().min(3).max(500), dueDate: dateSchema, status: z.enum(['todo', 'in_progress', 'done']), request_key: requestKey }).strict();
export const taskStatusSchema = z.object({ status: z.enum(['todo', 'in_progress', 'done']), revision: z.number().int().nonnegative(), request_key: requestKey }).strict();
export const splitSchema = z.object({ date: dateSchema, revision: z.number().int().nonnegative().nullable(), allocations: z.array(z.object({ projectId: id, percent: z.number().int().min(1).max(100) }).strict()).min(1).max(100), request_key: requestKey }).strict().refine(v => v.allocations.reduce((n,a) => n+a.percent,0) === 100 && new Set(v.allocations.map(a => a.projectId)).size === v.allocations.length, 'Today’s split must total 100% across unique projects');
export const documentSchema = z.object({ employeeId: id, title: name, category: z.enum(['Identity', 'Employment', 'Education', 'Payroll', 'Policy', 'Tax']), request_key: requestKey }).strict();
export const documentActionSchema = z.object({ action: z.enum(['upload', 'verify', 'acknowledge']), fileId: id.optional(), revision: z.number().int().nonnegative(), request_key: requestKey }).strict();
export const locationConsentSchema = z.object({ consent: z.boolean(), request_key: requestKey }).strict();
export const locationRequestSchema = z.object({ request_key: requestKey }).strict();
export const locationRequestAnswerSchema = z.object({ accept: z.boolean(), revision: z.number().int().nonnegative(), request_key: requestKey }).strict();
export const locationSchema = z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), accuracy: z.number().finite().min(0).max(100), captured_at: z.string().datetime(), mocked: z.boolean().optional(), request_key: requestKey }).strict();
export function allocationIssue(candidate: OfficeProject, projects: OfficeProject[]) {
  if (candidate.status === 'completed') return null;
  for (const member of candidate.team) {
    const others = projects.filter(p => p.id !== candidate.id && p.status === 'active' && p.startDate <= candidate.endDate && p.endDate >= candidate.startDate);
    const dates = new Set([candidate.startDate, ...others.map(p => p.startDate).filter(d => d >= candidate.startDate && d <= candidate.endDate)]);
    for (const date of dates) if (member.percent + others.filter(p => p.startDate <= date && p.endDate >= date).reduce((n,p) => n+(p.team.find(t => t.employeeId === member.employeeId)?.percent ?? 0),0) > 100) return `${member.employeeId} would exceed 100% allocated time on ${date}`;
  }
  return null;
}
export { effectiveEmployment, defaultTerms } from './portal.pay.js';
