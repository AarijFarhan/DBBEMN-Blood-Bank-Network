import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefix = process.env.TEST_SCHEMA_PREFIX ?? "t_";

function run(script, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "scripts", script), ...args],
      {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${script} terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${script} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

const isolated = { SCHEMA_PREFIX: prefix };
const steps = [
  // Runs before anything touches the database: the cache and presence-index
  // invariants are pure logic, so a failure here is unambiguous and cheap.
  ["run-test.js", ["cache"], {}],
  // Step 0: drop the prefixed schemas AND their public.schema_migrations rows. The
  // registry table lives in `public`, so without this a previous run's rows outlive
  // the schemas they describe and migrate.js skips 001_city_schemas.sql.
  ["reset-test-schemas.js", [], isolated],
  ["migrate.js", [], isolated],
  ["seed.js", [], isolated],
  ["run-test.js", ["phase1"], isolated],
  ["run-test.js", ["phase2"], isolated],
  ["run-test.js", ["phase3"], isolated],
  ["verify-invariants.js", [], isolated],
  ["verify-phase1.js", [], isolated],
];

try {
  if (!/^(?:[a-z][a-z0-9_]{0,20})?$/.test(prefix)) {
    throw new Error(
      "TEST_SCHEMA_PREFIX must be empty or a short lowercase SQL-safe value.",
    );
  }
  for (const [script, args, env] of steps) {
    process.stdout.write(
      `[test:clean] running ${script}${args.length ? ` ${args.join(" ")}` : ""}\n`,
    );
    await run(script, args, env);
  }
  process.stdout.write(
    `[test:clean] completed with SCHEMA_PREFIX=${prefix || "(default)"}\n`,
  );
} catch (error) {
  process.stderr.write(`[test:clean] failed: ${error.message}\n`);
  process.exitCode = 1;
}
