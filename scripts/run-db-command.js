import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = process.argv[2];
const prefix = process.argv[3] ?? process.env.SCHEMA_PREFIX ?? "";
const allowed = new Set([
  "migrate.js",
  "seed.js",
  "verify-invariants.js",
  "verify-phase1.js",
]);

if (!allowed.has(script)) {
  throw new Error(
    "Usage: node scripts/run-db-command.js <migrate.js|seed.js|verify-invariants.js|verify-phase1.js> [prefix]",
  );
}
if (!/^(?:[a-z][a-z0-9_]{0,20})?$/.test(prefix)) {
  throw new Error(
    "The schema prefix must be empty or a short lowercase SQL-safe value.",
  );
}

const child = spawn(process.execPath, [path.join(root, "scripts", script)], {
  cwd: root,
  env: { ...process.env, SCHEMA_PREFIX: prefix },
  stdio: "inherit",
});

child.once("error", (error) => {
  process.stderr.write(
    `[db-command] failed to start ${script}: ${error.message}\n`,
  );
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
