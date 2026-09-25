import { hkdfSync, randomUUID } from "node:crypto";

function numberFromEnv(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw new Error(`${name} must be a number between ${min ?? "-∞"} and ${max ?? "∞"}.`);
  }
  return value;
}

function requiredSecret(name) {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} must be configured in Replit Secrets with at least 32 characters.`);
  }
  return value;
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be provided by Replit PostgreSQL.");
}

const jwtSecret = requiredSecret("JWT_SECRET");
const configuredRefreshSecret = requiredSecret("JWT_REFRESH_SECRET");
// Why: HKDF context separation keeps access and refresh JWT keys distinct even
// if operators accidentally configure the same source value for both secrets.
const jwtRefreshSecret = Buffer.from(
  hkdfSync(
    "sha256",
    configuredRefreshSecret,
    "dbbemn-hkdf-salt-v1",
    "dbbemn/jwt-refresh-signing/v1",
    32,
  ),
).toString("base64url");

export const env = Object.freeze({
  port: numberFromEnv("PORT", 8080, { min: 1, max: 65535 }),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret,
  jwtRefreshSecret,
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  donationIntervalDays: numberFromEnv("DONATION_INTERVAL_DAYS", 90, { min: 1, max: 365 }),
  holdMinutes: numberFromEnv("HOLD_MINUTES", 30, { min: 1, max: 240 }),
  criticalHoldMinutes: numberFromEnv("CRITICAL_HOLD_MINUTES", 60, { min: 1, max: 360 }),
  replicaLagMs: numberFromEnv("REPLICA_LAG_MS", 750, { min: 0, max: 60000 }),
  searchShardTimeoutMs: numberFromEnv("SEARCH_SHARD_TIMEOUT_MS", 1500, { min: 50, max: 30000 }),
  instanceId: process.env.INSTANCE_ID || randomUUID(),
  frontendDist: new URL("../../../frontend/dist/", import.meta.url),
});