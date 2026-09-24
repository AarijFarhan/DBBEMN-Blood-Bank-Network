export class AppError extends Error {
  constructor(status, code, message, details = null, headers = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req, res, next) {
  next(new AppError(404, "NOT_FOUND", "The requested resource was not found."));
}

export function errorHandler(error, req, res, _next) {
  if (res.headersSent) return;
  const status = Number.isInteger(error.status) ? error.status : 500;
  const code = error.code || "INTERNAL_ERROR";
  if (error.headers && typeof error.headers === "object") {
    for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
  }
  if (status >= 500) {
    req.log?.error({ err: error, code }, "request failed");
  }
  res.status(status).json({
    error: {
      code,
      message: status >= 500 ? "An internal error occurred." : error.message,
      details: status >= 500 ? null : (error.details ?? null),
    },
  });
}