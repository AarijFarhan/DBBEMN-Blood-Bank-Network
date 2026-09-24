import { env } from "./config/env.js";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { pool, waitForDatabase } from "./db/pool.js";

await waitForDatabase();
const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info({ port: env.port, instanceId: env.instanceId }, "DBBEMN API listening");
});

async function shutdown(signal) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));