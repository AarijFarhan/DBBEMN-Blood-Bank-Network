import { createHash } from "node:crypto";

import { schemasFor } from "../backend/src/db/shard-router.js";
import { connectForCity, endAllScriptPools } from "./db.js";
import {
  BLOOD_BANKS,
  DONATION_NOTES,
  FEMALE_FIRST_NAMES,
  MALE_FIRST_NAMES,
  MOBILE_PREFIXES,
  SURNAMES,
} from "./pakistan-reference.js";

const PLAN = {
  LHE: { donors: 19_347, donations: 77_388, units: 154_773 },
  ISB: { donors: 19_347, donations: 77_388, units: 151_628 },
  MUL: { donors: 1_999, donations: 7_996, units: 18_498 },
  PEW: { donors: 1_999, donations: 7_996, units: 19_498 },
  QUE: { donors: 1_999, donations: 7_996, units: 20_498 },
  HYD: { donors: 1_999, donations: 7_996, units: 21_498 },
  GUJ: { donors: 1_999, donations: 7_996, units: 22_498 },
};

const apply = process.argv.includes("--apply");

function uuidFromKey(key) {
  const hex = createHash("md5").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bankIds(cityCode) {
  return BLOOD_BANKS[cityCode].map((_, index) =>
    uuidFromKey(`pk:bank:${cityCode}:${index + 1}`),
  );
}

const rnd = (seed) => `(hashtextextended(k, ${seed}) & 2147483647)`;

function bloodGroupExpression(hashExpression) {
  return `(CASE
    WHEN (${hashExpression}) % 1000 < 360 THEN 'O'
    WHEN (${hashExpression}) % 1000 < 660 THEN 'A'
    WHEN (${hashExpression}) % 1000 < 890 THEN 'B'
    ELSE 'AB'
  END)::common.blood_group_t`;
}

function rhExpression(hashExpression) {
  return `(CASE WHEN (${hashExpression}) % 100 < 5 THEN 'NEG' ELSE 'POS' END)::common.rh_t`;
}

function addedRows(plan) {
  return plan.donors + plan.donations + plan.units * 2;
}

async function exactTotal(client) {
  const result = await client.query(`
    WITH counts AS (
      SELECT (xpath('/row/c/text()', query_to_xml(
        format('SELECT count(*) AS c FROM %I.%I', schemaname, relname),
        false, true, '')))[1]::text::bigint AS n
      FROM pg_stat_user_tables
      WHERE schemaname IN ('catalog', 'public')
         OR schemaname IN (current_database() || '_hot',
                           current_database() || '_history',
                           current_database() || '_read')
    )
    SELECT sum(n)::bigint AS total FROM counts
  `);
  return Number(result.rows[0].total);
}

async function insertDonors(client, cityCode, plan) {
  const { hist } = schemasFor(cityCode);
  const sql = `
    WITH k AS MATERIALIZED (
      SELECT i, 'pk2:' || $1 || ':d' || i::text AS k
      FROM generate_series(1, $2::bigint) AS series(i)
    ),
    h AS (
      SELECT i, k,
        ${rnd(1)} AS h1,
        ${rnd(2)} AS h2,
        ${rnd(3)} AS h3,
        ${rnd(4)} AS h4,
        ${rnd(5)} AS h5,
        ${rnd(6)} AS h6,
        ${rnd(7)} AS h7,
        ${rnd(8)} AS h8,
        ${rnd(9)} AS h9
      FROM k
    )
    INSERT INTO ${hist}.donors
      (donor_id, full_name, phone, date_of_birth, sex, weight_kg,
       blood_group, rh_factor, city_code, last_donation_date, is_available)
    SELECT
      md5(k || ':id')::uuid,
      (CASE WHEN h1 % 100 < 60
        THEN ($3::text[])[1 + (h2 % array_length($3::text[], 1))]
        ELSE ($4::text[])[1 + (h2 % array_length($4::text[], 1))]
      END) || ' ' || ($5::text[])[1 + (h7 % array_length($5::text[], 1))],
      ($6::text[])[1 + (h8 % array_length($6::text[], 1))]
        || '-' || lpad((h9 % 10000000)::text, 7, '0'),
      CURRENT_DATE - (6570 + (h5 % 17150))::integer,
      CASE WHEN h1 % 100 < 60 THEN 'M' ELSE 'F' END,
      (45.0 + (h6 % 551) / 10.0)::numeric(5, 1),
      ${bloodGroupExpression("h3")},
      ${rhExpression("h4")},
      $1::char(3),
      CURRENT_DATE - (h6 % 365)::integer,
      TRUE
    FROM h
    ON CONFLICT (donor_id) DO NOTHING`;
  await client.query(sql, [
    cityCode,
    plan.donors,
    MALE_FIRST_NAMES,
    FEMALE_FIRST_NAMES,
    SURNAMES,
    MOBILE_PREFIXES,
  ]);
}

async function insertDonations(client, cityCode, plan) {
  const { hist } = schemasFor(cityCode);
  const banks = bankIds(cityCode);
  const sql = `
    WITH k AS MATERIALIZED (
      SELECT i, 'pk2:' || $1 || ':n' || i::text AS k
      FROM generate_series(1, $2::bigint) AS series(i)
    ),
    h AS (
      SELECT i, k,
        ${rnd(1)} AS h1,
        ${rnd(2)} AS h2,
        ${rnd(3)} AS h3,
        ${rnd(4)} AS h4,
        ${rnd(5)} AS h5,
        ${rnd(6)} AS h6,
        ${rnd(7)} AS h7,
        ${rnd(8)} AS h8
      FROM k
    ),
    d AS (
      SELECT h.*, (h4 % 30)::int AS age_days FROM h
    )
    INSERT INTO ${hist}.donations
      (donation_id, donor_id, blood_bank_id, collected_at, volume_ml,
       screening_status, screened_at, notes)
    SELECT
      md5(k || ':id')::uuid,
      md5('pk2:' || $1 || ':d' || (1 + ((i - 1) / $5::bigint))::text || ':id')::uuid,
      ($3::uuid[])[1 + (h6 % array_length($3::uuid[], 1))],
      ((CURRENT_DATE - age_days)::timestamp
        + make_interval(secs => (h5 % 36000)::int))::timestamptz,
      450,
      'PASSED',
      ((CURRENT_DATE - age_days)::timestamp
        + make_interval(secs => (h5 % 36000)::int)
        + interval '6 hours')::timestamptz,
      ($4::text[])[1 + (h8 % array_length($4::text[], 1))]
    FROM d
    ON CONFLICT (donation_id) DO NOTHING`;
  await client.query(sql, [cityCode, plan.donations, banks, DONATION_NOTES, 4]);
}

async function insertUnits(client, cityCode, plan) {
  const { hot, read } = schemasFor(cityCode);
  const banks = bankIds(cityCode);
  await client.query(
    `
    CREATE TEMP TABLE seed_units ON COMMIT DROP AS
    WITH k AS MATERIALIZED (
      SELECT i,
        'pk2:' || $1 || ':u' || i::text AS k,
        1 + ((i - 1) % $3::bigint) AS donation_index
      FROM generate_series(1, $2::bigint) AS series(i)
    ),
    h AS (
      SELECT i, k, donation_index,
        ${rnd(1)} AS h1,
        ${rnd(2)} AS h2,
        ${rnd(3)} AS h3,
        ${rnd(4)} AS h4,
        ${rnd(5)} AS h5,
        ${rnd(6)} AS h6,
        ${rnd(7)} AS h7
      FROM k
    ),
    component AS (
      SELECT h.*,
        (CASE
          WHEN h1 % 1000 < 700 THEN 'PRBC'
          WHEN h1 % 1000 < 850 THEN 'PLATELETS'
          WHEN h1 % 1000 < 950 THEN 'PLASMA'
          ELSE 'WHOLE_BLOOD'
        END) AS component_type
      FROM h
    ),
    dated AS (
      SELECT component.*,
        (CURRENT_DATE - (h2 % 5)::integer)::date AS collected_on,
        (CASE
          WHEN component_type = 'PRBC' THEN 35 + (h3 % 8)::int
          WHEN component_type = 'PLATELETS' THEN 5 + (h3 % 3)::int
          WHEN component_type = 'PLASMA' THEN 365
          ELSE 21 + (h3 % 15)::int
        END)::int AS shelf_life_days
      FROM component
    )
    SELECT
      md5(k || ':id')::uuid AS unit_id,
      md5('pk2:' || $1 || ':n' || donation_index::text || ':id')::uuid AS donation_id,
      ($4::uuid[])[1 + (h5 % array_length($4::uuid[], 1))] AS blood_bank_id,
      ${bloodGroupExpression("h6")} AS blood_group,
      ${rhExpression("h7")} AS rh_factor,
      component_type::common.component_t AS component_type,
      (CASE
        WHEN component_type = 'PRBC' THEN 250 + (h4 % 101)::int
        WHEN component_type = 'PLATELETS' THEN 200 + (h4 % 101)::int
        WHEN component_type = 'PLASMA' THEN 200 + (h4 % 101)::int
        ELSE 450 + (h4 % 51)::int
      END)::smallint AS volume_ml,
      collected_on,
      (collected_on + shelf_life_days)::date AS expiry_date
    FROM dated
  `,
    [cityCode, plan.units, plan.donations, banks],
  );

  await client.query(`
    INSERT INTO ${hot}.blood_units
      (unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
       component_type, volume_ml, collected_on, expiry_date, status, version, updated_at)
    SELECT unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
           component_type, volume_ml, collected_on, expiry_date,
           'AVAILABLE'::common.unit_status_t, 2, now()
    FROM seed_units
    ON CONFLICT (unit_id) DO NOTHING
  `);

  await client.query(`
    INSERT INTO ${read}.units_search
      (unit_id, blood_bank_id, blood_group, rh_factor, component_type,
       volume_ml, collected_on, expiry_date)
    SELECT unit_id, blood_bank_id, blood_group, rh_factor, component_type,
           volume_ml, collected_on, expiry_date
    FROM seed_units
    ON CONFLICT (unit_id) DO NOTHING
  `);
}

async function seedCity(cityCode, plan) {
  const { hot, hist, read } = schemasFor(cityCode);
  const client = await connectForCity(cityCode)();
  try {
    const before = await exactTotal(client);
    process.stdout.write(
      `[seed:more] ${cityCode}: current ${before}, plan +${addedRows(plan)}${apply ? "" : " (dry run)"}\n`,
    );
    if (!apply) return;

    await client.query("BEGIN");
    await client.query("SET LOCAL synchronous_commit = off");
    await client.query("SET LOCAL statement_timeout = 0");
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query(`ALTER TABLE ${hot}.blood_units DISABLE TRIGGER USER`);

    await insertDonors(client, cityCode, plan);
    await insertDonations(client, cityCode, plan);
    await insertUnits(client, cityCode, plan);

    await client.query(`ALTER TABLE ${hot}.blood_units ENABLE TRIGGER USER`);
    await client.query("COMMIT");

    await client.query(`ANALYZE ${hist}.donors`);
    await client.query(`ANALYZE ${hist}.donations`);
    await client.query(`ANALYZE ${hot}.blood_units`);
    await client.query(`ANALYZE ${read}.units_search`);

    const after = await exactTotal(client);
    process.stdout.write(`[seed:more] ${cityCode}: now ${after}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const cityArg = process.argv.find((arg) => arg.startsWith("--cities="));
  const onlyCities = cityArg
    ? new Set(
        cityArg
          .slice("--cities=".length)
          .split(",")
          .map((city) => city.trim().toUpperCase())
          .filter(Boolean),
      )
    : null;
  const selected = Object.entries(PLAN).filter(
    ([cityCode]) => !onlyCities || onlyCities.has(cityCode),
  );

  for (const [cityCode, plan] of selected) {
    if (plan.donations !== plan.donors * 4) {
      throw new Error(`${cityCode}: donations must be 4x donors`);
    }
  }
  process.stdout.write(
    `[seed:more] ${apply ? "APPLY" : "DRY RUN"} total add = ${selected.reduce((sum, [, plan]) => sum + addedRows(plan), 0)}\n`,
  );
  for (const [cityCode, plan] of selected) {
    await seedCity(cityCode, plan);
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[seed:more] failed: ${error.stack}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await endAllScriptPools();
  });
