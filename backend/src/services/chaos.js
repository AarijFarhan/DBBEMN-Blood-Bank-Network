import { getCatalogPool, getPoolForCity } from "../db/registry.js";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { AppError } from "../middleware/errors.js";

const CACHE_TTL_MS = 1_000;
let cachedFlags = null;
let cacheExpiresAt = 0;
let flagsRequest = null;

function normalizeFlag(row) {
  return Object.freeze({
    cityCode: row.city_code.trim(),
    primaryDown: Boolean(row.primary_down),
    replicaDown: Boolean(row.replica_down),
    extraLagMs: Number(row.extra_lag_ms),
    updatedAt: row.updated_at,
  });
}

function defaultFlag(cityCode) {
  return Object.freeze({
    cityCode,
    primaryDown: false,
    replicaDown: false,
    extraLagMs: 0,
    updatedAt: null,
  });
}

export function invalidateChaosCache() {
  cachedFlags = null;
  cacheExpiresAt = 0;
}

export async function getChaosFlags({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedFlags && now < cacheExpiresAt) return cachedFlags;
  if (flagsRequest) return flagsRequest;

  flagsRequest = getCatalogPool().query(
    `SELECT city_code, primary_down, replica_down, extra_lag_ms, updated_at
     FROM catalog.chaos_flags
     ORDER BY city_code`,
  ).then((result) => {
    const flags = Object.create(null);
    for (const cityCode of CITY_CODES) flags[cityCode] = defaultFlag(cityCode);
    for (const row of result.rows) {
      const cityCode = row.city_code.trim();
      if (CITY_CODES.includes(cityCode)) flags[cityCode] = normalizeFlag(row);
    }
    cachedFlags = Object.freeze(flags);
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return cachedFlags;
  }).finally(() => {
    flagsRequest = null;
  });

  return flagsRequest;
}

export async function getChaosFlag(cityCode, options = {}) {
  if (!CITY_CODES.includes(cityCode)) throw new RangeError(`Unsupported city code: ${String(cityCode)}`);
  const flags = await getChaosFlags(options);
  return flags[cityCode] ?? defaultFlag(cityCode);
}

export async function setChaosFlag(cityCode, patch) {
  if (!CITY_CODES.includes(cityCode)) throw new RangeError(`Unsupported city code: ${String(cityCode)}`);
  const assignments = [];
  const values = [cityCode];

  if (Object.hasOwn(patch, "primaryDown")) {
    if (typeof patch.primaryDown !== "boolean") throw new TypeError("primaryDown must be boolean");
    values.push(patch.primaryDown);
    assignments.push(`primary_down = $${values.length}`);
  }
  if (Object.hasOwn(patch, "replicaDown")) {
    if (typeof patch.replicaDown !== "boolean") throw new TypeError("replicaDown must be boolean");
    values.push(patch.replicaDown);
    assignments.push(`replica_down = $${values.length}`);
  }
  if (Object.hasOwn(patch, "extraLagMs")) {
    if (!Number.isInteger(patch.extraLagMs) || patch.extraLagMs < 0 || patch.extraLagMs > 86_400_000) {
      throw new RangeError("extraLagMs must be an integer between 0 and 86400000");
    }
    values.push(patch.extraLagMs);
    assignments.push(`extra_lag_ms = $${values.length}`);
  }
  if (assignments.length === 0) throw new TypeError("A chaos flag change is required");

  assignments.push("updated_at = now()");
  const result = await getCatalogPool().query(
    `UPDATE catalog.chaos_flags
     SET ${assignments.join(", ")}
     WHERE city_code = $1
     RETURNING city_code, primary_down, replica_down, extra_lag_ms, updated_at`,
    values,
  );
  if (result.rowCount === 0) {
    throw new AppError(404, "CITY_NOT_FOUND", "The chaos city was not found.");
  }
  invalidateChaosCache();
  return normalizeFlag(result.rows[0]);
}

export async function assertCityWritable(clientOrCity, cityArgument) {
  const hasClient = Boolean(clientOrCity && typeof clientOrCity.query === "function");
  const cityCode = hasClient ? cityArgument : clientOrCity;
  if (!CITY_CODES.includes(cityCode)) throw new RangeError(`Unsupported city code: ${String(cityCode)}`);
  // Why the catalog pool and not the caller's client: chaos_flags lives on the
  // catalog node, so a city transaction client cannot read it. This flag is a
  // simulated outage toggle, so a read outside the write transaction is
  // acceptable; losing atomicity here costs nothing and keeps the check working
  // once the nodes are genuinely separate.
  const result = await getCatalogPool().query(
    "SELECT primary_down FROM catalog.chaos_flags WHERE city_code = $1",
    [cityCode],
  );
  if (result.rows[0]?.primary_down) {
    throw new AppError(
      503,
      "SHARD_WRITE_UNAVAILABLE",
      `Writes for ${cityCode} are unavailable.`,
      { cityCode, simulation: "SIMULATED" },
      { "Retry-After": "5" },
    );
  }
}

export async function measureReplicaLagMs(cityCode) {
  const { hot, read } = schemasFor(cityCode);
  const result = await getPoolForCity(cityCode).query(
    `SELECT COALESCE(
       ceil(EXTRACT(EPOCH FROM (now() - min(o.created_at))) * 1000),
       0
     )::int AS lag_ms
     FROM (
       SELECT COALESCE(
         (SELECT last_applied_event_id
          FROM ${read}.replication_state WHERE id = TRUE),
         0
       ) AS last_event_id
     ) s
     LEFT JOIN ${hot}.outbox o ON o.event_id > s.last_event_id`,
  );
  return Number(result.rows[0]?.lag_ms ?? 0);
}
