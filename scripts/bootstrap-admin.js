import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { allScriptPools, connectWithRetryFor, endAllScriptPools } from "./db.js";

function promptLine(label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    let value = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes("\u0003")) {
        cleanup();
        reject(new Error("Cancelled."));
        return;
      }
      if (text.includes("\n") || text.includes("\r")) {
        cleanup();
        process.stdout.write("\n");
        resolve(value.trim());
      } else {
        value += text;
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    if (!process.stdin.isTTY) {
      reject(new Error("Run this command from an interactive terminal."));
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function promptPassword(label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    let value = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes("\u0003")) {
        cleanup();
        reject(new Error("Cancelled."));
        return;
      }
      if (text.includes("\n") || text.includes("\r")) {
        cleanup();
        process.stdout.write("\n");
        resolve(value);
      } else if (text === "\u007f" || text === "\b") {
        value = value.slice(0, -1);
      } else {
        value += text;
      }
    };
    const cleanup = () => {
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    if (!process.stdin.isTTY) {
      reject(new Error("Run this command from an interactive terminal."));
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function main() {
  const username = await promptLine("First system admin username: ");
  const email = await promptLine("First system admin email: ");
  const password = await promptPassword("Password (hidden, 12+ characters): ");
  if (!username || !email || password.length < 12) {
    throw new Error("Username, email, and a password of at least 12 characters are required.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  // System admins live in catalog.users, so this must target the catalog node in
  // distributed mode. In single mode the only entry is labelled "single".
  const nodes = allScriptPools();
  const target = nodes.find((node) => node.label === "catalog") ?? nodes[0];
  const client = await connectWithRetryFor(target.pool)();
  try {
    await client.query("BEGIN");
    // Why: serializes concurrent first-admin setup without a session advisory lock.
    await client.query("SELECT city_code FROM catalog.cities WHERE city_code = 'KHI' FOR UPDATE");
    const existing = await client.query(
      "SELECT 1 FROM catalog.users WHERE role = 'SYSTEM_ADMIN' LIMIT 1",
    );
    if (existing.rowCount > 0) {
      throw new Error("A SYSTEM_ADMIN already exists; use the authenticated admin API to add another.");
    }
    await client.query(
      `INSERT INTO catalog.users (user_id, username, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'SYSTEM_ADMIN')`,
      [randomUUID(), username, email, passwordHash],
    );
    await client.query("COMMIT");
    process.stdout.write(`Created the initial system administrator on node "${target.label}".\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[bootstrap-admin] ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await endAllScriptPools();
  });