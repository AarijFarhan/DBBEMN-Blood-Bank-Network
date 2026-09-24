import { randomInt } from "node:crypto";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

const CONNECTION_RETRY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "57P03",
  "08000",
  "08003",
  "08006",
]);

export async function connectWithRetry({ attempts = 5, baseDelayMs = 250 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await pool.connect();
    } catch (error) {
      lastError = error;
      if (!CONNECTION_RETRY_CODES.has(error.code) || attempt + 1 === attempts) break;
      const delay = baseDelayMs * 2 ** attempt + randomInt(0, Math.max(2, baseDelayMs));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export async function withClient(callback) {
  const client = await connectWithRetry();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function withSerializableRetry(callback, { attempts = 5, baseDelayMs = 12 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const client = await connectWithRetry();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      lastError = error;
      await client.query("ROLLBACK").catch(() => {});
      if (!["40001", "40P01"].includes(error.code) || attempt + 1 === attempts) throw error;
    } finally {
      client.release();
    }
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        baseDelayMs * 2 ** attempt + randomInt(0, Math.max(2, baseDelayMs)),
      ),
    );
  }
  throw lastError;
}

export async function waitForDatabase() {
  return withClient((client) => client.query("SELECT 1"));
}