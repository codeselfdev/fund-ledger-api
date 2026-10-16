import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { env } from "../../config/env.js";
import { ApiError, unauthorized, badRequest } from "../http/api-error.js";
const digest = (key: string) => createHash("sha256").update(key).digest();
export const requireInternalApiKey: RequestHandler = (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  const configured = env.internalApiKey;
  if (!configured || configured.length < 32) return next(new ApiError(503, "INTERNAL_API_NOT_CONFIGURED", "Internal administration is not configured"));
  const provided = req.get("x-internal-api-key");
  if (!provided || !timingSafeEqual(digest(provided), digest(configured))) return next(unauthorized("Invalid internal API key"));
  next();
};
export function internalActor(req: Request) {
  const actor = req.get("x-internal-actor")?.trim();
  if (!actor || actor.length > 120) throw badRequest("X-Internal-Actor is required (up to 120 characters)");
  return actor;
}
