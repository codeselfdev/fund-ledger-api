import type { RequestHandler } from "express";
import type { AnyZodObject, ZodTypeAny } from "zod";
import { ApiError } from "../http/api-error.js";

function formatIssues(error: { issues: Array<{ path: Array<string | number>; message: string }> }) {
  return error.issues.reduce<Record<string, string>>((fields, issue) => {
    fields[issue.path.join(".") || "value"] = issue.message;
    return fields;
  }, {});
}

function validatePart(source: "body" | "query" | "params", schema: ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(new ApiError(400, "VALIDATION", "Invalid request", formatIssues(result.error)));
    }
    req[source] = result.data;
    return next();
  };
}

export const validateBody = (schema: AnyZodObject | ZodTypeAny) => validatePart("body", schema);
export const validateQuery = (schema: AnyZodObject | ZodTypeAny) => validatePart("query", schema);
export const validateParams = (schema: AnyZodObject | ZodTypeAny) => validatePart("params", schema);
