import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const phase = process.argv[2] ?? "phase1";
const defaults = Object.freeze({
  phase1: "",
  phase2: "t_",
  phase3: "p3_",
});
const testFiles = Object.freeze({
  // Cache/presence invariants are pure logic with no database, so they run first
  // and fail fast. Keeping them in their own phase also means they can be run on
  // their own without migrating or seeding anything.
  cache: ["cache.test.js"],
  phase1: ["phase1.test.js"],
  phase2: ["phase2.test.js"],
  phase3: ["phase3.test.js"],
});

if (!testFiles[phase]) {
  throw new Error("Usage: node scripts/run-test.js <cache|phase1|phase2|phase3>");
}

const prefix = process.env.SCHEMA_PREFIX ?? defaults[phase];
const child = spawn(
  process.execPath,
  ["--test", ...testFiles[phase].map((name) => path.join(root, "backend", "tests", name))],
  {
    cwd: root,
    env: { ...process.env, SCHEMA_PREFIX: prefix },
    stdio: "inherit",
  },
);

child.once("error", (error) => {
  process.stderr.write(`[test:${phase}] failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
