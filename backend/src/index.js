import { env } from "./config/env.js";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { allCityPools, describeTopology, getCatalogPool, waitForDatabases } from "./db/registry.js";
import { startBackgroundJobs } from "./jobs/maintenance.js";
import { closeCache, initCache } from "./cache/store.js";
import { closeShared, initShared } from "./cache/shared.js";
import { initEventBus } from "./lib/bus.js";
import { PRESENCE_LOADERS, allPresenceFiltersTrusted, rebuildAllPresenceFilters } from "./services/presence.js";
import { describeSizing } from "./cache/bloom.js";

const healthy = await waitForDatabases();
logger.info({ topology: describeTopology(), reachable: healthy }, "database topology ready");

// Cache comes up after the databases and before serving traffic. A Redis failure
// here is logged and tolerated: the process falls back to its in-memory store
// rather than refusing to start.
const cacheMode = await initCache();
logger.info({ cacheMode, bloom: describeSizing() }, "cache ready");

// Shared state (circuit breakers, event fan-out) lives in Redis too, but it is
// optional in a way the cache is not: without it the breakers fall back to
// per-process state and the event feed stays local. Both are degraded, not
// broken, so a missing Redis must not stop the process from serving.
const sharedMode = await initShared();
const busMode = initEventBus();
logger.info({ sharedMode, busMode }, "shared state ready");

const backgroundJobsEnabled =
  String(process.env.BACKGROUND_JOBS_ENABLED ?? "true").toLowerCase() !== "false";
const stopBackgroundJobs = backgroundJobsEnabled ? startBackgroundJobs(logger) : () => {};
if (!backgroundJobsEnabled) {
  logger.info("background jobs disabled for this instance");
}
const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info({ port: env.port, instanceId: env.instanceId }, "DBBEMN API listening");
});

// Rebuild presence filters so cross-shard lookups can narrow on the first
// request. This runs after listen and is never fatal: a filter is only trusted
// once rebuilt, so requests served during the rebuild simply fall back to a
// full scan. Awaiting this before listen used to keep the API offline for
// minutes on a large dataset, which made every page and login look broken.
if (env.bloom.enabled && cacheMode !== "off") {
  void (async () => {
    if (await allPresenceFiltersTrusted(PRESENCE_LOADERS)) {
      logger.info("presence filters already trusted; skipping boot rebuild");
      return;
    }
    return rebuildAllPresenceFilters(PRESENCE_LOADERS);
  })()
    .then((rebuilt) => {
      if (!rebuilt) return;
      logger.info({ filters: rebuilt.length, inserted: rebuilt.reduce((sum, f) => sum + f.inserted, 0) }, "presence filters rebuilt");
    })
    .catch((error) => {
      logger.error({ err: error.message }, "presence filter rebuild failed; lookups will scan every city");
    });
}

async function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  stopBackgroundJobs();
  server.close(async () => {
    // Drain every node, not just one: in distributed mode a pool left open
    // would keep its container's connections alive after the API is gone.
    const closers = [getCatalogPool(), ...allCityPools().map((entry) => entry.pool)];
    await Promise.allSettled([...new Set(closers)].map((pool) => pool.end()));
    await closeCache();
    await closeShared();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
