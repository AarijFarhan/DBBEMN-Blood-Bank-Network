import { AppError } from "./errors.js";

export function validate(schema, source = "body") {
  return function validateRequest(req, _res, next) {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(new AppError(422, "VALIDATION_ERROR", "Request validation failed.", result.error.flatten()));
      return;
    }
    req[source] = result.data;
    next();
  };
}

export function parseQuery(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AppError(422, "VALIDATION_ERROR", "Query validation failed.", result.error.flatten());
  }
  return result.data;
}