import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env.js";

let transporter: Transporter | null | undefined;

function isAuthenticationError(error: unknown) {
  const smtpError = error as { code?: string; responseCode?: number };
  return smtpError?.code === "EAUTH" || smtpError?.responseCode === 535;
}

function authenticationError(error: unknown) {
  const providerHint = env.smtp.host.includes("brevo.com")
    ? "Brevo requires the SMTP Login as SMTP_USER and an SMTP key as SMTP_PASS; do not use the Brevo account password or an API key."
    : "Verify SMTP_USER and SMTP_PASS with your email provider.";
  const wrapped = new Error(
    `SMTP authentication failed. ${providerHint}`
  );
  Object.assign(wrapped, { code: "SMTP_AUTH_FAILED", cause: error });
  return wrapped;
}

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;

  if (!env.smtp.user || !env.smtp.pass) {
    console.warn("[mailer] SMTP_USER/SMTP_PASS not set — email sending is disabled");
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: {
      user: env.smtp.user,
      pass: env.smtp.pass
    }
  });

  return transporter;
}

export async function verifyMailTransport(): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) return false;

  try {
    await transport.verify();
    console.info(`[mailer] SMTP connection verified (${env.smtp.host}:${env.smtp.port})`);
    return true;
  } catch (error) {
    if (isAuthenticationError(error)) {
      transporter = null;
      console.error(`[mailer] ${authenticationError(error).message}`);
      return false;
    }

    console.error("[mailer] SMTP connection verification failed", error);
    return false;
  }
}

export async function sendMail(input: { to: string; cc?: string[]; subject: string; text: string; html?: string }): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) return false;

  try {
    await transport.sendMail({
      from: env.smtp.from,
      to: input.to,
      cc: input.cc?.length ? input.cc : undefined,
      subject: input.subject,
      text: input.text,
      html: input.html
    });
  } catch (error) {
    if (isAuthenticationError(error)) {
      // Stop retrying the same rejected credentials for every row in a bulk import.
      transporter = null;
      throw authenticationError(error);
    }
    throw error;
  }

  return true;
}

export async function sendOtpEmail(to: string, code: string): Promise<boolean> {
  return sendMail({
    to,
    subject: "Your verification code",
    text: `Your verification code is ${code}. It expires in 5 minutes.`,
    html: `<p>Your verification code is <strong>${code}</strong>.</p><p>It expires in 5 minutes.</p>`
  });
}

export async function sendDecisionEmail(input: {
  to: string;
  cc?: string[];
  subject: string;
  entityLabel: string;
  decision: "approved" | "rejected";
  reason?: string;
}): Promise<boolean> {
  const verb = input.decision === "approved" ? "approved" : "rejected";
  const reasonLine = input.reason ? `<p>Reason: ${input.reason}</p>` : "";
  const reasonText = input.reason ? `\nReason: ${input.reason}` : "";

  return sendMail({
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: `${input.entityLabel} was ${verb}.${reasonText}`,
    html: `<p>${input.entityLabel} was <strong>${verb}</strong>.</p>${reasonLine}`
  });
}
