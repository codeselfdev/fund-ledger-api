export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fields?: unknown;

  constructor(statusCode: number, code: string, message: string, fields?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message: string, fields?: unknown) =>
  new ApiError(400, "BAD_REQUEST", message, fields);

export const unauthorized = (message = "Authentication required") =>
  new ApiError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "You are not allowed to perform this action") =>
  new ApiError(403, "FORBIDDEN", message);

export const notFound = (message = "Resource not found", fields?: unknown) =>
  new ApiError(404, "NOT_FOUND", message, fields);

export const conflict = (message: string, fields?: unknown) =>
  new ApiError(409, "CONFLICT", message, fields);
