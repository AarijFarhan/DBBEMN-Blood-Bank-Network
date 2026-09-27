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
    throw new Error(`${name} must be configured in the environment with at least 32 characters.`);
  }
  return value;
}

// Topology detection. `single` keeps the original one-instance layout working
// unchanged; `distributed` gives every city its own node plus a dedicated
// catalog node. Why infer instead of requiring a flag: an unset DB_MODE with
// only DATABASE_URL set is the legacy single-box setup, and silently
// breaking it on upgrade would be worse than an explicit error later.
function detectDatabaseMode() {
  const raw = (process.env.DB_MODE ?? "").trim().toLowerCase();
  if (raw) {
    if (raw !== "single" && raw !== "distributed") {
      throw new Error('DB_MODE must be either "single" or "distributed".');
    }
    return raw;
  }
  const perCity = ["KHI_DATABASE_URL", "LHE_DATABASE_URL", "ISB_DATABASE_URL"].filter(
    (name) => process.env[name],
  );
  return perCity.length > 0 ? "distributed" : "single";
}

const databaseMode = detectDatabaseMode();

// In distributed mode catalog and common live on their own node, and each city
// node needs its own URL. In single mode every schema shares DATABASE_URL, so
// the per-city variables stay undefined and the registry routes them all to the
// one pool instead of building pools it would never use.
if (databaseMode === "single" && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be provided in single-node mode.");
}

if (databaseMode === "distributed") {
  const missing = [
    ["CATALOG_DATABASE_URL", process.env.CATALOG_DATABASE_URL],
    ["KHI_DATABASE_URL", process.env.KHI_DATABASE_URL],
    ["LHE_DATABASE_URL", process.env.LHE_DATABASE_URL],
    ["ISB_DATABASE_URL", process.env.ISB_DATABASE_URL],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `DB_MODE=distributed requires ${missing.join(", ")}. ` +
        "Every node must be reachable, otherwise city traffic has nowhere to go.",
    );
  }
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
  databaseMode,
  databaseUrl: process.env.DATABASE_URL,
  catalogDatabaseUrl: process.env.CATALOG_DATABASE_URL ?? process.env.DATABASE_URL,
  cityDatabaseUrls: Object.freeze({
    KHI: process.env.KHI_DATABASE_URL ?? process.env.DATABASE_URL,
    LHE: process.env.LHE_DATABASE_URL ?? process.env.DATABASE_URL,
    ISB: process.env.ISB_DATABASE_URL ?? process.env.DATABASE_URL,
  }),
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

  // ── Cache / Bloom filter ────────────────────────────────────────────────
  // Every value here is optional. With no REDIS_URL the process falls back to a
  // bounded in-memory cache and the Bloom filters degrade to exact in-memory
  // sets, so the app boots and behaves identically with no cache at all. See
  // backend/src/cache/store.js for why the fallback is safe here and what it
  // costs on a multi-instance deploy.
  cache: Object.freeze({
    redisUrl: (process.env.REDIS_URL ?? "").trim() || null,
    keyPrefix: (process.env.CACHE_KEY_PREFIX ?? "").trim() || "dbbemn",
    // Hard ceiling on any cached entry, independent of the per-entry TTL. This
    // is the safety net for search results: if an inventory-version bump is ever
    // missed, staleness is still bounded rather than unbounded.
    searchMaxTtlSeconds: numberFromEnv("CACHE_SEARCH_MAX_TTL", 15, { min: 1, max: 300 }),
    searchTtlSeconds: numberFromEnv("CACHE_SEARCH_TTL", 10, { min: 1, max: 300 }),
    summaryTtlSeconds: numberFromEnv("CACHE_SUMMARY_TTL", 20, { min: 1, max: 600 }),
    directoryTtlSeconds: numberFromEnv("CACHE_DIRECTORY_TTL", 60, { min: 1, max: 3600 }),
    memoryMaxEntries: numberFromEnv("CACHE_MEMORY_MAX_ENTRIES", 5000, { min: 16, max: 1_000_000 }),
    enabled: (process.env.CACHE_ENABLED ?? "true").trim().toLowerCase() !== "false",
  }),
  bloom: Object.freeze({
    enabled: (process.env.BLOOM_ENABLED ?? "true").trim().toLowerCase() !== "false",
    // Sizing only affects the false-positive rate. Overloading a filter makes
    // lookups slower (more false hits), never incorrect: Bloom filters have no
    // false negatives, so an undersized filter can only cost queries, not answers.
    expectedItems: numberFromEnv("BLOOM_EXPECTED_ITEMS", 50_000, { min: 100, max: 10_000_000 }),
    errorRate: (() => {
      const value = Number(process.env.BLOOM_ERROR_RATE ?? 0.001);
      if (!Number.isFinite(value) || value <= 0 || value >= 0.1) {
        throw new Error("BLOOM_ERROR_RATE must be a number greater than 0 and less than 0.1.");
      }
      return value;
    })(),
  }),
});