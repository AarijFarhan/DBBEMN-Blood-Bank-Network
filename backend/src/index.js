import { env } from "./config/env.js";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { allCityPools, describeTopology, getCatalogPool, waitForDatabases } from "./db/registry.js";
import { startBackgroundJobs } from "./jobs/maintenance.js";

const healthy = await waitForDatabases();
logger.info({ topology: describeTopology(), reachable: healthy }, "database topology ready");

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
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
