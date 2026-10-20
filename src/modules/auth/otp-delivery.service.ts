import { createHash } from "node:crypto";
import { prisma } from "../../core/prisma/client.js";
import { ApiError, badRequest, serviceUnavailable } from "../../core/http/api-error.js";
import { issueOtp } from "./auth.service.js";

export const SMS_DAILY_LIMIT = 2;
export const SMS_DAY_TIMEZONE = "Asia/Dhaka";
export function smsDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SMS_DAY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

class SmsLimitReached extends Error {}

/** Atomic reservations survive restarts and serialize concurrent sends across API instances. */
export async function reserveSms(scopes: string[], day = smsDay()) {
  try {
    await prisma.$transaction(async tx => {
      // Consistent lock order also prevents deadlocks for shared/linked identities.
      for (const scope of [...new Set(scopes)].sort()) {
        const rows = await tx.$queryRaw<{ count: number }[]>`
          INSERT INTO sms_daily_usage (scope, day, count) VALUES (${scope}, ${day}::date, 1)
          ON CONFLICT (scope, day) DO UPDATE SET count = sms_daily_usage.count + 1
          WHERE sms_daily_usage.count < ${SMS_DAILY_LIMIT} RETURNING count`;
        if (!rows.length) throw new SmsLimitReached();
      }
    });
    return true;
  } catch (error) {
    if (error instanceof SmsLimitReached) return false;
    throw error;
  }
}

type OtpUser = { id: string; tenantId: string; email: string | null };
export async function requestLoginOtp(input: {
  mobile: string; users: OtpUser[]; recaptchaToken?: string; signup?: boolean;
}) {
  const { mobile, users } = input;
  const apiKey = process.env.FIREBASE_WEB_API_KEY?.trim();
  const scopes = [...new Set(users.map(user => `tenant:${user.tenantId}`))];
  // Before signup there is no tenant yet. Bound retries using a hashed phone scope.
  if (!scopes.length) scopes.push(`signup:${createHash("sha256").update(mobile).digest("hex")}`);

  const sendEmail = async (limited: boolean) => {
    if (!users.length) {
      if (limited) throw new ApiError(429, "SMS_DAILY_LIMIT", "Daily SMS limit reached. Continue with Google or try again tomorrow.");
      throw serviceUnavailable("SMS delivery is unavailable. Continue with Google or try again later.");
    }
    const emails = new Set(users.map(user => user.email?.trim().toLowerCase() ?? ""));
    if (users.length > 1 && emails.size > 1) {
      throw badRequest("This mobile is shared by multiple accounts. Continue with Google to sign in safely.");
    }
    const email = users[0]?.email;
    if (!email && limited) throw new ApiError(429, "SMS_DAILY_LIMIT", "Your organization has used its 2 SMS for today and this account has no email. Continue with Google or try again tomorrow.");
    if (!email && process.env.NODE_ENV === "production") throw serviceUnavailable("SMS delivery is unavailable and this account has no email. Continue with Google.");
    const otp = await issueOtp(mobile, email);
    if (!otp.emailed && process.env.NODE_ENV === "production") {
      throw serviceUnavailable(email ? "Could not deliver the code by email. Please try again later." : "SMS delivery is unavailable and this account has no email. Continue with Google.");
    }
    const masked = email ? email.replace(/^(.)(.*)(@.*)$/, "$1***$3") : undefined;
    return { sent: true, emailed: otp.emailed, delivery: "email" as const, sms_limit_reached: limited,
      ...(masked ? { masked_email: masked } : {}),
      ...(process.env.NODE_ENV === "production" ? {} : { dev_code: otp.code }) };
  };

  if (!apiKey) return sendEmail(false);
  const day = smsDay();
  // Avoid asking for reCAPTCHA when email fallback is already known to be necessary.
  const used = await prisma.smsDailyUsage.findMany({ where: { scope: { in: scopes }, day: new Date(`${day}T00:00:00Z`) } });
  if (used.some(row => row.count >= SMS_DAILY_LIMIT)) return sendEmail(true);
  if (!input.recaptchaToken) return { sent: false, delivery: "recaptcha" as const, emailed: false };
  if (!await reserveSms(scopes, day)) return sendEmail(true);

  // Keep reservations on timeout/failure: the provider may already have accepted the SMS.
  let response: Response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=${encodeURIComponent(apiKey)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phoneNumber: mobile, recaptchaToken: input.recaptchaToken }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    return sendEmail(false);
  }
  if (!response.ok) return sendEmail(false);
  const payload = await response.json() as { sessionInfo?: string };
  if (!payload.sessionInfo) throw serviceUnavailable("SMS verification could not be started. Please try again later.");
  return { sent: true, emailed: false, delivery: "sms" as const, verification_id: payload.sessionInfo, sms_limit_reached: false };
}

/** Email OTPs work for existing accounts and unregistered addresses alike. */
export async function requestEmailOtp(email: string) {
  const normalized = email.trim().toLowerCase();
  const otp = await issueOtp(`email:${normalized}`, normalized);
  if (!otp.emailed && process.env.NODE_ENV === "production") throw serviceUnavailable("Could not deliver the email code. Please try again later.");
  return { sent: true, delivery: "email" as const, emailed: otp.emailed,
    ...(process.env.NODE_ENV === "production" ? {} : { dev_code: otp.code }) };
}
