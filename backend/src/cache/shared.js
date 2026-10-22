/**
 * State that must be shared between API instances, backed by Redis.
 *
 * The cache substrate (store.js) answers "what did we compute?" - it is a
 * read-through cache with per-city version counters. This module answers a
 * different question: "what is every instance doing right now?" - which is
 * what a circuit breaker and a live event feed need.
 *
 * Both of those used to be per-process:
 *
 *  - the search circuit breakers lived in a Map, so a shard that was failing
 *    for one instance was still being hammered by the other two, and each
 *    instance reported a different view of the network;
 *  - the event bus was an in-process EventEmitter, so an event published by
 *    one instance never reached a dashboard connected to another.
 *
 * Redis is what makes them shared: a hash for the breaker state, and Pub/Sub
 * for the event fan-out.
 *
 * Every operation is best-effort and never throws. A Redis outage must not
 * take the API down - it must only make these two features fall back to their
 * per-process behaviour, which is what they did before.
 */
import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ module: "shared" });

let client = null;
let subscriber = null;
let ready = false;

function namespaced(name) {
  return `${env.cache.keyPrefix}:shared:${name}`;
}

/**
 * Connect the shared-state client and its dedicated subscriber connection.
 *
 * Two connections, not one: a Redis connection in subscribe mode cannot run
 * ordinary commands, so the Pub/Sub half needs its own socket.
 */
export async function initShared() {
  const url = env.cache.redisUrl;
  if (!url) return false;
  if (ready) return true;

  const options = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 3000)),
  };

  try {
    client = new Redis(url, options);
    client.on("error", (error) => {
      log.warn({ err: error.message }, "shared redis unavailable; state stays per-process");
    });
    await client.connect();

    subscriber = client.duplicate();
    subscriber.on("error", (error) => {
      log.warn({ err: error.message }, "shared subscriber unavailable; events stay local");
    });
    await subscriber.connect();

    ready = true;
    log.info({ url }, "shared state connected");
    return true;
  } catch (error) {
    log.warn({ err: error.message }, "shared state unavailable; continuing without it");
    ready = false;
    return false;
  }
}

/** Whether shared state is actually available. Callers fall back when false. */
export function isSharedReady() {
  return ready;
}

export async function sharedGet(name) {
  if (!ready) return null;
  try {
    return await client.get(namespaced(name));
  } catch (error) {
    log.debug({ err: error.message, name }, "shared get failed");
    return null;
  }
}

export async function sharedSet(name, value, ttlSeconds = 0) {
  if (!ready) return false;
  try {
    if (ttlSeconds > 0) await client.set(namespaced(name), value, "EX", Math.ceil(ttlSeconds));
    else await client.set(namespaced(name), value);
    return true;
  } catch (error) {
    log.debug({ err: error.name, err: error.message, name }, "shared set failed");
    return false;
  }
}

export async function sharedDelete(name) {
  if (!ready) return false;
  try {
    await client.del(namespaced(name));
    return true;
  } catch (error) {
    log.debug({ err: error.message, name }, "shared delete failed");
    return false;
  }
}

/** Increment a counter. Returns the new value, or null when unavailable. */
export async function sharedIncrement(name) {
  if (!ready) return null;
  try {
    return await client.incr(namespaced(name));
  } catch (error) {
    log.debug({ err: error.message, name }, "shared increment failed");
    return null;
  }
}

/** Read a whole hash. Returns an empty object when unavailable. */
export async function sharedHashGetAll(name) {
  if (!ready) return {};
  try {
    return await client.hgetall(namespaced(name));
  } catch (error) {
    log.debug({ err: error.message, name }, "shared hash read failed");
    return {};
  }
}

/** Increment one field of a hash. Atomic, so concurrent failures cannot be lost. */
export async function sharedHashIncrement(name, field, delta) {
  if (!ready) return null;
  try {
    return await client.hincrby(namespaced(name), field, delta);
  } catch (error) {
    log.debug({ err: error.message, name }, "shared hash increment failed");
    return null;
  }
}

export async function sharedHashSet(name, field, value) {
  if (!ready) return false;
  try {
    await client.hset(namespaced(name), field, String(value));
    return true;
  } catch (error) {
    log.debug({ err: error.message, name }, "shared hash write failed");
    return false;
  }
}

export async function sharedExpire(name, ttlSeconds) {
  if (!ready) return false;
  try {
    await client.expire(namespaced(name), Math.ceil(ttlSeconds));
    return true;
  } catch (error) {
    log.debug({ err: error.message, name }, "shared expire failed");
    return false;
  }
}

/** Publish a payload to a channel. Fire and forget: a failed publish is a lost event, not an error. */
export async function sharedPublish(channel, payload) {
  if (!ready) return false;
  try {
    await client.publish(namespaced(channel), JSON.stringify(payload));
    return true;
  } catch (error) {
    log.debug({ err: error.message, channel }, "shared publish failed");
    return false;
  }
}

/**
 * Subscribe to a channel.
 *
 * The handler receives already-parsed payloads. A message that cannot be
 * parsed is dropped rather than thrown: one bad message must not kill the
 * subscription for everything that follows.
 */
export function sharedSubscribe(channel, handler) {
  if (!ready || !subscriber) return false;
  const name = namespaced(channel);
  subscriber.on("message", (incoming, raw) => {
    if (incoming !== name) return;
    try {
      handler(JSON.parse(raw));
    } catch (error) {
      log.debug({ err: error.message, channel }, "ignoring an unparseable shared message");
    }
  });
  subscriber.subscribe(name, (error) => {
    if (error) log.warn({ err: error.message, channel }, "shared subscribe failed");
  });
  return true;
}

export async function closeShared() {
  if (subscriber) await subscriber.quit().catch(() => {});
  if (client) await client.quit().catch(() => {});
  subscriber = null;
  client = null;
  ready = false;
}
