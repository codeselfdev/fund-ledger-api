import bcrypt from "bcryptjs";
import { prisma } from "../../core/prisma/client.js";
import { hashToken, sessionExpiryDate, signAccessToken } from "../../core/security/jwt.js";
import { sendOtpEmail } from "../../core/mail/mailer.service.js";

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
      mobile,
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
