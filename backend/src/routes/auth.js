import { Router } from "express";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { connectWithRetryFor, withSerializableRetryFor } from "../db/pool.js";
import { getCatalogPool, getPoolForCity } from "../db/registry.js";
import { authenticate } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { validate } from "../middleware/validate.js";
import { schemasFor } from "../db/shard-router.js";
import { assertCityWritable } from "../services/chaos.js";
import { createTokenPair, hashRefreshToken } from "../utils/tokens.js";
import { loginSchema, refreshSchema, registerDonorSchema } from "../utils/validators.js";

const router = Router();

function publicUser(user) {
  return {
    userId: user.user_id,
    username: user.username,
    email: user.email,
    role: user.role,
    hospitalId: user.hospital_id,
    bloodBankId: user.blood_bank_id,
    donorId: user.donor_id,
    donorCityCode: user.donor_city_code,
  };
}

async function saveRefreshToken(user) {
  const pair = createTokenPair(user);
  await getCatalogPool().query(
    `INSERT INTO catalog.refresh_tokens (token_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '7 days')`,
    [pair.tokenId, user.user_id, hashRefreshToken(pair.refreshToken)],
  );
  return pair;
}

router.post(
  "/register-donor",
  validate(registerDonorSchema),
  asyncRoute(async (req, res) => {
    const body = req.body;
    const donorId = randomUUID();
    const { hist } = schemasFor(body.cityCode);
    const passwordHash = await bcrypt.hash(body.password, 12);

    await withSerializableRetryFor(getPoolForCity(body.cityCode))(async (client) => {
      await assertCityWritable(client, body.cityCode);
      return client.query(
        `INSERT INTO ${hist}.donors
           (donor_id, full_name, phone, date_of_birth, sex, weight_kg,
            blood_group, rh_factor, city_code, is_available)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)`,
        [
          donorId,
          body.fullName,
          body.phone,
          body.dateOfBirth,
          body.sex,
          body.weightKg,
          body.bloodGroup,
          body.rhFactor,
          body.cityCode,
        ],
      );
    });

    let user;
    try {
      const result = await getCatalogPool().query(
        `INSERT INTO catalog.users
           (username, email, password_hash, role, donor_id, donor_city_code)
         VALUES ($1, $2, $3, 'DONOR', $4, $5)
         RETURNING user_id, username, email, role, hospital_id, blood_bank_id,
                   donor_id, donor_city_code`,
        [body.username, body.email, passwordHash, donorId, body.cityCode],
      );
      user = result.rows[0];
    } catch (error) {
      await withSerializableRetryFor(getPoolForCity(body.cityCode))((client) =>
        client.query(`DELETE FROM ${hist}.donors WHERE donor_id = $1`, [donorId]),
      ).catch(() => {});
      if (error.code === "23505") {
        throw new AppError(409, "ACCOUNT_ALREADY_EXISTS", "That username or email is already registered.");
      }
      throw error;
    }

    const pair = await saveRefreshToken(user);
    res.status(201).json({
      user: publicUser(user),
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: "Bearer",
      expiresIn: 900,
    });
  }),
);

router.post(
  "/login",
  validate(loginSchema),
  asyncRoute(async (req, res) => {
    const login = req.body.login.toLowerCase();
    const result = await getCatalogPool().query(
      `SELECT user_id, username, email, password_hash, role, hospital_id,
              blood_bank_id, donor_id, donor_city_code, is_active
       FROM catalog.users
       WHERE lower(username) = $1 OR lower(email) = $1
       LIMIT 1`,
      [login],
    );
    const user = result.rows[0];
    const matches = user?.is_active && await bcrypt.compare(req.body.password, user.password_hash);
    if (!matches) {
      throw new AppError(401, "INVALID_CREDENTIALS", "The username or password is incorrect.");
    }

    const pair = await saveRefreshToken(user);
    res.json({
      user: publicUser(user),
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      tokenType: "Bearer",
      expiresIn: 900,
    });
  }),
);

router.post(
  "/refresh",
  validate(refreshSchema),
  asyncRoute(async (req, res) => {
    let claims;
    try {
      claims = jwt.verify(req.body.refreshToken, env.jwtRefreshSecret, {
        issuer: "dbbemn",
        audience: "dbbemn-refresh",
      });
    } catch {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "The refresh token is invalid or expired.");
    }
    if (!claims?.jti || claims.token_type !== "refresh" || !claims?.sub) {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "The refresh token is invalid.");
    }

    // Must be the per-pool factory: refresh_tokens live on the catalog node,
    // which in distributed mode is a different server than the legacy single pool.
    const client = await connectWithRetryFor(getCatalogPool())();
    try {
      await client.query("BEGIN");
      const stored = await client.query(
        `SELECT token_hash, revoked_at, expires_at
         FROM catalog.refresh_tokens
         WHERE token_id = $1 AND user_id = $2
         FOR UPDATE`,
        [claims.jti, claims.sub],
      );
      const tokenRow = stored.rows[0];
      if (
        !tokenRow ||
        tokenRow.revoked_at ||
        new Date(tokenRow.expires_at) <= new Date() ||
        tokenRow.token_hash !== hashRefreshToken(req.body.refreshToken)
      ) {
        throw new AppError(401, "REFRESH_TOKEN_REVOKED", "The refresh token has already been used or revoked.");
      }

      const userResult = await client.query(
        `SELECT user_id, username, email, role, hospital_id, blood_bank_id,
                donor_id, donor_city_code, is_active
         FROM catalog.users WHERE user_id = $1`,
        [claims.sub],
      );
      const user = userResult.rows[0];
      if (!user?.is_active) {
        throw new AppError(401, "ACCOUNT_INACTIVE", "This account is inactive.");
      }

      await client.query(
        `UPDATE catalog.refresh_tokens SET revoked_at = now()
         WHERE token_id = $1 AND revoked_at IS NULL`,
        [claims.jti],
      );
      const pair = createTokenPair(user);
      await client.query(
        `INSERT INTO catalog.refresh_tokens (token_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '7 days')`,
        [pair.tokenId, user.user_id, hashRefreshToken(pair.refreshToken)],
      );
      await client.query("COMMIT");
      res.json({
        user: publicUser(user),
        accessToken: pair.accessToken,
        refreshToken: pair.refreshToken,
        tokenType: "Bearer",
        expiresIn: 900,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }),
);

router.post(
  "/logout",
  authenticate,
  validate(refreshSchema),
  asyncRoute(async (req, res) => {
    let claims;
    try {
      claims = jwt.verify(req.body.refreshToken, env.jwtRefreshSecret, {
        issuer: "dbbemn",
        audience: "dbbemn-refresh",
      });
    } catch {
      throw new AppError(401, "INVALID_REFRESH_TOKEN", "The refresh token is invalid or expired.");
    }
    if (claims.sub !== req.user.user_id || !claims.jti) {
      throw new AppError(403, "TOKEN_OWNER_MISMATCH", "This refresh token belongs to another account.");
    }
    await getCatalogPool().query(
      `UPDATE catalog.refresh_tokens
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE token_id = $1 AND user_id = $2 AND token_hash = $3`,
      [claims.jti, req.user.user_id, hashRefreshToken(req.body.refreshToken)],
    );
    res.status(204).end();
  }),
);

router.get(
  "/me",
  authenticate,
  asyncRoute(async (req, res) => {
    res.json({ user: publicUser(req.user) });
  }),
);

export default router;