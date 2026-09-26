import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { integerOption, printSummary, request, required } from "./harness.js";

const baseUrl = process.env.LOADTEST_BASE_URL ?? "http://127.0.0.1:8080";
const token = required("LOADTEST_TOKEN");
const hospitalId = required("LOADTEST_HOSPITAL_ID");
const unitId = required("LOADTEST_UNIT_ID");
const city = (process.env.LOADTEST_CITY ?? "KHI").toUpperCase();
const requests = integerOption(
  process.env.LOADTEST_REQUESTS,
  "LOADTEST_REQUESTS",
  200,
  { min: 2, max: 5_000 },
);
const timeoutMs = integerOption(
  process.env.LOADTEST_TIMEOUT_MS,
  "LOADTEST_TIMEOUT_MS",
  30_000,
  { min: 100, max: 120_000 },
);
const confirm = process.env.LOADTEST_CONFIRM === "1";

if (!["KHI", "LHE", "ISB"].includes(city)) {
  throw new Error("LOADTEST_CITY must be KHI, LHE, or ISB.");
}
if (!confirm) {
  throw new Error(
    "Set LOADTEST_CONFIRM=1 before sending concurrent reservation writes.",
  );
}

const endpoint = new URL(
  `/api/v1/units/${encodeURIComponent(unitId)}/reserve?city=${city}`,
  baseUrl,
).href;
const started = performance.now();
const results = await Promise.all(
  Array.from({ length: requests }, async () => {
    try {
      return await request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        timeoutMs,
        body: {
          requestId: randomUUID(),
          hospitalId,
          patientBloodGroup: process.env.LOADTEST_PATIENT_GROUP ?? "AB",
          patientRh: process.env.LOADTEST_PATIENT_RH ?? "NEG",
          component: process.env.LOADTEST_COMPONENT ?? "PRBC",
          urgency: process.env.LOADTEST_URGENCY ?? "ROUTINE",
        },
      });
    } catch (error) {
      return { status: 0, error: error.code ?? error.message, durationMs: 0 };
    }
  }),
);
const elapsedMs = performance.now() - started;
const statusCodes = {};
for (const result of results) {
  const status = result.status ?? 0;
  statusCodes[status] = (statusCodes[status] ?? 0) + 1;
}
const summary = {
  target: endpoint,
  city,
  requests,
  elapsedMs: Math.round(elapsedMs),
  statusCodes,
  successes: statusCodes[200] ?? 0,
  conflicts: statusCodes[409] ?? 0,
  errors: results.filter((result) => !result.status).length,
  autocannonCompatible: true,
};
printSummary(summary);
