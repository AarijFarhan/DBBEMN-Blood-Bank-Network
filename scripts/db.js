import pg from "pg";

import { CITY_CODES } from "../backend/src/db/shard-router.js";

const { Pool } = pg;

const CITY_CODE_SET = new Set(CITY_CODES);

/**
 * Script-side database access.
 *
 * Why this is separate from backend/src/db/registry.js: scripts run outside the
 * API process (migrate, seed, invariant checks) and must be able to target a
 * specific node by URL without booting the whole app config, which would demand
 * JWT secrets just to create a pool. In distributed mode a script usually needs
 * all four nodes at once, which is what `allScriptPools` provides.
 */

export const CONNECTION_RETRY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "57P03",
  "08000",
  "08003",
  "08006",
]);

export function createScriptPool(connectionString, { max = 5, label = "default" } = {}) {
  if (!connectionString) throw new Error(`No connection string for pool "${label}".`);
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  });
  pool.on("error", (error) => {
    process.stderr.write(`[db:${label}] idle client error: ${error.message}\n`);
  });
  return pool;
}

/** Curried connector: returns a zero-argument function that yields a client. */
export function connectWithRetryFor(pool, { attempts = 5, baseDelayMs = 250 } = {}) {
  return async function connectWithRetry() {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await pool.connect();
      } catch (error) {
        lastError = error;
        if (!CONNECTION_RETRY_CODES.has(error.code) || attempt + 1 === attempts) break;
        const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs));
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * 2 ** attempt + jitter),
        );
      }
    }
    throw lastError;
  };
}

export function withClientFor(pool) {
  return async function withClient(callback) {
    const client = await connectWithRetryFor(pool)();
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  };
}

/**
 * Mode detection, mirroring backend/src/config/env.js so the scripts and the API
 * never disagree about the topology. DB_MODE is authoritative when set; with it
 * unset the legacy single-box layout (only DATABASE_URL) stays `single`.
 */
export function scriptDatabaseMode() {
  const raw = (process.env.DB_MODE ?? "").trim().toLowerCase();
  if (raw === "single" || raw === "distributed") return raw;
  if (raw) throw new Error('DB_MODE must be either "single" or "distributed".');
  const perCity = ["KHI_DATABASE_URL", "LHE_DATABASE_URL", "ISB_DATABASE_URL"].filter(
    (name) => process.env[name],
  );
  return perCity.length > 0 ? "distributed" : "single";
}

let singlePool = null;

/** The legacy single-node pool, created on first use rather than at import. */
export function scriptPool() {
  if (!singlePool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set. This script targets the single node; in distributed mode use allScriptPools().",
      );
    }
    singlePool = createScriptPool(process.env.DATABASE_URL, { label: "single" });
  }
  return singlePool;
}

/**
 * Lazy stand-in for the old eagerly-created `pool` export.
 * Why lazy: a distributed run has no DATABASE_URL at all, and building the pool
 * at import time made `import { pool } from "./db.js"` throw before migrate could
 * even read the per-node URLs. Existing scripts keep working unchanged.
 */
export const pool = new Proxy(
  {},
  {
    get(_target, property) {
      const target = scriptPool();
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);

export const connectWithRetry = (...args) => connectWithRetryFor(scriptPool())(...args);
export const withClient = (...args) => withClientFor(scriptPool())(...args);

let cachedPools = null;

/**
 * Every node this script should touch. Cached, because each call used to mint a
 * brand-new set of pools: migrate.js called this once for work and again in its
 * `finally`, so the pools it actually used were never ended and the process hung.
 */
export function allScriptPools() {
  if (cachedPools) return cachedPools;

  if (scriptDatabaseMode() === "single") {
    cachedPools = [{ label: "single", pool: scriptPool() }];
    return cachedPools;
  }

  const missing = [
    ["CATALOG_DATABASE_URL", process.env.CATALOG_DATABASE_URL],
    ["KHI_DATABASE_URL", process.env.KHI_DATABASE_URL],
    ["LHE_DATABASE_URL", process.env.LHE_DATABASE_URL],
    ["ISB_DATABASE_URL", process.env.ISB_DATABASE_URL],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`DB_MODE=distributed requires ${missing.join(", ")}.`);
  }

  const urls = {
    catalog: process.env.CATALOG_DATABASE_URL,
    KHI: process.env.KHI_DATABASE_URL,
    LHE: process.env.LHE_DATABASE_URL,
    ISB: process.env.ISB_DATABASE_URL,
  };
  cachedPools = Object.entries(urls).map(([label, url]) => ({
    label,
    pool: createScriptPool(url, { label }),
  }));
  return cachedPools;
}

/** End every pool a script created, ignoring duplicates from single-node mode. */
export async function endAllScriptPools(entries = allScriptPools()) {
  await Promise.allSettled([...new Set(entries.map((entry) => entry.pool))].map((p) => p.end()));
  cachedPools = null;
  singlePool = null;
}

/**
 * Pool that owns the `catalog` and `common` schemas: the catalog node in
 * distributed mode, the one shared pool in single mode.
 *
 * Why this exists: the `pool` export above always resolves to DATABASE_URL, which
 * in distributed mode is not a node the application reads or writes. A script that
 * seeds catalog rows through `pool` would write them into a database no request
 * ever reaches, and report success. Callers must name the node they mean.
 */
export function catalogScriptPool() {
  const nodes = allScriptPools();
  const catalog = nodes.find((node) => node.label === "catalog");
  return (catalog ?? nodes[0]).pool;
}

/**
 * Pool that owns one city's `hot`/`history`/`read` schemas.
 *
 * In single mode every lookup returns the same pool, so this is a no-op there and
 * scripts stay topology-agnostic. An unknown city throws instead of falling back
 * to the catalog node, because writing one city's rows to the catalog node is the
 * split-brain this routing exists to prevent.
 */
export function cityScriptPool(cityCode) {
  if (!CITY_CODE_SET.has(cityCode)) {
    throw new RangeError(`Unsupported city code: ${String(cityCode)}`);
  }
  const nodes = allScriptPools();
  if (nodes.length === 1) return nodes[0].pool;
  const node = nodes.find((entry) => entry.label === cityCode);
  if (!node) {
    throw new Error(
      `Distributed mode has no node for ${cityCode}; set ${cityCode}_DATABASE_URL.`,
    );
  }
  return node.pool;
}

export const withCatalogScriptClient = (callback) =>
  withClientFor(catalogScriptPool())(callback);

export const connectForCity = (cityCode) => connectWithRetryFor(cityScriptPool(cityCode));
