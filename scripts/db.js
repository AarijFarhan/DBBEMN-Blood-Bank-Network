import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Use the Replit-managed PostgreSQL database.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000,
});

export async function connectWithRetry({ attempts = 5, baseDelayMs = 250 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await pool.connect();
    } catch (error) {
      lastError = error;
      if (attempt + 1 === attempts) break;
      const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs));
      await new Promise((resolve) =>
        setTimeout(resolve, baseDelayMs * 2 ** attempt + jitter),
      );
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