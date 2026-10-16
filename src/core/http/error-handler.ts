import type { ErrorRequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ApiError } from "./api-error.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const message = err instanceof Error ? err.message : "";
  const quotaCode = ["DOCUMENT_QUOTA_EXCEEDED", "USER_QUOTA_EXCEEDED", "PROJECT_QUOTA_EXCEEDED", "DOCUMENT_TOO_LARGE"].find(code => message.includes(code));
  if (quotaCode || err?.code === "LIMIT_FILE_SIZE") {
    const code = quotaCode ?? "DOCUMENT_TOO_LARGE";
    return res.status(code === "DOCUMENT_TOO_LARGE" ? 413 : 409).json({ ok: false, error: { code,
      message: code === "DOCUMENT_TOO_LARGE" ? "Each document must be 5 MB or smaller." : code === "PROJECT_QUOTA_EXCEEDED" ? "Your organization has reached its project limit. Upgrade your package to create more projects." : code === "USER_QUOTA_EXCEEDED" ? "Your organization has reached its user/member limit. Upgrade your package to add more people." : "Your organization has reached its document limit. Remove a document or upgrade your package." } });
  }
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {})
      }
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({
        ok: false,
        error: {
          code: "UNIQUE_CONSTRAINT",
          message: "A record with the same unique value already exists",
          fields: err.meta
        }
      });
    }
  }

  console.error(err);
  return res.status(500).json({
    ok: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error"
    }
  });
};
