import { CITY_CODES, schemaPrefix, schemasFor } from "../backend/src/db/shard-router.js";
import { allScriptPools, endAllScriptPools } from "./db.js";

/**
 * Drop the prefixed test schemas so `test-all` starts from a known-empty state.
 *
 * Why this exists: public.schema_migrations lives in `public`, not in the prefixed
 * schemas, so dropping t_khi_hot leaves its migration rows behind. migrate.js then
 * trusts those rows, skips 001_city_schemas.sql, and 002 dies on
 * `schema "t_khi_hot" does not exist`. migrate.js can now repair that on its own,
 * but wiping first is still the honest thing for a test run: a test suite should
 * never inherit half-migrated state from whatever ran before it.
 *
 * Safety: refuses to run without a prefix, and only ever names schemas built by
 * schemasFor(city, prefix). The unprefixed per-city schemas and the shared
 * common/catalog schemas are never touched, so real data is unreachable from here.
 */

const prefix = schemaPrefix();

if (prefix === "") {
  throw new Error(
    "Refusing to reset test schemas without a prefix: set TEST_SCHEMA_PREFIX (or SCHEMA_PREFIX) to something like t_ so real schemas cannot be dropped.",
  );
}

async function resetNode(pool, label, cityCodes) {
  const schemas = [];
  for (const cityCode of cityCodes) {
    const names = schemasFor(cityCode, prefix);
    schemas.push(names.hot, names.hist, names.read);
  }

  if (schemas.length > 0) {
    // Identifiers cannot be parameterized; they come from schemasFor(), which
    // allow-lists the city code and validates the prefix.
    await pool.query(`DROP SCHEMA IF EXISTS ${schemas.join(", ")} CASCADE;`);
  }

  // Only the shard rows are cleared. The catalog-folder rows describe common and
  // catalog, which are shared with the non-test database and are not being dropped.
  const removed = await pool.query(
    `DELETE FROM public.schema_migrations
     WHERE schema_prefix = $1 AND migration_key LIKE 'shard/%'
     RETURNING migration_key`,
    [prefix],
  );

  process.stdout.write(
    `[reset:${label}] dropped ${schemas.length} schema(s) and cleared ${removed.rowCount} migration row(s)\n`,
  );
}

// Hoisted so the `finally` block closes exactly the pools main() used, instead of
// building a second set and leaving the first one open so the process never exits.
let nodes = null;

async function main() {
  nodes = allScriptPools();
  const isDistributed = nodes.length > 1 || (nodes[0]?.label ?? "single") !== "single";

  for (const node of nodes) {
    if (!isDistributed) {
      await resetNode(node.pool, node.label, CITY_CODES);
      continue;
    }
    if (node.label === "catalog") {
      // The catalog node owns no city schemas, so there is nothing to drop; it can
      // still hold stray shard rows if a previous run mis-targeted it.
      await resetNode(node.pool, node.label, []);
      continue;
    }
    if (CITY_CODES.includes(node.label)) {
      await resetNode(node.pool, node.label, [node.label]);
    }
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[reset] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await endAllScriptPools(nodes ?? allScriptPools());
  });