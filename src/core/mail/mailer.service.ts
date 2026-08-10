import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env.js";

let transporter: Transporter | null | undefined;

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

export async function sendMail(input: { to: string; cc?: string[]; subject: string; text: string; html?: string }): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) return false;

  await transport.sendMail({
    from: env.smtp.from,
    to: input.to,
    cc: input.cc?.length ? input.cc : undefined,
    subject: input.subject,
    text: input.text,
    html: input.html
  });

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
