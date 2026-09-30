import bcrypt from "bcryptjs";
import { prisma } from "../../core/prisma/client.js";
import { forbidden, unauthorized } from "../../core/http/api-error.js";
import { hashToken, sessionExpiryDate, signAccessToken } from "../../core/security/jwt.js";
import { sendOtpEmail } from "../../core/mail/mailer.service.js";
import { verifyAuthIdToken, verifyFirebasePhoneIdToken } from "../../core/firebase/admin.js";

export type LoginSessionPayload = {
  token: string;
  user: { id: string; name: string; mobile: string };
  tenant: { id: string; name: string; slug: string };
  active_project_id: string;
  memberships: Array<{
    project_id: string;
    project_name: string;
    role: string;
    member_id: string | null;
  }>;
};

type LoginUser = Awaited<ReturnType<typeof findActiveUsersByEmail>>[number];

export async function createSessionToken(input: {
  tenantId: string;
  userId: string;
  activeProjectId?: string | null;
}) {
  const session = await prisma.session.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId,
      activeProjectId: input.activeProjectId ?? null,
      tokenHash: "pending",
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

  return { token, sessionId: session.id };
}

export async function createOtp(mobile: string) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.otpCode.create({
    data: {
      mobile,
      codeHash: await bcrypt.hash(code, 10),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    }
  });
  return code;
}

export async function issueOtp(mobile: string, email?: string | null) {
  const code = await createOtp(mobile);

  let emailed = false;
  if (email) {
    try {
      emailed = await sendOtpEmail(email, code);
    } catch (err) {
      console.error("[mailer] failed to send OTP email", err);
    }
  }

  return { code, emailed };
}

export async function verifyOtp(mobile: string, code?: string) {
  if (!code && process.env.NODE_ENV !== "production") return true;

  const otp = await prisma.otpCode.findFirst({
    where: {
      mobile: { in: mobileLookupValues(mobile) },
      consumedAt: null,
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: "desc" }
  });

  if (!otp || !code) return false;
  const valid = await bcrypt.compare(code, otp.codeHash);
  if (!valid) return false;

  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { consumedAt: new Date() }
  });

  return true;
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

export function mobilesEquivalent(left: string, right: string): boolean {
  const a = left.replace(/\D/g, "");
  const b = right.replace(/\D/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  const a10 = a.slice(-10);
  const b10 = b.slice(-10);
  return a10.length === 10 && a10 === b10;
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
    where: { isActive: true },
    include: { project: true, member: true }
  },
  tenant: true
} as const;

export async function findActiveUsersByMobile(mobile: string, tenantSlug?: string) {
  const candidates = mobileLookupValues(mobile);
  const last10 = mobile.replace(/\D/g, "").slice(-10);
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
      OR: [
        { mobile: { in: candidates } },
        ...(last10.length === 10 ? [{ mobile: { endsWith: last10 } }] : [])
      ]
    },
    include: userLoginInclude
  });

  return users.filter((user) => mobilesEquivalent(user.mobile, mobile));
}

export async function findActiveUsersByEmail(email: string, tenantSlug?: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];
  return prisma.user.findMany({
    where: {
      isActive: true,
      email: { equals: normalized, mode: "insensitive" },
      ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {})
    },
    include: userLoginInclude
  });
}

export function toLoginSessionPayload(
  user: LoginUser,
  token: string,
  activeProjectId: string
): LoginSessionPayload {
  return {
    token,
    user: { id: user.id, name: user.name, mobile: user.mobile },
    tenant: { id: user.tenant.id, name: user.tenant.name, slug: user.tenant.slug },
    active_project_id: activeProjectId,
    memberships: user.memberships.map((membership) => ({
      project_id: membership.projectId,
      project_name: membership.project.name,
      role: membership.role,
      member_id: membership.memberId
    }))
  };
}

export async function issueLoginSession(user: LoginUser, projectId?: string): Promise<LoginSessionPayload> {
  if (!user) throw unauthorized("Invalid login");
  const activeMembership = projectId
    ? user.memberships.find((membership) => membership.projectId === projectId)
    : user.memberships[0];
  if (!activeMembership) throw forbidden("No active membership for requested project");

  const { token } = await createSessionToken({
    tenantId: user.tenantId,
    userId: user.id,
    activeProjectId: activeMembership.projectId
  });

  return toLoginSessionPayload(user, token, activeMembership.projectId);
}

export async function getActiveUserForLogin(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: userLoginInclude
  });
}
