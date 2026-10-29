import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { prisma } from '../../core/prisma/client.js';
import { notFound, conflict } from '../../core/http/api-error.js';
import { customerDetails } from './customers.service.js';
import { Prisma } from '@prisma/client';
import type { Prisma as PrismaTypes } from '@prisma/client';
import { badRequest } from '../../core/http/api-error.js';
import { purgeObject } from '../../core/storage/object-storage.service.js';
import { getFirebaseAdminApp } from '../../core/firebase/admin.js';
import { getAuth } from 'firebase-admin/auth';

export async function deletionRequests(offset = 0, status?: string) {
  const where = status ? { status } : { status: { in: ['pending', 'in_review', 'needs_information', 'processing', 'processing_failed'] } };
  const rows = await prisma.accountDeletionRequest.findMany({ where, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], skip: offset, take: 31 });
  return { requests: await Promise.all(rows.slice(0, 30).map(async row => ({ ...row, overdue: row.dueAt < new Date() && !['completed', 'rejected'].includes(row.status),
    tenant: await prisma.tenant.findUnique({ where: { id: row.tenantId }, select: { id: true, name: true, slug: true } }),
    customer: await customerDetails(row.tenantId, row.userId),
  }))), next_offset: rows.length > 30 ? offset + 30 : null };
}

export async function deletionRequest(id: string) {
  const request = await prisma.accountDeletionRequest.findUnique({ where: { id } });
  if (!request) throw notFound('Deletion request not found');
  const [customer, tenant, history] = await Promise.all([
    customerDetails(request.tenantId, request.userId),
    prisma.tenant.findUnique({ where: { id: request.tenantId }, select: { id: true, name: true, slug: true } }),
    prisma.internalAudit.findMany({ where: { tenantId: request.tenantId, action: { startsWith: 'account_deletion.' }, metadata: { path: ['request_id'], equals: id } }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  return { request, customer, tenant, history };
}

export async function reviewDeletionRequest(id: string, input: { status: 'in_review' | 'needs_information'; expected_status: string; note: string }, actor: string) {
  return prisma.$transaction(async tx => {
    const request = await tx.accountDeletionRequest.findUnique({ where: { id } });
    if (!request) throw notFound('Deletion request not found');
    if (!['pending', 'in_review', 'needs_information'].includes(request.status)) throw conflict('This request cannot be reviewed in its current state');
    const updated = await tx.accountDeletionRequest.updateMany({ where: { id, status: input.expected_status }, data: { status: input.status, resolutionNote: input.note } });
    if (!updated.count) throw conflict('The request changed. Refresh it before continuing.');
    await tx.internalAudit.create({ data: { tenantId: request.tenantId, actor, action: 'account_deletion.' + input.status,
      metadata: { request_id: id, user_id: request.userId, note: input.note } } });
    return tx.accountDeletionRequest.findUniqueOrThrow({ where: { id } });
  });
}

async function deletionScope(tx: PrismaTypes.TransactionClient, tenantId: string, userId: string) {
  const user = await tenantAccounts(tx).findFirst({ where: { id: userId, tenantId } });
  if (!user) throw conflict('Account not found. Check whether deletion was already completed outside this workflow.');
  const members = await tx.member.findMany({ where: { tenantId, OR: [{ userId }, { memberships: { some: { userId } } }] }, select: { id: true } });
  const memberships = await tx.projectMembership.findMany({ where: { userId, isActive: true, role: 'owner' } });
  const blockers: string[] = [];
  for (const membership of memberships) {
    if (!await tx.projectMembership.count({ where: { projectId: membership.projectId, userId: { not: userId }, role: 'owner', isActive: true, user: { isActive: true } } })) blockers.push('Transfer ownership of project ' + membership.projectId + ' before deleting its last owner.');
  }
  if (await tx.projectMembership.count({ where: { userId, tenantId: { not: tenantId } } }) || await tx.member.count({ where: { userId, tenantId: { not: tenantId } } })) blockers.push('Resolve account links to another organization before deletion.');
  const memberIds = members.map(member => member.id);
  const uploads = await tx.upload.findMany({ where: { tenantId, OR: memberIds.flatMap(id => [{ purpose: 'member_photo:' + id }, { purpose: { startsWith: 'member_document:' + id + ':' } }]) }, select: { id: true, storageKey: true } });
  const support = await tx.supportAttachment.findMany({ where: { tenantId, message: { ticket: { requesterId: userId } } }, select: { id: true, storageKey: true } });
  const assistant = await tx.assistantAttachment.findMany({ where: { tenantId, reply: { userId } }, select: { id: true, storageKey: true } });
  const objects = [...uploads.map(row => ({ ...row, model: 'upload' as const })), ...support.map(row => ({ ...row, model: 'supportAttachment' as const })), ...assistant.map(row => ({ ...row, model: 'assistantAttachment' as const }))];
  if (objects.some(object => !object.storageKey.startsWith(tenantId + '/'))) blockers.push('Personal files have legacy storage paths. Migrate them into this organization before deletion.');
  const sharedIdentity = await tx.tenantUser.count({where:{userId:user.userId,id:{not:userId}}});
  return { user, memberIds, objects, blockers, sharedIdentity: sharedIdentity > 0 };
}

export async function deletionPreview(id: string) {
  const request = await prisma.accountDeletionRequest.findUnique({ where: { id } });
  if (!request) throw notFound('Deletion request not found');
  if (request.status === 'completed') return { completed: true, confirmation: 'DELETE ' + id, blockers: ['This account was already deleted.'] };
  const scope = await deletionScope(prisma, request.tenantId, request.userId);
  return { completed: false, confirmation: 'DELETE ' + id, blockers: scope.blockers, personal_files: scope.objects.length, member_profiles: scope.memberIds.length,
    account_name: scope.user.name, organization_only: true, shared_authentication_retained: scope.sharedIdentity,
    retained: 'Organization ledgers, dues, receipts, approvals and other shared financial or audit records remain. Personal member contact/profile fields are removed. Other organization accounts remain active.',
  };
}

async function deleteFirebaseIdentity(user: { mobile: string; email: string | null }) {
  const app = getFirebaseAdminApp();
  if (!app) throw new Error('Firebase cleanup is not configured');
  const auth = getAuth(app), ids = new Set<string>();
  // Google OAuth consent/account itself is not deleted; only this app's Firebase identities.
  for (const lookup of [() => auth.getUserByPhoneNumber(user.mobile), ...(user.email ? [() => auth.getUserByEmail(user.email!)] : [])]) {
    try { ids.add((await lookup()).uid); }
    catch (error) { if ((error as { code?: string }).code !== 'auth/user-not-found' && (error as { code?: string }).code !== 'auth/invalid-phone-number') throw error; }
  }
  for (const uid of ids) {
    try { await auth.deleteUser(uid); }
    catch (error) { if ((error as { code?: string }).code !== 'auth/user-not-found') throw error; }
  }
}

export async function executeAccountDeletion(id: string, input: { confirmation: string; identity_verified: true; retention_note: string }, actor: string,
  dependencies = { purgeObject, deleteFirebaseIdentity }) {
  if (!input.identity_verified || input.confirmation !== 'DELETE ' + id) throw badRequest('Verify the requester and type the exact request confirmation.');
  const lease = new Date(Date.now() + 120000);
  const claim = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM account_deletion_requests WHERE id=${id} FOR UPDATE`;
    const request = await tx.accountDeletionRequest.findUnique({ where: { id } });
    if (!request) throw notFound('Deletion request not found');
    if (request.status === 'completed') return { completed: request };
    if (!['in_review', 'processing', 'processing_failed'].includes(request.status)) throw conflict('Review the request before deleting the account.');
    if (request.processingLeaseUntil && request.processingLeaseUntil > new Date()) throw conflict('Deletion is already running. Refresh its status.');
    const scope = await deletionScope(tx, request.tenantId, request.userId);
    if (scope.blockers.length) throw conflict(scope.blockers.join(' '));
    await tenantAccounts(tx).update({ where: { id: request.userId }, data: { isActive: false, deviceId: null } });
    await tx.session.updateMany({ where: { userId: request.userId }, data: { revokedAt: new Date() } });
    await tx.assistantReply.updateMany({ where: { tenantId: request.tenantId, userId: request.userId }, data: { status: 'failed', leaseUntil: null, errorCode: 'ACCOUNT_DELETION' } });
    await tx.accountDeletionRequest.update({ where: { id }, data: { status: 'processing', processingLeaseUntil: lease, processingError: null, resolutionNote: input.retention_note } });
    await tx.internalAudit.create({ data: { tenantId: request.tenantId, actor, action: 'account_deletion.started', metadata: { request_id: id, user_id: request.userId, note: input.retention_note } } });
    return { request, scope };
  }, { isolationLevel: 'Serializable', timeout: 30000 });
  if ('completed' in claim) return claim.completed;
  const { request, scope } = claim;
  let stage = 'Personal file cleanup';
  try {
    for (const object of scope.objects.slice(0, 25)) {
      await dependencies.purgeObject(object.storageKey);
      await prisma.$transaction(async tx => {
        const owned = await tx.accountDeletionRequest.findFirst({ where: { id, processingLeaseUntil: lease } });
        if (!owned) throw conflict('Deletion lease changed. Refresh the request.');
        const where = { id: object.id, tenantId: request.tenantId };
        if (object.model === 'upload') await tx.upload.deleteMany({ where });
        else if (object.model === 'supportAttachment') await tx.supportAttachment.deleteMany({ where });
        else await tx.assistantAttachment.deleteMany({ where });
      });
    }
    const remaining = await deletionScope(prisma, request.tenantId, request.userId);
    if (remaining.objects.length) return await prisma.accountDeletionRequest.update({ where: { id }, data: { processingLeaseUntil: null } });
    if (remaining.blockers.length) throw conflict(remaining.blockers.join(' '));
    stage = 'Authentication provider cleanup';
    if (!remaining.sharedIdentity) await dependencies.deleteFirebaseIdentity(remaining.user);
    stage = 'Account record deletion';
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM account_deletion_requests WHERE id=${id} FOR UPDATE`;
      const owned = await tx.accountDeletionRequest.findFirst({ where: { id, processingLeaseUntil: lease, status: 'processing' } });
      if (!owned) throw conflict('Deletion lease changed. Refresh the request.');
      const final = await deletionScope(tx, request.tenantId, request.userId);
      if (final.objects.length || final.blockers.length) throw conflict('Account data changed. Retry deletion to review the remaining records.');
      await tx.member.updateMany({ where: { tenantId: request.tenantId, id: { in: final.memberIds } }, data: { name: 'Deleted member', mobile: 'deleted:' + request.userId, email: null, address: null, profile: Prisma.DbNull } });
      await tx.onboardingProgress.updateMany({ where: { tenantId: request.tenantId, accountantUserId: request.userId }, data: { accountantUserId: null } });
      await tx.notificationDelivery.deleteMany({ where: { userId: request.userId, campaign: { tenantId: request.tenantId } } });
      await tx.assistantReply.deleteMany({ where: { tenantId: request.tenantId, userId: request.userId } });
      await tx.telegramLink.deleteMany({ where: { tenantId: request.tenantId, userId: request.userId } });
      await tx.invitation.deleteMany({ where: { tenantId: request.tenantId, mobile: final.user.mobile } });
      if (!final.sharedIdentity) await tx.otpCode.deleteMany({ where: { mobile: final.user.mobile } });
      await tenantAccounts(tx).delete({ where: { id: request.userId } });
      if (!final.sharedIdentity) await tx.user.delete({ where: { id: final.user.userId } });
      await tx.internalAudit.create({ data: { tenantId: request.tenantId, actor, action: 'account_deletion.completed', metadata: { request_id: id, user_id: request.userId, note: input.retention_note, shared_authentication_retained: final.sharedIdentity } } });
      return tx.accountDeletionRequest.update({ where: { id }, data: { status: 'completed', completedAt: new Date(), processingLeaseUntil: null, processingError: null } });
    }, { isolationLevel: 'Serializable', timeout: 30000 });
  } catch {
    await prisma.accountDeletionRequest.updateMany({ where: { id, processingLeaseUntil: lease }, data: { status: 'processing_failed', processingLeaseUntil: null, processingError: stage + ' did not finish. Review server configuration and retry.' } });
    throw conflict(stage + ' did not finish. The request remains open for retry.');
  }
}
