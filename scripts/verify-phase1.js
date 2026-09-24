import { CITY_CODES, schemasFor } from "../backend/src/db/shard-router.js";
import { pool } from "./db.js";

async function main() {
  const schemas = ["common", "catalog"];
  for (const cityCode of CITY_CODES) {
    const citySchemas = schemasFor(cityCode);
    schemas.push(citySchemas.hot, citySchemas.hist, citySchemas.read);
  }

  const objects = await pool.query(
    `SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY($1::text[])
       AND c.relkind IN ('r', 'p')
     ORDER BY n.nspname, c.relname`,
    [schemas],
  );
  process.stdout.write(`[phase1] schemas=${schemas.join(",")}\n`);
  process.stdout.write(`[phase1] tables=${objects.rowCount}\n`);
  for (const row of objects.rows) {
    process.stdout.write(`  ${row.schema_name}.${row.object_name}\n`);
  }

  for (const cityCode of CITY_CODES) {
    const { hot, hist } = schemasFor(cityCode);
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
    await pool.end();
  });