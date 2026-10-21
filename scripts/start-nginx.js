import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Start Nginx with this repository's configuration.
 *
 * Why a script instead of `pnpm nginx:start`: the repo config lives in
 * nginx/nginx.conf, while Nginx only ever reads the config inside its own
 * installation directory. This copies the repo config into place, validates it
 * with `nginx -t`, and only then starts the server - so a typo in the config
 * fails loudly instead of leaving Nginx running on the previous config.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "nginx", "nginx.conf");

const candidates = [
  process.env.NGINX_HOME,
  "C:\\nginx\\nginx-1.26.2",
  "C:\\nginx",
].filter(Boolean);

const home = candidates.find((candidate) => existsSync(path.join(candidate, "nginx.exe")));
if (!home) {
  console.error(
    "nginx.exe not found. Set NGINX_HOME to the Nginx installation directory " +
      "(the folder that contains nginx.exe).",
  );
  process.exit(1);
}

const executable = path.join(home, "nginx.exe");
const confDir = path.join(home, "conf");
const target = path.join(confDir, "nginx.conf");

// The repo config logs to /var/log/nginx, which is correct for the container
// image. On Windows an absolute path resolves against the drive root
// (C:\var\log\nginx) rather than the prefix, and that directory does not
// exist - so the local install gets the paths rewritten to a relative
// "logs/", which Nginx resolves against its prefix. The repository config
// itself is left untouched, because the container needs the absolute form.
const installed = readFileSync(source, "utf8").replaceAll("/var/log/nginx/", "logs/");
writeFileSync(target, installed);
console.log(`[nginx] installed config -> ${target}`);

// -p pins the prefix to the Nginx installation. Without it Nginx resolves
// relative paths (logs/, the pid file) against the current working directory,
// which is the repository - and then fails to find a logs directory there.
const args = ["-p", home, "-c", target];

const check = spawnSync(executable, ["-t", ...args], { encoding: "utf8" });
process.stdout.write(check.stdout ?? "");
process.stderr.write(check.stderr ?? "");
if (check.status !== 0) {
  console.error("[nginx] configuration is invalid; not starting.");
  process.exit(check.status ?? 1);
}

// Nginx on Windows runs in the foreground: the process does not return, and
// killing the launcher kills the server with it. So it is detached instead -
// its own process group, no inherited stdio, and the parent releases it with
// unref() so the launcher can exit and leave the server running.
const child = spawn(executable, args, {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
child.unref();

await new Promise((resolve) => setTimeout(resolve, 1500));
if (child.exitCode !== null) {
  console.error(`[nginx] exited immediately with code ${child.exitCode}.`);
  process.exit(child.exitCode ?? 1);
}

console.log(
  `[nginx] running. The backend workers must be listening on 4001-4003 ` +
    "(pnpm start:workers).",
);
