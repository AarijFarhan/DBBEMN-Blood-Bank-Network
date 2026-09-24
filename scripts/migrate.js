import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_CODES, schemaPrefix, schemasFor } from "../backend/src/db/shard-router.js";
import { connectWithRetry, pool } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsRoot = path.resolve(here, "../db/migrations");
const prefix = schemaPrefix();

function renderShardTemplate(source, cityCode) {
  const names = schemasFor(cityCode, prefix);
  const rendered = source
    .replaceAll("{{HOT}}", names.hot)
    .replaceAll("{{HIST}}", names.hist)
    .replaceAll("{{READ}}", names.read);

  if (/\{\{[^}]+\}\}/.test(rendered)) {
    throw new Error(`Unresolved migration template token for ${cityCode}.`);
  }
  return rendered;
}

async function applyMigration(key, source, cityCode = null) {
  const sql = cityCode ? renderShardTemplate(source, cityCode) : source;
  const client = await connectWithRetry();

  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT 1
       FROM public.schema_migrations
       WHERE schema_prefix = $1 AND migration_key = $2`,
      [prefix, key],
    );

    if (existing.rowCount > 0) {
      await client.query("COMMIT");
      process.stdout.write(`[migrate] skipped ${prefix || "(default)"} ${key}\n`);
      return;
    }

    await client.query(sql);
    await client.query(
      `INSERT INTO public.schema_migrations (schema_prefix, migration_key)
       VALUES ($1, $2)`,
      [prefix, key],
    );
    await client.query("COMMIT");
    process.stdout.write(`[migrate] applied ${prefix || "(default)"} ${key}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  // Why: include the prefix in the registry key so isolated test schemas can
  // coexist with the normal schemas in the same development database.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      schema_prefix TEXT NOT NULL,
      migration_key TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (schema_prefix, migration_key)
    )
  `);

  const catalogDir = path.join(migrationsRoot, "catalog");
  const catalogFiles = (await readdir(catalogDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of catalogFiles) {
    const source = await readFile(path.join(catalogDir, filename), "utf8");
    await applyMigration(`catalog/${filename}`, source);
  }

  const shardDir = path.join(migrationsRoot, "shard");
  const shardFiles = (await readdir(shardDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const cityCode of CITY_CODES) {
    for (const filename of shardFiles) {
      const source = await readFile(path.join(shardDir, filename), "utf8");
      await applyMigration(`shard/${cityCode}/${filename}`, source, cityCode);
    }
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[migrate] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });