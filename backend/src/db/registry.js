import { env } from "../config/env.js";
import { CITY_CODES } from "./shard-router.js";
import {
  createPool,
  withClientFor,
  withSerializableRetryFor,
  waitForDatabase,
} from "./pool.js";

/**
 * Connection registry.
 *
 * Why this is separate from shard-router.js: shard-router is a pure
 * cityCode -> schema-identifier function with no database knowledge, which
 * makes it trivially testable and safe to import from scripts. Pools are a
 * runtime concern and live here.
 *
 * In `single` mode there is exactly one PostgreSQL instance holding catalog,
 * common and all three city schemas, so every lookup returns that one pool.
 * In `distributed` mode each city is its own instance and catalog is separate.
 */

// In single mode every schema lives in one instance, so all three city lookups
// and the catalog lookup must resolve to the SAME pool. Creating one pool per
// city would triple the connection count against a single database for no
// isolation benefit, since there is only one server to isolate from.
const singlePool =
  env.databaseMode === "single" ? createPool(env.databaseUrl, { label: "single" }) : null;

const cityPools = Object.freeze(
  Object.fromEntries(
    CITY_CODES.map((cityCode) => [
      cityCode,
      singlePool ?? createPool(env.cityDatabaseUrls[cityCode], { label: cityCode }),
    ]),
  ),
);

const catalogPool = singlePool ?? createPool(env.catalogDatabaseUrl, { label: "catalog" });

/** Pool owning the `catalog` and `common` schemas. */
export function getCatalogPool() {
  return catalogPool;
}

/**
 * Pool owning a city's `hot` / `history` / `read` schemas.
 * Throws on an unknown city rather than returning a fallback, because silently
 * routing to the wrong city's node would leak one shard's data into another.
 */
export function getPoolForCity(cityCode) {
  const pool = cityPools[cityCode];
  if (!pool) {
    throw new RangeError(`Unsupported city code: ${String(cityCode)}`);
  }
  return pool;
}

export const withCityClient = (cityCode) => withClientFor(getPoolForCity(cityCode));
export const withCitySerializable = (cityCode) =>
  withSerializableRetryFor(getPoolForCity(cityCode));

export const withCatalogClient = withClientFor(catalogPool);
export const withCatalogSerializable = withSerializableRetryFor(catalogPool);

/** All city pools, in CITY_CODES order. */
export function allCityPools() {
  return CITY_CODES.map((cityCode) => ({ cityCode, pool: cityPools[cityCode] }));
}

/**
 * Readiness across every node this process depends on.
 * In distributed mode a single unreachable node means the instance is not ready
 * to serve that city, so it is reported rather than silently ignored.
 */
export async function waitForDatabases() {
  const checks =
    env.databaseMode === "single"
      ? [{ label: "single", pool: cityPools.KHI }]
      : [
          { label: "catalog", pool: catalogPool },
          // allCityPools() keys entries by `cityCode`; normalise to `label` here
          // so the reported node names are never undefined.
          ...allCityPools().map(({ cityCode, pool }) => ({ label: cityCode, pool })),
        ];

  const results = await Promise.allSettled(
    checks.map(async (check) => {
      await waitForDatabase(check.pool);
      return check.label;
    }),
  );

  const healthy = results.filter((result) => result.status === "fulfilled").map((r) => r.value);
  const failed = results
    .map((result, index) => (result.status === "rejected" ? checks[index].label : null))
    .filter(Boolean);

  if (failed.length > 0) {
    const error = new Error(`Database nodes unreachable: ${failed.join(", ")}`);
    error.code = "SHARD_UNAVAILABLE";
    error.nodes = failed;
    throw error;
  }
  return healthy;
}

/** Redact credentials so a connection string is safe to log or return. */
export function describeTopology() {
  const redact = (url) => {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.hostname}:${parsed.port || 5432}/${parsed.pathname.slice(1)}`;
    } catch {
      return "unparseable";
    }
  };
  return {
    mode: env.databaseMode,
    catalog: redact(env.catalogDatabaseUrl),
    cities: Object.fromEntries(
      CITY_CODES.map((cityCode) => [cityCode, redact(env.cityDatabaseUrls[cityCode])]),
    ),
  };
}

export { createPool, waitForDatabase };
