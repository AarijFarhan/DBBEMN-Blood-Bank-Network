import { randomInt } from "node:crypto";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

const CONNECTION_RETRY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "57P03",
  "08000",
  "08003",
  "08006",
]);

/**
 * Build a pool bound to one database URL.
 * Why a factory: in distributed mode every node is a separate PostgreSQL
 * instance, so each needs its own pool. The single-node path just calls this
 * once and behaves exactly as before.
 */
export function createPool(connectionString, { max = 10, label = "default" } = {}) {
  if (!connectionString) {
    throw new Error(`Cannot create pool "${label}": no connection string configured.`);
  }
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    keepAlive: true,
  });
  // Why: without a listener an idle client killed by the server or by Docker
  // restart surfaces as an unhandled 'error' event and takes the process down.
  // Queries still reject normally; this only stops the crash.
  pool.on("error", (error) => {
    console.error(`[db:${label}] idle client error: ${error.message}`);
  });
  return pool;
}

/**
 * Curried connector: returns a zero-argument function that yields a client.
 * Why curried rather than returning the client directly: callers need to build
 * the connector once per node (`const connect = connectWithRetryFor(pool)`) and
 * then acquire a fresh client per attempt, which is what makes the SERIALIZABLE
 * retry below able to re-acquire from the same node.
 */
export function connectWithRetryFor(pool, { attempts = 5, baseDelayMs = 250 } = {}) {
  return async function connectWithRetry() {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await pool.connect();
      } catch (error) {
        lastError = error;
        if (!CONNECTION_RETRY_CODES.has(error.code) || attempt + 1 === attempts) break;
        const delay = baseDelayMs * 2 ** attempt + randomInt(0, Math.max(2, baseDelayMs));
        await new Promise((resolve) => setTimeout(resolve, delay));
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
 * SERIALIZABLE retry scoped to a single pool.
 * Why this can no longer be a module-level singleton: retries must re-acquire
 * from the *same* node the work started on, otherwise a retry would silently
 * run against a different database than the one it is compensating.
 */
export function withSerializableRetryFor(pool) {
  return async function withSerializableRetry(callback, { attempts = 5, baseDelayMs = 12 } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const client = await connectWithRetryFor(pool)();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const result = await callback(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        lastError = error;
        await client.query("ROLLBACK").catch(() => {});
        if (!["40001", "40P01"].includes(error.code) || attempt + 1 === attempts) throw error;
      } finally {
        client.release();
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          baseDelayMs * 2 ** attempt + randomInt(0, Math.max(2, baseDelayMs)),
        ),
      );
    }
    throw lastError;
  };
}

/**
 * Legacy single-node accessors.
 *
 * These exist only for code that genuinely targets the one shared database:
 * the test suites and scripts/bootstrap-admin.js. In distributed mode there is no
 * single database, so this throws instead of quietly building a fifth pool
 * against DATABASE_URL - a pool nothing reads from but which still points at the
 * old instance, which is exactly how a half-migrated deployment silently keeps
 * writing to the wrong database.
 */
let legacyPool = null;

function legacySinglePool() {
  if (env.databaseMode === "distributed") {
    throw new Error(
      "The legacy single pool does not exist in distributed mode. " +
        "Use getPoolForCity(cityCode) or getCatalogPool() from db/registry.js.",
    );
  }
  if (!legacyPool) legacyPool = createPool(env.databaseUrl, { label: "single" });
  return legacyPool;
}

export const pool = new Proxy(
  {},
  {
    get(_target, property) {
      const target = legacySinglePool();
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  },
);

export const withClient = (callback) => withClientFor(legacySinglePool())(callback);
export const withSerializableRetry = (callback, options) =>
  withSerializableRetryFor(legacySinglePool())(callback, options);
export const connectWithRetry = (...args) => connectWithRetryFor(legacySinglePool())(...args);

export async function waitForDatabase(target = legacySinglePool()) {
  return withClientFor(target)((client) => client.query("SELECT 1"));
}
