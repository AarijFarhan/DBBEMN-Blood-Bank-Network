import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_CODES, schemaPrefix, schemasFor } from "../backend/src/db/shard-router.js";
import { allScriptPools, connectWithRetryFor, endAllScriptPools } from "./db.js";

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

const CATALOG_SCHEMA_MARKER = "CREATE SCHEMA IF NOT EXISTS catalog;";

/**
 * Collect the database objects a migration is responsible for creating.
 *
 * Why: public.schema_migrations records that a file was applied, but nothing stops
 * a prefixed test schema set (t_khi_hot and friends) or a plain `DROP SCHEMA` from
 * removing the result afterwards. The registry then claims 001 already ran while
 * the schemas it creates are gone, so it gets skipped and the next migration dies
 * with `schema "t_khi_hot" does not exist`. Even with the schema preflight below,
 * an empty schema is not proof of a correct database: the preflight recreates the
 * three schemas, and skipping 001 on that alone would leave t_khi_history.donors
 * missing for the FK in 002. So the drift check looks at the TABLES and FUNCTIONS
 * too, not just schema names. Parsing each file's own DDL keeps this honest instead
 * of hard-coding a list that a new shard migration would immediately outgrow.
 */
function ownedObjects(sql) {
  const schemas = new Set();
  const tables = new Set();
  const functions = new Set();
  const identifier = '("?[A-Za-z_][A-Za-z0-9_$]*"?)';
  const bare = (text) => text.replaceAll('"', "");
  const patterns = [
    {
      target: schemas,
      regex: new RegExp(`CREATE\\s+SCHEMA\\s+IF\\s+NOT\\s+EXISTS\\s+${identifier}`, "gi"),
      name: (match) => bare(match[1]),
    },
    {
      target: tables,
      regex: new RegExp(
        `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${identifier}\\s*\\.\\s*${identifier}`,
        "gi",
      ),
      name: (match) => `${bare(match[1])}.${bare(match[2])}`,
    },
    {
      target: functions,
      regex: new RegExp(
        `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${identifier}\\s*\\.\\s*${identifier}`,
        "gi",
      ),
      name: (match) => `${bare(match[1])}.${bare(match[2])}`,
    },
  ];

  for (const { target, regex, name } of patterns) {
    let match = regex.exec(sql);
    while (match !== null) {
      target.add(name(match));
      match = regex.exec(sql);
    }
  }
  return { schemas: [...schemas], tables: [...tables], functions: [...functions] };
}

async function missingObjects(client, owned) {
  const missing = [];
  const { schemas, tables, functions } = owned;

  if (schemas.length > 0) {
    const found = await client.query(
      "SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])",
      [schemas],
    );
    const present = new Set(found.rows.map((row) => row.nspname));
    missing.push(...schemas.filter((name) => !present.has(name)));
  }

  if (tables.length > 0) {
    const found = await client.query(
      `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname || '.' || c.relname = ANY($1::text[])`,
      [tables],
    );
    const present = new Set(found.rows.map((row) => row.name));
    missing.push(...tables.filter((name) => !present.has(name)));
  }

  if (functions.length > 0) {
    const found = await client.query(
      `SELECT n.nspname || '.' || p.proname AS name
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname || '.' || p.proname = ANY($1::text[])`,
      [functions],
    );
    const present = new Set(found.rows.map((row) => row.name));
    missing.push(...functions.filter((name) => !present.has(name)));
  }

  return missing;
}

/**
 * Create every schema this node owns before any table or view migration runs.
 *
 * Why explicit and first: the table migrations declare columns as common.blood_group_t
 * and FKs into {{HIST}}.donors, so a missing schema surfaces as a confusing mid-file
 * error instead of an obvious "schema absent" one. Ownership is enforced here rather
 * than by running everything everywhere: a city node must never gain a `catalog`
 * schema, because catalog.users living next to city data is the split-brain this
 * topology exists to prevent.
 *
 * Identifiers are interpolated, not parameterized, so they come from schemasFor(),
 * which allow-lists the city code and validates the prefix.
 */
async function ensureSchemas(pool, label, { catalog, cityCodes }) {
  const statements = ["CREATE SCHEMA IF NOT EXISTS common;"];
  if (catalog) {
    statements.push("CREATE SCHEMA IF NOT EXISTS catalog;");
  }
  const created = [];
  for (const cityCode of cityCodes) {
    const names = schemasFor(cityCode, prefix);
    for (const name of [names.hot, names.hist, names.read]) {
      statements.push(`CREATE SCHEMA IF NOT EXISTS ${name};`);
      created.push(name);
    }
  }
  await pool.query(statements.join("\n"));
  process.stdout.write(
    `[migrate:${label}] schemas ensured (common${catalog ? " + catalog" : ""}` +
      `${created.length > 0 ? ` + ${created.join(", ")}` : ""})\n`,
  );
}

/**
 * Decide which nodes a catalog-folder migration applies to, by looking at which
 * schemas it actually references.
 *
 * Why not by folder: db/migrations/catalog/002_donor_requests.sql sits in the
 * catalog folder but only creates common.donor_request_status_t, which every
 * city node needs because donor_requests.status is typed with it. Folder-based
 * routing applied that enum to the catalog node alone, and then shard/002 failed
 * on each city node with "type common.donor_request_status_t does not exist".
 */
function classify(sql) {
  const touchesCommon = /\bcommon\./.test(sql);
  const touchesCatalog = /\bcatalog\./.test(sql);
  if (touchesCommon && touchesCatalog) return "mixed";
  if (touchesCommon) return "common";
  if (touchesCatalog) return "catalog";
  return "none";
}

/**
 * Split a "mixed" migration into its common half and its catalog half.
 * The common half (enums + compatible_donor) must exist on EVERY node, because
 * city tables declare columns as common.blood_group_t and query
 * common.compatible_donor(). The catalog half must exist ONLY on the catalog
 * node: applying it to a city node would silently give it a copy of
 * catalog.users, which is the split-brain this design exists to prevent.
 */
function splitCommonCatalog(source, filename) {
  const index = source.indexOf(CATALOG_SCHEMA_MARKER);
  if (index === -1) {
    throw new Error(`Could not find "${CATALOG_SCHEMA_MARKER}" in ${filename}.`);
  }
  return { commonOnly: source.slice(0, index), catalogOnly: source.slice(index) };
}

async function applyMigration(pool, label, key, source, cityCode = null) {
  const sql = cityCode ? renderShardTemplate(source, cityCode) : source;
  const owned = ownedObjects(sql);
  const client = await connectWithRetryFor(pool)();

  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT 1
       FROM public.schema_migrations
       WHERE schema_prefix = $1 AND migration_key = $2`,
      [prefix, key],
    );

    if (existing.rowCount > 0) {
      const missing = await missingObjects(client, owned);
      if (missing.length === 0) {
        await client.query("COMMIT");
        process.stdout.write(`[migrate:${label}] skipped ${prefix || "(default)"} ${key}\n`);
        return;
      }
      // The registry says this ran, but the objects it owns are gone, so the record
      // is stale. Drop it inside this same transaction: if the re-apply then fails
      // the ROLLBACK puts the old row back, and the next run retries instead of
      // being permanently wedged by a skip.
      await client.query(
        "DELETE FROM public.schema_migrations WHERE schema_prefix = $1 AND migration_key = $2",
        [prefix, key],
      );
      process.stdout.write(
        `[migrate:${label}] repairing ${prefix || "(default)"} ${key} :: missing ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` (+${missing.length - 6} more)` : ""}\n`,
      );
    }

    await client.query(sql);
    await client.query(
      `INSERT INTO public.schema_migrations (schema_prefix, migration_key)
       VALUES ($1, $2)`,
      [prefix, key],
    );
    await client.query("COMMIT");
    process.stdout.write(`[migrate:${label}] applied ${prefix || "(default)"} ${key}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function ensureMigrationTable(pool, label) {
  // Why: include the prefix in the registry key so isolated test schemas can
  // coexist with the normal schemas on the same node.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      schema_prefix TEXT NOT NULL,
      migration_key TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (schema_prefix, migration_key)
    )
  `);
  process.stdout.write(`[migrate:${label}] migration registry ready\n`);
}

// Hoisted so the `finally` block can close exactly the pools main() used.
let nodes = null;

async function main() {
  nodes = allScriptPools();
  const isDistributed = nodes.length > 1 || (nodes[0]?.label ?? "single") !== "single";

  const catalogDir = path.join(migrationsRoot, "catalog");
  const catalogFiles = (await readdir(catalogDir)).filter((name) => name.endsWith(".sql")).sort();
  const shardDir = path.join(migrationsRoot, "shard");
  const shardFiles = (await readdir(shardDir)).filter((name) => name.endsWith(".sql")).sort();

  // Bucket the catalog-folder migrations by what they touch, not by where they live.
  const catalogPlan = [];
  for (const filename of catalogFiles) {
    const source = await readFile(path.join(catalogDir, filename), "utf8");
    const kind = classify(source);
    if (kind === "mixed") {
      const { commonOnly } = splitCommonCatalog(source, filename);
      catalogPlan.push({ filename, apply: "mixed", whole: source, commonOnly });
    } else if (kind === "common") {
      catalogPlan.push({ filename, apply: "common", whole: source, commonOnly: source });
    } else if (kind === "catalog") {
      catalogPlan.push({ filename, apply: "catalog", whole: source, commonOnly: null });
    } else {
      process.stdout.write(`[migrate] skipping ${filename} (references neither common. nor catalog.)\n`);
    }
  }

  for (const node of nodes) {
    await ensureMigrationTable(node.pool, node.label);
  }

  if (!isDistributed) {
    const [only] = nodes;
    // One box owns everything, so it is the catalog node and all three cities.
    await ensureSchemas(only.pool, only.label, { catalog: true, cityCodes: CITY_CODES });
    for (const entry of catalogPlan) {
      await applyMigration(only.pool, only.label, `catalog/${entry.filename}`, entry.whole);
    }
    for (const cityCode of CITY_CODES) {
      for (const filename of shardFiles) {
        const source = await readFile(path.join(shardDir, filename), "utf8");
        await applyMigration(only.pool, only.label, `shard/${cityCode}/${filename}`, source, cityCode);
      }
    }
    return;
  }

  const catalogNode = nodes.find((node) => node.label === "catalog");
  const cityNodes = nodes.filter((node) => CITY_CODES.includes(node.label));

  if (!catalogNode) {
    throw new Error("Distributed mode requires CATALOG_DATABASE_URL so catalog migrations have a target.");
  }
  const missingCities = CITY_CODES.filter((code) => !cityNodes.some((node) => node.label === code));
  if (missingCities.length > 0) {
    throw new Error(`Distributed mode is missing node URLs for: ${missingCities.join(", ")}.`);
  }

  // Catalog node owns common + catalog; a city node owns common + its own shard trio.
  await ensureSchemas(catalogNode.pool, catalogNode.label, { catalog: true, cityCodes: [] });
  for (const node of cityNodes) {
    await ensureSchemas(node.pool, node.label, { catalog: false, cityCodes: [node.label] });
  }

  // 1. Catalog-folder migrations, routed per file.
  for (const entry of catalogPlan) {
    const key = `catalog/${entry.filename}`;
    if (entry.apply === "catalog") {
      await applyMigration(catalogNode.pool, catalogNode.label, key, entry.whole);
      continue;
    }
    // "common" and "mixed" both need their common half on every city node.
    for (const node of cityNodes) {
      await applyMigration(node.pool, node.label, key, entry.apply === "mixed" ? entry.commonOnly : entry.whole);
    }
    // The catalog node gets the whole file, so one key covers both halves there.
    await applyMigration(catalogNode.pool, catalogNode.label, key, entry.whole);
  }

  // 2. shard migrations on that city's own node.
  for (const node of cityNodes) {
    for (const filename of shardFiles) {
      const source = await readFile(path.join(shardDir, filename), "utf8");
      await applyMigration(node.pool, node.label, `shard/${node.label}/${filename}`, source, node.label);
    }
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[migrate] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Reuse the cached entries: calling allScriptPools() again used to build a
    // second set of pools and leave the first set open, so the process never exited.
    await endAllScriptPools(nodes ?? allScriptPools());
  });
