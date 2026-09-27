import { env } from "./config/env.js";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { allCityPools, describeTopology, getCatalogPool, waitForDatabases } from "./db/registry.js";
import { startBackgroundJobs } from "./jobs/maintenance.js";
import { closeCache, initCache } from "./cache/store.js";
import { PRESENCE_LOADERS, rebuildAllPresenceFilters } from "./services/presence.js";
import { describeSizing } from "./cache/bloom.js";

const healthy = await waitForDatabases();
logger.info({ topology: describeTopology(), reachable: healthy }, "database topology ready");

// Cache comes up after the databases and before serving traffic. A Redis failure
// here is logged and tolerated: the process falls back to its in-memory store
// rather than refusing to start.
const cacheMode = await initCache();
logger.info({ cacheMode, bloom: describeSizing() }, "cache ready");

// Rebuild presence filters at boot so cross-shard lookups can narrow on the first
// request. Best-effort and never fatal — an unbuilt filter is a full scan, which
// is the behaviour from before this optimisation existed.
if (env.bloom.enabled && cacheMode !== "off") {
  try {
    const rebuilt = await rebuildAllPresenceFilters(PRESENCE_LOADERS);
    logger.info({ filters: rebuilt.length, inserted: rebuilt.reduce((sum, f) => sum + f.inserted, 0) }, "presence filters rebuilt");
  } catch (error) {
    logger.error({ err: error.message }, "presence filter rebuild failed; lookups will scan every city");
  }
}

const stopBackgroundJobs = startBackgroundJobs(logger);
const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info({ port: env.port, instanceId: env.instanceId }, "DBBEMN API listening");
});

async function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  stopBackgroundJobs();
  server.close(async () => {
    // Drain every node, not just one: in distributed mode a pool left open
    // would keep its container's connections alive after the API is gone.
    const closers = [getCatalogPool(), ...allCityPools().map((entry) => entry.pool)];
    await Promise.allSettled([...new Set(closers)].map((pool) => pool.end()));
    await closeCache();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
