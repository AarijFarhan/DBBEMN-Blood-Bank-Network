import path from "node:path";
import { spawn } from "node:child_process";
import { openSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Start N backend instances behind the proxy.
 *
 * Why this script instead of a `concurrently` one-liner: the shell form
 * `PORT=4001 node ...` is POSIX-only, and `concurrently` is not a dependency of
 * this workspace. Spawning with an explicit env object works the same on
 * Windows, macOS and Linux, and the ports are the ones nginx/nginx.conf
 * proxies to, so the two cannot drift apart silently.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const workerCount = Number(process.env.WORKER_COUNT ?? 3);
const basePort = Number(process.env.WORKER_BASE_PORT ?? 4001);
// Worker logs can get large during load testing, so they are written outside
// the repository by default. Set LOG_DIR to move them (e.g. to a data volume).
const logDir = path.resolve(process.env.LOG_DIR ?? root);

if (!Number.isInteger(workerCount) || workerCount < 1) {
  console.error("WORKER_COUNT must be a positive integer.");
  process.exit(1);
}
if (!Number.isInteger(basePort) || basePort < 1 || basePort + workerCount > 65535) {
  console.error("WORKER_BASE_PORT must leave room for WORKER_COUNT ports below 65536.");
  process.exit(1);
}
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const children = [];
let shuttingDown = false;

function stopAll(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (let index = 0; index < workerCount; index += 1) {
  const port = basePort + index;
  const instanceId = `worker-${index + 1}`;
  // Each worker keeps its own log file, the same way the previous
  // `pnpm start:workers` invocation did.
  const logStream = openSync(path.join(logDir, `worker${port}.log`), "a");

  const child = spawn(process.execPath, [path.join(root, "backend", "src", "index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      INSTANCE_ID: instanceId,
      ENABLE_GATEWAY: "false",
      GATEWAY_WORKER: "true",
    },
    stdio: ["ignore", logStream, logStream],
  });

  child.once("error", (error) => {
    console.error(`[workers] ${instanceId} failed to start: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[workers] ${instanceId} exited (code=${code} signal=${signal})`);
  });

  children.push(child);
  console.log(`[workers] ${instanceId} -> http://127.0.0.1:${port}`);
}

console.log(
  `[workers] ${workerCount} instances on ports ${basePort}-${basePort + workerCount - 1}. ` +
    "nginx/nginx.conf proxies to exactly these ports.",
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[workers] ${signal} received, stopping`);
    stopAll(signal);
    setTimeout(() => process.exit(0), 500).unref();
  });
}
