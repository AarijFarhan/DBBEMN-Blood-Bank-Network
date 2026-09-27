/**
 * Cache and presence-index substrate.
 *
 * Design constraints, in priority order:
 *
 *  1. **Never throw, never block the request path.** Every operation is
 *     best-effort. A cache outage must degrade throughput, not availability —
 *     in an emergency the difference between "slower" and "down" is the whole
 *     product. So each public method swallows backend errors and returns a
 *     miss.
 *
 *  2. **Never serve a stale clinical answer.** Cached search results are keyed
 *     by a per-city *inventory version* that every unit-status write bumps. A
 *     write therefore makes every prior entry for that city unreachable on the
 *     next read rather than leaving it to expire. The per-entry TTL and
 *     `cache.searchMaxTtlSeconds` are only backstops for a missed bump.
 *
 *  3. **Degrade, do not fail closed on absence of Redis.** With no REDIS_URL
 *     the process uses a bounded in-memory LRU. Version counters and cached
 *     entries then live in the same process, so invalidation stays self-consistent
 *     — correct for a single instance. On multiple API instances the in-memory
 *     version is *not* shared, so a bump in instance A cannot invalidate a cached
 *     answer in instance B. That is why `mode` is reported and logged loudly:
 *     multi-instance deploys must set REDIS_URL. See `warrantForSharedCache()`.
 */
import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "cache" });

/** Bounded LRU. Map preserves insertion order, so the first key is the coldest. */
class MemoryStore {
  constructor(maxEntries) {
    this.max = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency: re-inserting moves the key to the newest position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlSeconds) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, {
      value,
      expiresAt: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
    });
    while (this.map.size > this.max) {
      const coldest = this.map.keys().next().value;
      this.map.delete(coldest);
    }
  }

  delete(key) {
    this.map.delete(key);
  }

  incr(key) {
    const current = Number(this.get(key) ?? 0);
    const next = current + 1;
    this.set(key, String(next), 0);
    return next;
  }
}

/** Redis bit operations used by the Bloom filter, behind the same never-throw rule. */
class RedisBackend {
  constructor(url) {
    this.client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 3000)),
    });
    // Without a listener ioredis emits an unhandled 'error' event, which takes
    // the process down. A dead cache is an expected state here, not a crash.
    this.client.on("error", (error) => {
      if (!this.reported) {
        this.reported = true;
        log.warn({ err: error.message }, "redis unavailable; degrading to in-memory cache");
      }
    });
    this.ready = false;
    this.reported = false;
  }

  async connect() {
    await this.client.connect();
    this.ready = true;
  }

  async get(key) {
    return this.client.get(key);
  }

  async set(key, value, ttlSeconds) {
    if (ttlSeconds > 0) await this.client.set(key, value, "EX", ttlSeconds);
    else await this.client.set(key, value);
  }

  async del(key) {
    await this.client.del(key);
  }

  async incr(key) {
    return this.client.incr(key);
  }

  async setBit(key, offset) {
    await this.client.setbit(key, offset, "1");
  }

  async getBits(key, offsets) {
    if (offsets.length === 0) return [];
    const pipeline = this.client.pipeline();
    for (const offset of offsets) pipeline.getbit(key, offset);
    const results = await pipeline.exec();
    return results.map(([error, value]) => (error ? 0 : Number(value)));
  }

  async quit() {
    if (this.ready) await this.client.quit();
  }
}

/**
 * Bit storage for the in-memory backend.
 *
 * Deliberately NOT the bounded LRU used for ordinary cache entries. Evicting a
 * bit from a Bloom filter turns it into a false negative — the filter would then
 * claim a record is absent from a shard that holds it, and the lookup would 404.
 * A Bloom filter is only sound if it can forget nothing, so this grows a fixed
 * bit array per key and never evicts.
 *
 * Redis needs no equivalent: SETBIT grows the underlying string in place, so
 * bits are never dropped there.
 */
class MemoryBits {
  constructor() {
    this.buffers = new Map();
  }

  bufferFor(key) {
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = new Uint8Array(1024);
      this.buffers.set(key, buffer);
    }
    return buffer;
  }

  setBit(key, offset) {
    let buffer = this.bufferFor(key);
    if (offset >= buffer.length) {
      // Double until the offset fits, so a large filter costs O(log n) reallocs
      // rather than one per insert.
      let size = buffer.length;
      while (size <= offset) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(buffer);
      this.buffers.set(key, grown);
      buffer = grown;
    }
    buffer[offset >>> 3] |= 1 << (offset & 7);
  }

  getBit(key, offset) {
    const buffer = this.buffers.get(key);
    if (!buffer || offset >= buffer.length) return 0;
    return (buffer[offset >>> 3] >>> (offset & 7)) & 1;
  }
}

class MemoryBackend {
  constructor(maxEntries) {
    this.store = new MemoryStore(maxEntries);
    this.bits = new MemoryBits();
  }

  async get(key) {
    return this.store.get(key) ?? null;
  }

  async set(key, value, ttlSeconds) {
    this.store.set(key, value, ttlSeconds);
  }

  async del(key) {
    this.store.delete(key);
  }

  async incr(key) {
    return this.store.incr(key);
  }

  async setBit(key, offset) {
    this.bits.setBit(key, offset);
  }

  async getBits(key, offsets) {
    return offsets.map((offset) => this.bits.getBit(key, offset));
  }

  async quit() {}
}

let backend = new MemoryBackend(env.cache.memoryMaxEntries);
let mode = env.cache.redisUrl ? "starting" : "memory";
let keyPrefix = env.cache.keyPrefix;

const INVENTORY_VERSION_KEY = (city) => `v:inventory:${city}`;

function fullKey(key) {
  return `${keyPrefix}:${key}`;
}

/**
 * Report whether cross-instance invalidation is actually available.
 * Callers that cache per-shard answers must check this before trusting a hit.
 */
export function isSharedCache() {
  return mode === "redis";
}

export function cacheMode() {
  return mode;
}

/**
 * Connect Redis if configured, else stay on the in-memory backend.
 * A Redis URL that cannot be reached is a warning, not a startup failure: the
 * single-instance fallback is fully functional, and refusing to boot would take
 * a working deployment offline for a performance-only dependency.
 */
export async function initCache() {
  if (!env.cache.enabled) {
    mode = "off";
    log.warn("cache disabled by CACHE_ENABLED=false; all reads go to PostgreSQL");
    return mode;
  }
  if (!env.cache.redisUrl) {
    mode = "memory";
    log.warn(
      { maxEntries: env.cache.memoryMaxEntries },
      "REDIS_URL not set; using an in-memory cache. Correct for a single API " +
        "instance only — set REDIS_URL before scaling past one instance.",
    );
    return mode;
  }
  const redis = new RedisBackend(env.cache.redisUrl);
  try {
    await redis.connect();
    await redis.client.ping();
    backend = redis;
    mode = "redis";
    log.info({ url: redactUrl(env.cache.redisUrl) }, "redis cache connected");
  } catch (error) {
    await redis.quit().catch(() => {});
    log.warn(
      { err: error.message },
      "REDIS_URL is set but unreachable; continuing on the in-memory cache",
    );
    mode = "memory";
  }
  return mode;
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "redis://<unparseable>";
  }
}

export async function closeCache() {
  await backend.quit().catch(() => {});
}

/** Read-through get. Returns `null` on any miss, error, or disabled cache. */
export async function cacheGet(key) {
  if (mode === "off") return null;
  try {
    return await backend.get(fullKey(key));
  } catch (error) {
    log.debug({ err: error.message, key }, "cache get failed");
    return null;
  }
}

export async function cacheSet(key, value, ttlSeconds) {
  if (mode === "off") return;
  try {
    await backend.set(fullKey(key), value, ttlSeconds);
  } catch (error) {
    log.debug({ err: error.message, key }, "cache set failed");
  }
}

export async function cacheDelete(key) {
  if (mode === "off") return;
  try {
    await backend.del(fullKey(key));
  } catch (error) {
    log.debug({ err: error.message, key }, "cache delete failed");
  }
}

/**
 * Invalidate every cached read that depends on one city's inventory.
 *
 * Call this after any committed write that changes what a search or summary
 * would return — unit status, reservation lifecycle, donation intake. It bumps a
 * counter rather than deleting keys: deletes cannot reach keys written by other
 * instances, but the counter is read on every search, so a bump is visible to all
 * of them.
 */
export async function invalidateCityInventory(cityCode) {
  if (mode === "off") return;
  try {
    await backend.incr(fullKey(INVENTORY_VERSION_KEY(cityCode)));
  } catch (error) {
    log.warn({ err: error.message, city: cityCode }, "failed to bump inventory version");
  }
}

/** Current inventory version for each city, used to build cache keys. */
export async function inventoryVersions(cityCodes) {
  const versions = {};
  await Promise.all(
    cityCodes.map(async (cityCode) => {
      if (mode === "off") {
        versions[cityCode] = "nocache";
        return;
      }
      try {
        versions[cityCode] = (await backend.get(fullKey(INVENTORY_VERSION_KEY(cityCode)))) ?? "0";
      } catch {
        // A failed version read must not be treated as version 0: that could
        // collide with a real cached entry. Use a value no writer can produce.
        versions[cityCode] = `miss${Math.random().toString(36).slice(2, 10)}`;
      }
    }),
  );
  return versions;
}

/**
 * Combined version token for a set of cities. A multi-city search key changes
 * whenever *any* contributing city changes, which is exactly the invalidation
 * semantics a scatter-gather query needs.
 */
export function versionToken(versions, cityCodes) {
  return cityCodes.map((cityCode) => `${cityCode}${versions[cityCode] ?? "0"}`).join("_");
}

export { fullKey as cacheKey, RedisBackend, MemoryBackend };

/**
 * Direct access to the bit-addressed primitives, for the Bloom filter.
 * Callers must still handle rejections; the Bloom module does.
 */
export function backendForBits() {
  return backend;
}
