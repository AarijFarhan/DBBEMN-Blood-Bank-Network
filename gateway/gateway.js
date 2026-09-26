import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendEntry = path.join(root, "backend", "src", "index.js");

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

const publicPort = numberEnv("PORT", 8080, 1, 65535);
const workerCount = numberEnv("GATEWAY_WORKERS", 3, 1, 16);
const workerBasePort = numberEnv(
  "GATEWAY_WORKER_BASE_PORT",
  4001,
  1,
  65535 - workerCount,
);
const healthPath = process.env.GATEWAY_HEALTH_PATH ?? "/api/v1/health/live";
const healthIntervalMs = numberEnv(
  "GATEWAY_HEALTH_INTERVAL_MS",
  2000,
  250,
  60_000,
);
const healthTimeoutMs = numberEnv(
  "GATEWAY_HEALTH_TIMEOUT_MS",
  1000,
  100,
  30_000,
);
const requestTimeoutMs = numberEnv(
  "GATEWAY_REQUEST_TIMEOUT_MS",
  30_000,
  100,
  300_000,
);
const restartDelayMs = numberEnv("GATEWAY_RESTART_DELAY_MS", 2000, 250, 60_000);

if (!healthPath.startsWith("/")) {
  throw new Error("GATEWAY_HEALTH_PATH must start with /.");
}

let shuttingDown = false;
const workers = Array.from({ length: workerCount }, (_, index) => ({
  index,
  port: workerBasePort + index,
  instanceId: process.env.INSTANCE_ID
    ? `${process.env.INSTANCE_ID}-${index + 1}`
    : `gateway-worker-${index + 1}`,
  child: null,
  healthy: false,
  active: 0,
  restartTimer: null,
  lastError: null,
}));

function scheduleRestart(worker) {
  if (shuttingDown || worker.restartTimer) return;
  worker.restartTimer = setTimeout(() => {
    worker.restartTimer = null;
    launchWorker(worker);
  }, restartDelayMs);
}

function launchWorker(worker) {
  if (shuttingDown) return;
  const child = spawn(process.execPath, [backendEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(worker.port),
      INSTANCE_ID: worker.instanceId,
      ENABLE_GATEWAY: "false",
      GATEWAY_WORKER: "true",
    },
    stdio: "inherit",
  });
  worker.child = child;
  worker.healthy = false;
  worker.active = 0;
  worker.lastError = null;
  child.once("error", (error) => {
    worker.lastError = error.message;
  });
  child.once("exit", (code, signal) => {
    if (worker.child !== child) return;
    worker.child = null;
    worker.healthy = false;
    worker.lastError = signal ? `signal ${signal}` : `exit ${code}`;
    scheduleRestart(worker);
  });
}

function probeWorker(worker) {
  if (!worker.child || worker.child.exitCode !== null)
    return Promise.resolve(false);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (healthy) => {
      if (finished) return;
      finished = true;
      resolve(healthy);
    };
    const probeRequest = http.request(
      {
        hostname: "127.0.0.1",
        port: worker.port,
        path: healthPath,
        method: "GET",
        headers: { connection: "close" },
        timeout: healthTimeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          finish(response.statusCode >= 200 && response.statusCode < 400),
        );
      },
    );
    probeRequest.once("timeout", () => {
      probeRequest.destroy();
      finish(false);
    });
    probeRequest.once("error", () => finish(false));
    probeRequest.end();
  });
}

async function checkWorkers() {
  await Promise.all(
    workers.map(async (worker) => {
      worker.healthy = await probeWorker(worker);
    }),
  );
}

function chooseWorker() {
  const healthy = workers.filter((worker) => worker.healthy && worker.child);
  if (healthy.length === 0) return null;
  return healthy.reduce((best, worker) =>
    worker.active < best.active ? worker : best,
  );
}

function sendUnavailable(res) {
  if (res.headersSent) return;
  res.statusCode = 503;
  res.setHeader("content-type", "application/json");
  res.setHeader("x-upstream-instance", "none");
  res.end(
    JSON.stringify({
      error: {
        code: "NO_HEALTHY_WORKER",
        message: "No healthy gateway worker is available.",
        details: { simulation: "SIMULATED" },
      },
    }),
  );
}

function proxyRequest(req, res) {
  const worker = chooseWorker();
  if (!worker) {
    sendUnavailable(res);
    return;
  }
  worker.active += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    worker.active = Math.max(0, worker.active - 1);
  };
  const headers = { ...req.headers, host: `127.0.0.1:${worker.port}` };
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  headers["x-forwarded-proto"] = "http";
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: worker.port,
      path: req.url ?? "/",
      method: req.method,
      headers,
    },
    (upstreamResponse) => {
      res.statusCode = upstreamResponse.statusCode ?? 502;
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined) res.setHeader(name, value);
      }
      res.setHeader("x-upstream-instance", worker.instanceId);
      upstreamResponse.on("end", release);
      upstreamResponse.on("close", release);
      upstreamResponse.on("error", () => {
        release();
        res.destroy();
      });
      upstreamResponse.pipe(res);
    },
  );
  upstream.setTimeout(requestTimeoutMs, () => {
    upstream.destroy(new Error("gateway upstream timeout"));
  });
  upstream.once("error", (error) => {
    release();
    worker.lastError = error.message;
    worker.healthy = false;
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-upstream-instance", worker.instanceId);
      res.end(
        JSON.stringify({
          error: {
            code: "UPSTREAM_UNAVAILABLE",
            message: "The selected gateway worker is unavailable.",
            details: { simulation: "SIMULATED" },
          },
        }),
      );
    } else {
      res.destroy();
    }
  });
  req.once("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

for (const worker of workers) launchWorker(worker);

const server = http.createServer(proxyRequest);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.on("error", (error) => {
  process.stderr.write(`[gateway] server failed: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(publicPort, "0.0.0.0", () => {
  process.stdout.write(
    `[gateway] SIMULATED gateway listening on 0.0.0.0:${publicPort} with ${workerCount} workers\n`,
  );
});
void checkWorkers();
const healthTimer = setInterval(() => {
  void checkWorkers();
}, healthIntervalMs);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(healthTimer);
  process.stdout.write(`[gateway] stopping after ${signal}\n`);
  server.close();
  for (const worker of workers) {
    if (worker.restartTimer) clearTimeout(worker.restartTimer);
    if (worker.child && !worker.child.killed) worker.child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
