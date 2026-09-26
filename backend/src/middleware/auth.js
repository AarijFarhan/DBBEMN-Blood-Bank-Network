import jwt from "jsonwebtoken";
import { AppError, asyncRoute } from "./errors.js";
import { env } from "../config/env.js";
import { getCatalogPool } from "../db/registry.js";

export const authenticate = asyncRoute(async (req, _res, next) => {
  const authorization = req.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new AppError(401, "UNAUTHENTICATED", "A valid bearer token is required.");
  }

  let claims;
  try {
    claims = jwt.verify(authorization.slice(7), env.jwtSecret, {
      issuer: "dbbemn",
      audience: "dbbemn-api",
    });
  } catch {
    throw new AppError(401, "INVALID_ACCESS_TOKEN", "The access token is invalid or expired.");
  }

  if (!claims?.sub || !claims?.role) {
    throw new AppError(401, "INVALID_ACCESS_TOKEN", "The access token is invalid.");
  }

  const user = await getCatalogPool().query(
    `SELECT user_id, username, email, role, hospital_id, blood_bank_id,
            donor_id, donor_city_code, is_active
     FROM catalog.users
     WHERE user_id = $1`,
    [claims.sub],
  );
  const row = user.rows[0];
  if (!row?.is_active) {
    throw new AppError(401, "ACCOUNT_INACTIVE", "This account is inactive.");
  }
  req.user = row;
  next();
});

export function requireRole(...roles) {
  return function roleGuard(req, _res, next) {
    if (!req.user) {
      next(new AppError(401, "UNAUTHENTICATED", "Sign in to continue."));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new AppError(403, "FORBIDDEN", "Your role cannot perform this action."));
      return;
    }
    next();
  };
}

export function requireHospitalScope(req, hospitalId) {
  if (req.user.role === "HOSPITAL_ADMIN" && req.user.hospital_id !== hospitalId) {
    throw new AppError(403, "TENANT_SCOPE_VIOLATION", "You can only access your hospital's records.");
  }
}

export function requireBankScope(req, bankId) {
  if (req.user.role === "BLOODBANK_ADMIN" && req.user.blood_bank_id !== bankId) {
    throw new AppError(403, "TENANT_SCOPE_VIOLATION", "You can only access your blood bank's records.");
  }
}