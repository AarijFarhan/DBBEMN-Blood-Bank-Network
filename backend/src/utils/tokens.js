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
  // Why the access token carries a jti: revocation is by identifier, not by
  // token string. Without it, logout could only revoke the refresh token and the
  // access token would stay valid for its full 15 minutes — a real window on a
  // shared or stolen device. Tokens minted before this change have no jti; the
  // auth middleware treats those as un-revocable rather than rejecting them.
  const accessTokenId = randomUUID();
  const accessToken = jwt.sign(claims, env.jwtSecret, {
    subject: user.user_id,
    jwtid: accessTokenId,
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
  return { accessToken, refreshToken, tokenId, accessTokenId };
}