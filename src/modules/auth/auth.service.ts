import { tenantAccounts } from "../../core/identity/tenant-accounts.js";
import { randomInt } from "node:crypto";
import { recordUserLogin } from "../../core/security/client-activity.js";
import { linkedIdentityUsers } from "../../core/security/linked-identity.js";
import bcrypt from "bcryptjs";
import { prisma } from "../../core/prisma/client.js";
import { forbidden, unauthorized } from "../../core/http/api-error.js";
import { hashToken, sessionExpiryDate, signAccessToken } from "../../core/security/jwt.js";
import { sendOtpEmail } from "../../core/mail/mailer.service.js";
import { verifyAuthIdToken, verifyFirebasePhoneIdToken } from "../../core/firebase/admin.js";
import { summarizeProjectMemberships } from "../../core/security/project-access.js";

export type LoginSessionPayload = {
  token: string;
  identity_root_id?: string;
  user: { id: string; name: string; mobile: string };
  tenant: { id: string; name: string; slug: string };
  active_project_id: string | null;
  memberships: Array<{
    project_id: string;
    project_name: string;
    project_type: "fund_shares" | "accounting" | "billing" | "construction" | "payroll_pf" | "institute";
    role: string;
    roles: string[];
    member_id: string | null;
  }>;
};

type LoginUser = Awaited<ReturnType<typeof findActiveUsersByEmail>>[number];

export async function createSessionToken(input: {
  tenantId: string;
  userId: string;
  activeProjectId?: string | null;
  recordLogin?: boolean;
  verifiedEmail?: string | null;
}) {
  const session = await prisma.session.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      activeProjectId: input.activeProjectId ?? null,
      verifiedEmail: input.verifiedEmail?.trim().toLowerCase() ?? null,
      tokenHash: "pending",
      authenticatedAt: input.recordLogin ? new Date() : null,
      expiresAt: sessionExpiryDate()
    }
  });

  const token = signAccessToken({
    sessionId: session.id,
    tenantId: input.tenantId,
    userId: input.userId
  });

  await prisma.session.update({
    where: { id: session.id },
    data: { tokenHash: hashToken(token) }
  });

  if (input.recordLogin) await recordUserLogin(input.userId);
  return { token, sessionId: session.id };
}

export async function createOtp(contact: string) {
  const code = String(randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 10);
  await prisma.$transaction(async tx => {
    // PostgreSQL returns void for this lock; cast it so Prisma can decode the result.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`otp:${contact}`}, 0))::text`;
    await tx.otpCode.updateMany({ where: { mobile: contact, consumedAt: null }, data: { consumedAt: new Date() } });
    await tx.otpCode.create({ data: { mobile: contact, codeHash, expiresAt: new Date(Date.now() + 5 * 60 * 1000) } });
  });
  return code;
}

export async function issueOtp(contact: string, email?: string | null) {
  const code = await createOtp(contact);
  let emailed = false;
  if (email) {
    try { emailed = await sendOtpEmail(email, code); }
    catch (err) { console.error("[mailer] failed to send OTP email", err); }
  }
  return { code, emailed };
}

export async function verifyOtp(contact: string, code?: string) {
  if (!code || !/^\d{6}$/.test(code)) return false;
  // Email challenges use an exact namespaced key, never phone suffix matching.
  const otp = await prisma.otpCode.findFirst({
    where: { mobile: contact.startsWith("email:") ? contact : { in: mobileLookupValues(contact) },
      consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }
  });
  if (!otp || !await bcrypt.compare(code, otp.codeHash)) return false;
  const claimed = await prisma.otpCode.updateMany({
    where: { id: otp.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() }
  });
  return claimed.count === 1;
}

export function mobileLookupValues(input: string): string[] {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  const values = new Set<string>();
  if (trimmed) values.add(trimmed);
  if (digits) {
    values.add(digits);
    values.add(`+${digits}`);
  }
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    values.add(last10);
    values.add(`0${last10}`);
  }
  return [...values];
}

export function canonicalMobile(input: string): string {
  if (/^[ge]:/.test(input)) return input.trim();
  const trimmed = input.trim(), digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed;
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (/^01\d{9}$/.test(digits)) return `+880${digits.slice(1)}`;
  if (/^1\d{9}$/.test(digits)) return `+880${digits}`;
  return `+${digits}`;
}
export function mobilesEquivalent(left: string, right: string): boolean {
  return Boolean(left.replace(/\D/g, "")) && canonicalMobile(left) === canonicalMobile(right);
}

export async function resolveFirebasePhone(idToken: string): Promise<string> {
  const { phoneNumber } = await verifyFirebasePhoneIdToken(idToken);
  return phoneNumber;
}

export async function resolveFirebaseIdentity(idToken: string) {
  return verifyAuthIdToken(idToken);
}

export function googlePlaceholderMobile(uid: string): string {
  const compact = uid.replace(/[^a-zA-Z0-9]/g, "").slice(0, 28);
  return `g:${compact}`.slice(0, 32);
}

const userLoginInclude = {
  memberships: {
    where: { isActive: true, project: { isActive: true } },
    include: { project: true, member: true, customRole: true }
  },
  tenant: { include: { subscription: true } }
} as const;

export async function findActiveUsersByMobile(mobile: string, tenantSlug?: string, deduplicate = true) {
  const users = await tenantAccounts(prisma).findMany({
    where: { isActive: true, mobile: canonicalMobile(mobile), ...(tenantSlug ? { tenant: {slug:tenantSlug} } : {}) },
    include: userLoginInclude
  });
  return deduplicate ? deduplicateLinkedUsers(users) : users;
}

export async function findActiveUsersByEmail(email: string, tenantSlug?: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];
  const users = await tenantAccounts(prisma).findMany({
    where: {
      isActive: true,
      email: { equals: normalized, mode: "insensitive" },
      ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {})
    },
    include: userLoginInclude
  });
  return deduplicateLinkedUsers(users);
}

function deduplicateLinkedUsers<T extends { id: string; userId: string | null }>(users: T[]) {
  const seen = new Set<string>();
  return users.filter(user => { const root = user.userId ?? user.id; if (seen.has(root)) return false; seen.add(root); return true; });
}

export function toLoginSessionPayload(
  user: LoginUser,
  token: string,
  activeProjectId: string | null
): LoginSessionPayload {
  return {
    token,
    user: { id: user.id, name: user.name, mobile: user.mobile },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
    active_project_id: activeProjectId,
    memberships: summarizeProjectMemberships(user.memberships)
  };
}

export async function issueLoginSession(user: LoginUser, projectId?: string, recordLogin = true, verifiedEmail?: string | null): Promise<LoginSessionPayload> {
  if (!user) throw unauthorized("Invalid login");
  const identity = await linkedIdentityUsers(user.id);
  const allMemberships = await prisma.projectMembership.findMany({
    where: { userId: { in: identity.userIds }, isActive: true, project: { isActive: true } }, include: { project: true, customRole: true }
  });
  const activeMembership = projectId ? allMemberships.find(row => row.projectId === projectId) : (user.memberships[0] ?? allMemberships[0]);
  if (projectId && !activeMembership) throw forbidden("No active membership for requested project");
  const selectedUser = activeMembership && activeMembership.userId !== user.id ? await getActiveUserForLogin(activeMembership.userId) : user;
  const { token } = await createSessionToken({ tenantId: selectedUser.tenantId, userId: selectedUser.id, recordLogin, verifiedEmail, activeProjectId: activeMembership?.projectId ?? null });
  return { ...toLoginSessionPayload(selectedUser, token, activeMembership?.projectId ?? null),
    identity_root_id: identity.rootId, memberships: summarizeProjectMemberships(allMemberships) };

}

export async function getActiveUserForLogin(userId: string) {
  return tenantAccounts(prisma).findUniqueOrThrow({
    where: { id: userId },
    include: userLoginInclude
  });
}
