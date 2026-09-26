import { CITY_CODES, schemasFor } from "../backend/src/db/shard-router.js";
import { catalogScriptPool, cityScriptPool, endAllScriptPools } from "./db.js";

/**
 * Report the tables each node owns and the seed counts on each city.
 *
 * Why per node instead of one listing: in distributed mode the catalog tables and
 * the city tables live in different databases, so a single pg_class query would
 * only ever see whichever node its pool pointed at. The node label is printed with
 * every group, which is also what makes a wrong DATABASE_URL visible here instead
 * of showing up later as missing data.
 */
async function listObjects(label, pool, schemas) {
  const objects = await pool.query(
    `SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[])
       AND c.relkind IN ('r', 'p')
     ORDER BY n.nspname, c.relname`,
    [schemas],
  );
  process.stdout.write(`[phase1] node=${label} schemas=${schemas.join(",")}\n`);
  process.stdout.write(`[phase1] node=${label} tables=${objects.rowCount}\n`);
  for (const row of objects.rows) {
    process.stdout.write(`  ${row.schema_name}.${row.object_name}\n`);
  }
}

async function main() {
  const catalogPool = catalogScriptPool();
  await listObjects("catalog", catalogPool, ["common", "catalog"]);

  for (const cityCode of CITY_CODES) {
    const { hot, hist, read } = schemasFor(cityCode);
    const pool = cityScriptPool(cityCode);
    await listObjects(cityCode, pool, ["common", hot, hist, read]);

    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM ${hist}.donors) AS donors,
         (SELECT count(*)::int FROM ${hist}.donations) AS donations,
         (SELECT count(*)::int FROM ${hot}.blood_units) AS units,
         (SELECT count(*)::int FROM ${hot}.reservations) AS reservations`,
    );
    process.stdout.write(`[phase1] ${cityCode} seed_counts=${JSON.stringify(counts.rows[0])}\n`);
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[phase1] verification failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await endAllScriptPools();
  });
