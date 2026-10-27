import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../../core/prisma/client.js';
import { env } from '../../config/env.js';
import { badRequest, conflict, serviceUnavailable } from '../../core/http/api-error.js';
import { buildProjectInvitationLink, sendProjectInvitationEmail } from '../../core/invitations/project-invitation.service.js';
import { financialTransaction } from '../accounting/transaction.js';
import { profileSchema } from './portal.policy.js';
import { allowed, employee, project, scope, type PayrollAuth } from './payroll.service.js';
import { mobile } from './payroll.policy.js';
import { persistEmployeeProfile } from './portal.service.js';

export const employeeInvitationSchema = profileSchema.extend({ email: z.string().trim().email().max(200).transform(s => s.toLowerCase()) });
type Auth = PayrollAuth & { builtinRoles?: readonly string[] };
type Receipt = { email: string; status: 'sending' | 'sent' | 'failed'; user_id: string; role: 'employee'; requested_at: string; request_hash: string };

/** Save the edited profile and grant project access in one transaction, then send the email once. */
export async function inviteEmployee(a: Auth, id: string, body: z.infer<typeof employeeInvitationSchema>, req?: Request, deliver = sendProjectInvitationEmail) {
  allowed((a.builtinRoles ?? a.roles).some(role => role === 'owner' || role === 'admin'), 'Only an owner or admin can invite employees');
  if (!env.smtp.user || !env.smtp.pass) throw serviceUnavailable('Invitation email is not configured. Ask Fund Nesta support to configure email delivery.');
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const receiptId = `employee-invite:${hash([a.tenantId, a.projectId, id, body.request_key])}`;
  const requestHash = hash(body);
  const prepared = await financialTransaction(async tx => {
    await project(tx, a);
    await tx.$queryRaw`SELECT id FROM payroll_employees WHERE id=${id} AND tenant_id=${a.tenantId} AND project_id=${a.projectId} FOR UPDATE`;
    const person = await employee(tx, a, id);
    if (person.status === 'inactive') throw badRequest('Activate the employee before inviting them');
    const old = await tx.activity.findUnique({ where: { id: receiptId } });
    if (old) {
      const receipt = old.after as unknown as Receipt;
      if (old.actorUserId !== a.userId || receipt.request_hash !== requestHash) throw conflict('This invitation request belongs to another actor or profile. Refresh before inviting.');
      return { receipt, replayed: true, person, projectName: '' };
    }
    const recent = await tx.activity.findFirst({ where: { ...scope(a), action: 'payroll.employee.email_invitation', entityId: id, createdAt: { gt: new Date(Date.now() - 60000) } } });
    if (recent) throw conflict('An invitation was requested recently. Wait a minute before resending.');
    // Never change an existing login identity to a different email as a side effect of inviting.
    const candidates = await tx.user.findMany({ where: { tenantId: a.tenantId, OR: [
      ...(person.userId ? [{ id: person.userId }] : []),
      { mobile: { in: [body.mobile, `+88${body.mobile}`, `88${body.mobile}`] } },
      { email: { equals: body.email, mode: 'insensitive' } },
    ] } });
    if (candidates.length > 1) throw conflict('The email and mobile belong to different login accounts. Resolve the accounts before inviting.');
    let user = candidates[0];
    if (person.userId && user?.id !== person.userId) throw conflict('The linked login account could not be verified');
    if (user && (!user.isActive || mobile(user.mobile) !== body.mobile || user.email && user.email.trim().toLowerCase() !== body.email)) throw conflict('The employee and login account details differ or the account is inactive. Resolve the linked account before inviting.');
    if (user && await tx.payrollEmployee.findFirst({ where: { ...scope(a), userId: user.id, id: { not: id } } })) throw conflict('This account is already linked to another employee in this project');
    await persistEmployeeProfile(tx, a, id, body);
    if (!user) user = await tx.user.create({ data: { tenantId: a.tenantId, name: body.name, mobile: body.mobile, email: body.email } });
    else if (!user.email) user = await tx.user.update({ where: { id: user.id }, data: { email: body.email } });
    await tx.payrollEmployee.update({ where: { id }, data: { userId: user.id } });
    await tx.projectMembership.upsert({ where: { projectId_userId_role: { projectId: a.projectId, userId: user.id, role: 'employee' } },
      update: { isActive: true, customRoleId: null, memberId: null },
      create: { ...scope(a), userId: user.id, role: 'employee' } });
    const selected = await tx.project.findFirstOrThrow({ where: { id: a.projectId, tenantId: a.tenantId } });
    const receipt: Receipt = { email: body.email, status: 'sending', user_id: user.id, role: 'employee', requested_at: new Date().toISOString(), request_hash: requestHash };
    await tx.activity.create({ data: { id: receiptId, ...scope(a), actorUserId: a.userId, action: 'payroll.employee.email_invitation', entityType: 'payroll_employee', entityId: id, after: receipt } });
    return { receipt, replayed: false, person: { ...person, name: body.name, mobile: body.mobile }, projectName: selected.name };
  }, 30000);
  let receipt = prepared.receipt;
  if (!prepared.replayed) {
    let sent = false;
    try {
      sent = await deliver({ ...scope(a), role: 'employee', to: receipt.email, email: receipt.email, mobile: prepared.person.mobile,
        inviteeName: prepared.person.name, projectName: prepared.projectName,
        invitationLink: buildProjectInvitationLink(req, { ...scope(a), role: 'employee', email: receipt.email, mobile: prepared.person.mobile }),
        appDownloadLink: env.app.downloadUrl ?? 'https://play.google.com/store/apps/details?id=com.fundnesta.appnesta.app' });
    } catch { sent = false; }
    receipt = { ...receipt, status: sent ? 'sent' : 'failed' };
    await prisma.activity.update({ where: { id: receiptId }, data: { after: receipt } });
  }
  const { request_hash, ...result } = receipt;
  return { ...result, replayed: prepared.replayed };
}
