import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import { env } from "../../config/env.js";
import { ApiError, unauthorized } from "../http/api-error.js";

function apiKeyFromRequest(req: Request) {
  const headerKey = req.header("x-api-key")?.trim();
  if (headerKey) return headerKey;

  const authorization = req.header("authorization")?.trim();
  if (!authorization) return null;

  const [scheme, key] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "apikey" || !key) return null;
  return key;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest();
}

function constantTimeEqual(left: string, right: string) {
  return crypto.timingSafeEqual(sha256(left), sha256(right));
}

export const requireProvisioningApiKey: RequestHandler = (req, _res, next) => {
  if (env.provisioningApiKeys.length === 0) {
    return next(new ApiError(
      503,
      "PROVISIONING_API_KEY_NOT_CONFIGURED",
      "Tenant provisioning is not configured"
    ));
  }

  const providedKey = apiKeyFromRequest(req);
  if (!providedKey) {
    return next(unauthorized("Provisioning API key is required"));
  }

  const isValid = env.provisioningApiKeys.some((configuredKey) =>
    constantTimeEqual(providedKey, configuredKey)
  );

  if (!isValid) {
    return next(unauthorized("Invalid provisioning API key"));
  }

  return next();
};
