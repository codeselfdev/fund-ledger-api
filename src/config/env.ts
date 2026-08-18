import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTrustProxy(value: string | undefined): boolean | number {
  if (value === undefined || value.trim() === "") {
    // Default on: one proxy hop (Coolify/Traefik/nginx). Local direct access still works.
    return 1;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;
  return 1;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  uploadStorage: (process.env.UPLOAD_STORAGE ?? "local").toLowerCase(),
  uploadLocalDir: process.env.UPLOAD_LOCAL_DIR ?? "storage/uploads",
  uploadR2: {
    accountId: optional("R2_ACCOUNT_ID"),
    endpoint: optional("R2_ENDPOINT"),
    accessKeyId: optional("R2_ACCESS_KEY_ID"),
    secretAccessKey: optional("R2_SECRET_ACCESS_KEY"),
    bucket: optional("R2_BUCKET")
  },
  provisioningApiKeys: (process.env.PROVISIONING_API_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean),
  smtp: {
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT ?? 465),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER
  }
};

export const isProduction = env.nodeEnv === "production";
