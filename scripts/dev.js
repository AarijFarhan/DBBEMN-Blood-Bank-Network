import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "backend", "src", "index.js");
const child = spawn(process.execPath, ["--watch", backend], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "development" },
  stdio: "inherit",
});

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("error", (error) => {
  process.stderr.write(`[dev] failed to start backend: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
