import { CITY_CODES, schemasFor } from "../backend/src/db/shard-router.js";
import { cityScriptPool, endAllScriptPools } from "./db.js";

async function count(client, sql) {
  const result = await client.query(sql);
  return Number(result.rows[0].violations);
}

async function verifyCity(cityCode) {
  const { hot, hist } = schemasFor(cityCode);
  // Each city is checked on its own node. Reading all three from one pool would
  // verify whichever database that pool points at and silently skip the other two.
  const pool = cityScriptPool(cityCode);
  const checks = {
    I1: `SELECT count(*)::int AS violations
         FROM (
           SELECT unit_id
           FROM ${hot}.reservations
           WHERE status IN ('ACTIVE', 'DISPATCHED')
           GROUP BY unit_id
           HAVING count(*) > 1
         ) duplicate_live_reservations`,
    I2_units: `SELECT count(*)::int AS violations
         FROM (
           SELECT u.unit_id, u.status, count(r.reservation_id) AS live_count
           FROM ${hot}.blood_units u
           LEFT JOIN ${hot}.reservations r
             ON r.unit_id = u.unit_id AND r.status IN ('ACTIVE', 'DISPATCHED')
           GROUP BY u.unit_id, u.status
         ) unit_live_counts
         WHERE (status IN ('RESERVED', 'DISPATCHED') AND live_count <> 1)
            OR (status NOT IN ('RESERVED', 'DISPATCHED') AND live_count <> 0)`,
    I2_reservations: `SELECT count(*)::int AS violations
         FROM ${hot}.reservations r
         LEFT JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
         WHERE r.status IN ('ACTIVE', 'DISPATCHED')
           AND (
             u.unit_id IS NULL
             OR (r.status = 'ACTIVE' AND u.status <> 'RESERVED')
             OR (r.status = 'DISPATCHED' AND u.status <> 'DISPATCHED')
           )`,
    I3: `SELECT count(*)::int AS violations
         FROM ${hot}.blood_units u
         WHERE u.status = 'AVAILABLE'
           AND EXISTS (
             SELECT 1 FROM ${hot}.reservations r
             WHERE r.unit_id = u.unit_id AND r.status IN ('ACTIVE', 'DISPATCHED')
           )`,
    I4: `SELECT count(*)::int AS violations
         FROM ${hot}.blood_units u
         WHERE u.status = 'TRANSFUSED'
           AND (
             (SELECT count(*) FROM ${hot}.reservations r
              WHERE r.unit_id = u.unit_id AND r.status = 'COMPLETED') <> 1
             OR
             (SELECT count(*) FROM (
                SELECT t.transfusion_id
                FROM ${hist}.transfusions t
                WHERE t.unit_id = u.unit_id
             ) transfusion_rows) <> 1
           )`,
    I5: `SELECT count(*)::int AS violations
         FROM ${hot}.reservations r
         JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
         WHERE u.expiry_date <= r.reserved_at::date`,
  };

  const result = {};
  for (const [name, sql] of Object.entries(checks)) {
    result[name] = await count(pool, sql);
  }
  const i2 = result.I2_units + result.I2_reservations;
  delete result.I2_units;
  delete result.I2_reservations;
  // Why: reassigning the key would move I2 to the end of the insertion order and
  // make the summary line unreadable, so rebuild the object as I1..I5.
  return { I1: result.I1, I2: i2, I3: result.I3, I4: result.I4, I5: result.I5 };
}

async function main() {
  let failed = false;
  for (const cityCode of CITY_CODES) {
    const results = await verifyCity(cityCode);
    const summary = Object.entries(results)
      .map(([invariant, violations]) => `${invariant}=${violations}`)
      .join(" ");
    process.stdout.write(`[invariants] ${cityCode} ${summary}\n`);
    if (Object.values(results).some((violations) => violations !== 0)) failed = true;
  }
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`[invariants] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await endAllScriptPools();
  });