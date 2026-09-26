import { randomUUID } from "node:crypto";
import {
  enforceThresholds,
  integerOption,
  positiveNumber,
  printSummary,
  request,
  required,
  runLoad,
} from "./harness.js";

const baseUrl = process.env.LOADTEST_BASE_URL ?? "http://127.0.0.1:8080";
const searchPath =
  process.env.LOADTEST_SEARCH_PATH ??
  "/api/v1/search/units?component=PRBC&compatibleWith=O%2B&limit=25";
const reservePath = process.env.LOADTEST_RESERVE_PATH ?? "/api/v1/reservations";
const token = required("LOADTEST_TOKEN");
const hospitalId = required("LOADTEST_HOSPITAL_ID");
const durationSeconds = positiveNumber(
  process.env.LOADTEST_DURATION_SECONDS ?? 30,
  "LOADTEST_DURATION_SECONDS",
  { min: 1, max: 86_400 },
);
const connections = integerOption(
  process.env.LOADTEST_CONNECTIONS,
  "LOADTEST_CONNECTIONS",
  100,
  { min: 1, max: 2_000 },
);
const timeoutMs = integerOption(
  process.env.LOADTEST_TIMEOUT_MS,
  "LOADTEST_TIMEOUT_MS",
  10_000,
  { min: 100, max: 120_000 },
);
const searchRatio = positiveNumber(
  process.env.LOADTEST_SEARCH_RATIO ?? 0.7,
  "LOADTEST_SEARCH_RATIO",
  { min: 0, max: 1 },
);
const reserveRatio = 1 - searchRatio;
const confirm = process.env.LOADTEST_CONFIRM === "1";
const enforce = process.env.LOADTEST_ENFORCE_THRESHOLDS === "1";
const maxErrorRate = positiveNumber(
  process.env.LOADTEST_MAX_ERROR_RATE ?? 0.01,
  "LOADTEST_MAX_ERROR_RATE",
  { min: 0, max: 1 },
);
const maxP95Ms = positiveNumber(
  process.env.LOADTEST_MAX_P95_MS ?? 800,
  "LOADTEST_MAX_P95_MS",
  { min: 1, max: 120_000 },
);
const headers = { authorization: `Bearer ${token}` };

if (!confirm) {
  throw new Error(
    "Set LOADTEST_CONFIRM=1 after reviewing the reservation write ratio and target environment.",
  );
}

const summary = await runLoad({
  connections,
  durationSeconds,
  timeoutMs,
  requestFactory: async () => {
    const isSearch = Math.random() < searchRatio;
    const url = new URL(isSearch ? searchPath : reservePath, baseUrl).href;
    if (isSearch) return request(url, { headers, timeoutMs });
    return request(url, {
      method: "POST",
      headers,
      timeoutMs,
      body: {
        requestId: randomUUID(),
        hospitalId,
        patientBloodGroup: process.env.LOADTEST_PATIENT_GROUP ?? "O",
        patientRh: process.env.LOADTEST_PATIENT_RH ?? "NEG",
        component: process.env.LOADTEST_COMPONENT ?? "PRBC",
        unitsNeeded: integerOption(
          process.env.LOADTEST_UNITS_NEEDED,
          "LOADTEST_UNITS_NEEDED",
          1,
          { min: 1, max: 10 },
        ),
        urgency: process.env.LOADTEST_URGENCY ?? "ROUTINE",
        allowPartial: false,
        searchScope: process.env.LOADTEST_SEARCH_SCOPE ?? "LOCAL_FIRST",
      },
    });
  },
});

summary.target = baseUrl;
summary.mix = { search: searchRatio, reserve: reserveRatio };
summary.thresholds = { maxErrorRate, maxP95Ms, enforced: enforce };
printSummary(summary);
const failure = enforce
  ? enforceThresholds(summary, { maxErrorRate, maxP95Ms })
  : null;
if (failure) {
  process.stderr.write(`[loadtest:mixed] threshold failure: ${failure}\n`);
  process.exitCode = 1;
}
