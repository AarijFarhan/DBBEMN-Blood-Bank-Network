import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

export function positiveNumber(
  value,
  name,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }
  return number;
}

export function integerOption(
  value,
  name,
  fallback,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {},
) {
  const raw = value ?? fallback;
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function request(
  url,
  { method = "GET", headers = {}, body, timeoutMs = 10_000 } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const payload =
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    const requestHeaders = {
      accept: "application/json",
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    };
    const started = performance.now();
    let settled = false;
    const clientRequest = transport.request(
      target,
      {
        method,
        headers: requestHeaders,
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          if (length < 2_000_000) {
            chunks.push(chunk);
            length += chunk.length;
          }
        });
        response.on("end", () => {
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            durationMs: performance.now() - started,
          });
        });
        response.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      },
    );
    clientRequest.setTimeout(timeoutMs, () => {
      clientRequest.destroy(
        Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" }),
      );
    });
    clientRequest.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    if (payload !== undefined) clientRequest.write(payload);
    clientRequest.end();
  });
}

function percentile(values, value) {
  if (values.length === 0) return 0;
  const index = Math.min(
    values.length - 1,
    Math.max(0, Math.ceil(values.length * value) - 1),
  );
  return values[index];
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function runLoad({
  requestFactory,
  connections,
  durationSeconds,
  timeoutMs,
}) {
  const started = performance.now();
  const deadline = started + durationSeconds * 1000;
  const state = {
    requests: 0,
    successful: 0,
    non2xx: 0,
    errors: 0,
    timeouts: 0,
    latencies: [],
    statusCodes: {},
  };
  let workerId = 0;
  const record = (result) => {
    state.requests += 1;
    const status = result?.status ?? 0;
    state.statusCodes[status] = (state.statusCodes[status] ?? 0) + 1;
    if (typeof result?.durationMs === "number")
      state.latencies.push(result.durationMs);
    if (result && status >= 200 && status < 300) {
      state.successful += 1;
    } else if (result) {
      state.non2xx += 1;
    }
  };
  const worker = async () => {
    const id = workerId;
    workerId += 1;
    while (performance.now() < deadline) {
      try {
        record(await requestFactory(id));
      } catch (error) {
        state.requests += 1;
        state.errors += 1;
        if (error.code === "ETIMEDOUT" || error.message === "request timeout")
          state.timeouts += 1;
        state.statusCodes[0] = (state.statusCodes[0] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: connections }, () => worker()));
  const elapsedSeconds = Math.max((performance.now() - started) / 1000, 0.001);
  const sorted = [...state.latencies].sort((left, right) => left - right);
  const total = state.requests || 1;
  return {
    durationSeconds: round(elapsedSeconds),
    requests: state.requests,
    successful: state.successful,
    non2xx: state.non2xx,
    errors: state.errors,
    timeouts: state.timeouts,
    errorRate: round((state.errors + state.non2xx) / total, 6),
    requestsPerSecond: round(state.requests / elapsedSeconds),
    latencyMs: {
      average: round(
        sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1),
      ),
      min: round(sorted[0] ?? 0),
      p50: round(percentile(sorted, 0.5)),
      p95: round(percentile(sorted, 0.95)),
      p99: round(percentile(sorted, 0.99)),
      max: round(sorted.at(-1) ?? 0),
    },
    statusCodes: state.statusCodes,
    autocannonCompatible: true,
  };
}

export function enforceThresholds(summary, { maxErrorRate, maxP95Ms }) {
  if (summary.errorRate > maxErrorRate) {
    return `error rate ${summary.errorRate} exceeds ${maxErrorRate}`;
  }
  if (summary.latencyMs.p95 > maxP95Ms) {
    return `p95 ${summary.latencyMs.p95}ms exceeds ${maxP95Ms}ms`;
  }
  return null;
}

export function printSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

export function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
