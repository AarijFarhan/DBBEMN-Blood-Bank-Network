import pg from "pg";

const c = new pg.Client({ connectionString: process.env.KHI_DATABASE_URL });
await c.connect();
try {
  const r = await c.query(
    `SELECT blood_group::text AS "bloodGroup", rh_factor::text AS "rhFactor",
            component_type::text AS "componentType", status::text AS status,
            count(*)::int AS count
     FROM khi_hot.blood_units
     WHERE ($1::uuid IS NULL OR blood_bank_id = $1)
     GROUP BY 1, 2, 3, 4`,
    [null]
  );
  console.log("rows:", r.rows.length);
  console.table(r.rows.slice(0, 5));
} catch (e) {
  console.error("QUERY ERROR:", e.message);
  console.error("CODE:", e.code);
}
await c.end();
