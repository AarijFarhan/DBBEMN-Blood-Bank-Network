import pg from "pg";
for (const db of ["khi","lhe"]) {
  const cc = new pg.Client({connectionString:`postgresql://dbbemn:dbbemn@127.0.0.1:5432/${db}`});
  await cc.connect();
  const r = await cc.query(`SELECT
    (SELECT reltuples::bigint FROM pg_class WHERE oid='${db}_hot.blood_units'::regclass) AS units_est,
    (SELECT count(*) FROM ${db}_hot.blood_units WHERE status='AVAILABLE' AND expiry_date > CURRENT_DATE) AS available_exact,
    (SELECT count(*) FROM ${db}_history.donors) AS donors_exact,
    (SELECT count(*) FROM ${db}_read.units_search) AS read_units_exact`);
  console.log(db.toUpperCase()+":", r.rows[0]);
  await cc.end();
}
