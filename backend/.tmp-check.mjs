import pg from "pg";
const c = new pg.Client({connectionString:"postgresql://dbbemn:dbbemn@127.0.0.1:5432/catalog"});
await c.connect();
const dbs = await c.query("SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY 1");
console.log("DATABASES:", dbs.rows.map(r=>r.datname).join(", "));
const q = await c.query(`SELECT
 (SELECT count(*) FROM catalog.users) AS users,
 (SELECT count(*) FROM catalog.hospitals) AS hospitals,
 (SELECT count(*) FROM catalog.blood_banks) AS blood_banks,
 (SELECT count(*) FROM catalog.cities) AS cities`);
console.log("CATALOG:", q.rows[0]);
const roles = await c.query("SELECT role, count(*)::int AS n FROM catalog.users GROUP BY role ORDER BY n DESC");
console.log("ROLES:", roles.rows);
await c.end();
for (const db of ["khi","lhe","isb"]) {
  const cc = new pg.Client({connectionString:`postgresql://dbbemn:dbbemn@127.0.0.1:5432/${db}`});
  try {
    await cc.connect();
    const r = await cc.query(`SELECT
      (SELECT count(*) FROM ${db}_hot.blood_units) AS units,
      (SELECT count(*) FROM ${db}_hot.blood_units WHERE status='AVAILABLE') AS available,
      (SELECT count(*) FROM ${db}_history.donors) AS donors,
      (SELECT count(*) FROM ${db}_history.donations) AS donations,
      (SELECT count(*) FROM ${db}_hot.reservations) AS reservations,
      (SELECT count(*) FROM ${db}_read.units_search) AS read_units`);
    console.log(db.toUpperCase()+":", r.rows[0]);
    await cc.end();
  } catch(e) { console.log(db.toUpperCase()+" ERROR:", e.message); }
}
