import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function hashRefreshToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createTokenPair(user) {
  const claims = {
    role: user.role,
    hospital_id: user.hospital_id ?? null,
    blood_bank_id: user.blood_bank_id ?? null,
    donor_id: user.donor_id ?? null,
    donor_city_code: user.donor_city_code ?? null,
  };
  const accessToken = jwt.sign(claims, env.jwtSecret, {
    subject: user.user_id,
    issuer: "dbbemn",
    audience: "dbbemn-api",
    expiresIn: "15m",
  });
  const tokenId = randomUUID();
  const refreshToken = jwt.sign({ ...claims, token_type: "refresh" }, env.jwtRefreshSecret, {
    subject: user.user_id,
    jwtid: tokenId,
    issuer: "dbbemn",
    audience: "dbbemn-refresh",
    expiresIn: "7d",
  });
  return { accessToken, refreshToken, tokenId };
}