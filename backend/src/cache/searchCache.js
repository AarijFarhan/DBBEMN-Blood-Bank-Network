/**
 * Read-through cache for the scatter-gather reads (unit search, stock summary).
 *
 * Three things must hold for a cached answer to be safe to serve:
 *
 *  1. **No city it depends on has changed.** The key embeds each city's
 *     inventory version, and every inventory write bumps that version. So a
 *     mutation does not need to find and delete the affected keys — it just
 *     makes them unreachable, which also works across instances where a delete
 *     could not.
 *
 *  2. **No shard was missing when the answer was built.** A partial answer
 *     under-reports available stock. Serving one after a shard recovers would
 *     keep hiding units that are actually there, so degraded results are never
 *     written to the cache in the first place.
 *
 *  3. **The topology that produced it still holds.** A cached body labelled
 *     `SIMULATED_REPLICA` must not be served after that replica goes down, or
 *     the API would claim a read it never made. The chaos signature is compared
 *     on every hit; a mismatch is a miss.
 *
 * Rule 2 and 3 mean a cache hit is only ever possible when the last read was
 * complete and the current topology matches. Anything interesting goes to
 * PostgreSQL.
 */
import { createHash, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import {
  cacheDeleteIfValue,
  cacheGet,
  cacheSet,
  cacheSetIfAbsent,
  inventoryVersions,
  isSharedCache,
  versionToken,
} from "./store.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "search-cache" });

/**
 * Topology fingerprint. `primaryDown` matters because it changes the read
 * source; `replicaDown` matters because it changes which source was actually
 * used. Lag is deliberately excluded — it is telemetry, and including it would
 * throw away hits every few seconds.
 */
export function flagsSignature(cities, flags) {
  return cities
    .map((cityCode) => {
      const flag = flags?.[cityCode] ?? {};
      return `${cityCode}:${flag.primaryDown ? 1 : 0}${flag.replicaDown ? 1 : 0}`;
    })
    .join(",");
}

function digest(value) {
  return createHash("sha256").update(value).digest("base64url").slice(0, 32);
}

/**
 * Build the cache key for one read.
 *
 * `fingerprint` is the caller's own query identity (already normalised, so
 * equivalent queries share an entry). The version token is appended last so a
 * version bump changes the key without the caller needing to know versions
 * exist.
 */
export async function buildKey(namespace, fingerprint, cities) {
  const versions = await inventoryVersions(cities);
  return `${namespace}:${digest(`${namespace}|${fingerprint}`)}:${versionToken(versions, cities)}`;
}

/**
 * Cache a completed read.
 *
 * `complete` must be false whenever any shard was unavailable — the caller
 * decides, and this is the only guard on under-reported stock.
 */
export async function remember(key, payload, { cities, flags, complete, ttlSeconds }) {
  if (!env.cache.enabled) return;
  if (!complete) {
    log.debug({ key }, "not caching an incomplete read; it would under-report stock");
    return;
  }
  const ttl = Math.min(ttlSeconds, env.cache.searchMaxTtlSeconds);
  await cacheSet(key, JSON.stringify({ flags: flagsSignature(cities, flags), payload }), ttl);
  warnOnceAboutSharedCache();
}

/**
 * Fetch a cached read, or `null` on any miss or topology change.
 *
 * The in-memory backend is a valid cache for a single process: its version
 * counters and its entries live together, so a bump always invalidates the
 * entries that depend on it. That self-consistency is exactly what the fallback
 * is for. It stops holding the moment a second instance is added — hence the
 * one-time warning below rather than a silent correctness cliff.
 */
export async function recall(key, { cities, flags }) {
  if (!env.cache.enabled) return null;
  warnOnceAboutSharedCache();
  const raw = await cacheGet(key);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw);
    if (entry.flags !== flagsSignature(cities, flags)) {
      log.debug({ key }, "cache hit discarded; topology changed since it was written");
      return null;
    }
    return entry.payload;
  } catch {
    // A corrupt or foreign-format entry is treated as a miss. The TTL will
    // collect it.
    return null;
  }
}

let warnedAboutSharedCache = false;

function warnOnceAboutSharedCache() {
  if (warnedAboutSharedCache || isSharedCache()) return;
  warnedAboutSharedCache = true;
  log.warn(
    "caching search results in process memory. A version bump on one instance " +
      "cannot invalidate another's cache, so this is only correct while exactly " +
      "one API instance is running. Set REDIS_URL before scaling out.",
  );
}

/** Whether cached results are visible to other instances. */
export function sharedCacheRequired() {
  return isSharedCache();
}

/**
 * How long the lock is held, and how long a caller waits for the winner.
 *
 * The lock outlives the work on purpose: if the instance holding it dies, the
 * lock expires rather than blocking the key forever. The wait is short on
 * purpose too - a caller that waits longer than the work takes is just adding
 * latency, so it gives up and computes the answer itself.
 */
const SINGLE_FLIGHT_LOCK_SECONDS = 5;
const SINGLE_FLIGHT_WAIT_MS = 300;
const SINGLE_FLIGHT_POLL_MS = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `work` once per cache key, even when many requests miss at the same time.
 *
 * Without this, a key that is popular enough to be requested by a dozen
 * clients at once is computed a dozen times - every one of them a full
 * scatter-gather across ten shards, against the same rows. The stampede is
 * worst exactly when it hurts most: right after a write invalidates the key.
 *
 * The winner computes and caches the answer; the others wait briefly for that
 * answer to appear and then serve it. A caller that waits out the window
 * computes the answer itself rather than returning nothing.
 */
export async function withSingleFlight(key, options, work) {
  if (!key || !env.cache.enabled) return { value: await work(), fromCache: false };

  const lockKey = `lock:${key}`;
  const token = randomUUID();
  const acquired = await cacheSetIfAbsent(lockKey, token, SINGLE_FLIGHT_LOCK_SECONDS);

  if (acquired) {
    try {
      return { value: await work(), fromCache: false };
    } finally {
      // Release only if the lock is still ours: it may have expired while the
      // work ran, and deleting someone else's lock would let two callers
      // compute the same thing at once.
      await cacheDeleteIfValue(lockKey, token);
    }
  }

  const deadline = Date.now() + SINGLE_FLIGHT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(SINGLE_FLIGHT_POLL_MS);
    const hit = await recall(key, options);
    if (hit) return { value: hit, fromCache: true };
  }

  log.debug({ key }, "single-flight wait expired; computing the answer directly");
  return { value: await work(), fromCache: false };
}
