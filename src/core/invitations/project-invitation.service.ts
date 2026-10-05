import type { Request } from "express";
import type { Role } from "@prisma/client";
import { env } from "../../config/env.js";
import { sendMail } from "../mail/mailer.service.js";

export const PROJECT_SIGN_IN_OPTIONS = [
  {
    method: "google",
    label: "Sign in with Google",
    description: "Use the Gmail or Google account email on the invitation"
  },
  {
    method: "otp",
    label: "Sign in with OTP",
    description: "Enter the OTP sent to your phone or email"
  }
] as const;

type ProjectInvitationLinkInput = {
  tenantId: string;
  projectId: string;
  role: Role;
  mobile?: string | null;
  email?: string | null;
  invitationId?: string;
  memberId?: string;
};

type ProjectInvitationEmailInput = ProjectInvitationLinkInput & {
  to: string;
  inviteeName: string;
  projectName: string;
  invitationLink: string;
  appDownloadLink: string;
  otpEmailed?: boolean;
};

function publicApiOrigin(req?: Request) {
  if (env.googleOAuth.publicApiUrl) return env.googleOAuth.publicApiUrl.replace(/\/$/, "");
  if (!req) return "";
  const proto = (req.get("x-forwarded-proto") ?? req.protocol ?? "http").split(",")[0]?.trim() || "http";
  const host = req.get("x-forwarded-host") ?? req.get("host");
  return host ? `${proto}://${host}` : "";
}

function appendQueryParams(uri: string, params: Record<string, string | undefined>): string {
  const definedParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value.length > 0)
  ) as Record<string, string>;

  try {
    const url = new URL(uri);
    for (const [key, value] of Object.entries(definedParams)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    const qs = new URLSearchParams(definedParams).toString();
    if (!qs) return uri;
    const hashIndex = uri.indexOf("#");
    const base = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
    const hash = hashIndex >= 0 ? uri.slice(hashIndex) : "";
    return `${base}${base.includes("?") ? "&" : "?"}${qs}${hash}`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function buildProjectInvitationLink(req: Request | undefined, input: ProjectInvitationLinkInput) {
  const base = env.app.inviteUrl ?? env.app.downloadUrl ?? "fundledger://invite";
  return appendQueryParams(base, {
    tenant_id: input.tenantId,
    project_id: input.projectId,
    role: input.role,
    mobile: input.mobile ?? undefined,
    email: input.email ?? undefined,
    invitation_id: input.invitationId,
    member_id: input.memberId,
    api_url: publicApiOrigin(req) || undefined
  });
}

export function resolveAppDownloadLink(fallbackLink: string) {
  return env.app.downloadUrl ?? fallbackLink;
}

export function buildProjectInvitationSummary(input: {
  inviteeName: string;
  projectName: string;
  role: Role;
  phoneOtpAvailable?: boolean;
}) {
  const signInMethod = input.phoneOtpAvailable === false ? "Google" : "Google or phone OTP";
  return `${input.inviteeName} has been added to ${input.projectName} as ${input.role}. They can open the invitation link, download the app if needed, and sign in with ${signInMethod}.`;
}

export function projectSignInOptions(phoneOtpAvailable: boolean) {
  return phoneOtpAvailable
    ? PROJECT_SIGN_IN_OPTIONS
    : PROJECT_SIGN_IN_OPTIONS.filter((option) => option.method === "google");
}

export async function sendProjectInvitationEmail(input: ProjectInvitationEmailInput): Promise<boolean> {
  const safeName = escapeHtml(input.inviteeName);
  const safeProjectName = escapeHtml(input.projectName);
  const safeRole = escapeHtml(input.role);
  const safeInvitationLink = escapeHtml(input.invitationLink);
  const safeDownloadLink = escapeHtml(input.appDownloadLink);
  const safeEmail = input.email ? escapeHtml(input.email) : "";
  const safeMobile = input.mobile ? escapeHtml(input.mobile) : "";
  const otpLine = input.mobile
    ? input.otpEmailed
      ? "We also sent a short-lived OTP code to your email. You can request a fresh code from the app anytime."
      : "You can request a fresh OTP code from the app when signing in with your phone."
    : "Sign in with the Google account associated with this invitation.";

  const googleText = input.email
    ? `Google: continue with the Google account for ${input.email}.`
    : "Google: continue with the Gmail or Google account shared with the project admin.";

  return sendMail({
    to: input.to,
    subject: `Join ${input.projectName} on FundLedger`,
    text: [
      `Hi ${input.inviteeName},`,
      "",
      `You have been added to ${input.projectName} as ${input.role}.`,
      `Download or open the app: ${input.appDownloadLink}`,
      `Invitation link: ${input.invitationLink}`,
      "",
      "Sign in options:",
      googleText,
      ...(input.mobile ? [`Phone OTP: use ${input.mobile} and enter the OTP code sent during sign-in.`] : []),
      otpLine,
      "",
      "After signing in, you can view the project, shares, dues, and payment activity."
    ].join("\n"),
    html: `
      <p>Hi ${safeName},</p>
      <p>You have been added to <strong>${safeProjectName}</strong> as <strong>${safeRole}</strong>.</p>
      <p><a href="${safeDownloadLink}">Download or open the FundLedger app</a></p>
      <p><a href="${safeInvitationLink}">Open your invitation</a></p>
      <p>Sign in options:</p>
      <ul>
        <li>Google: ${safeEmail ? `continue with <strong>${safeEmail}</strong>.` : "continue with the Gmail or Google account shared with the project admin."}</li>
        ${safeMobile ? `<li>Phone OTP: use <strong>${safeMobile}</strong> and enter the OTP code sent during sign-in.</li>` : ""}
      </ul>
      <p>${escapeHtml(otpLine)}</p>
      <p>After signing in, you can view the project, shares, dues, and payment activity.</p>
    `
  });
}
