import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { env } from "../../config/env.js";

export type AccessTokenPayload = {
  sessionId: string;
  userId: string;
  tenantId: string;
};

export function signAccessToken(payload: AccessTokenPayload) {
  const options: SignOptions = { expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"] };
  return jwt.sign(payload, env.jwtSecret, options);
}

export function verifyAccessToken(token: string) {
  return jwt.verify(token, env.jwtSecret) as AccessTokenPayload;
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function sessionExpiryDate() {
  const match = /^(\d+)([dhm])$/.exec(env.jwtExpiresIn);
  if (!match) return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const amount = Number(match[1]);
  const unit = match[2];
  const ms =
    unit === "d" ? amount * 24 * 60 * 60 * 1000 :
    unit === "h" ? amount * 60 * 60 * 1000 :
    amount * 60 * 1000;

  return new Date(Date.now() + ms);
}
