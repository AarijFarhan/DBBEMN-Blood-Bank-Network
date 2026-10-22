/**
 * Pakistan-realistic large seed for the DBBEMN blood-bank network.
 *
 * Why a separate script from seed-large.js: seed-large.js writes placeholder
 * strings ("SIMULATED large seed donor KHI-1") and unrealistic distributions
 * (25% of every unit is platelets, 19% Rh-negative, every unit collected in the
 * last 30 days). This script keeps the same schema contract but derives every
 * field statistically so the archive reads like real Pakistani blood-bank data:
 *
 *   - real blood banks and hospitals per city, with their actual addresses
 *   - Pakistani donor names, CNIC-era mobile numbers, local localities
 *   - ABO/Rh frequencies from South Asian blood-group studies
 *   - component split, volume and shelf life tied to the component
 *   - collection dates spread over two years with a recent-stock bias
 *   - statuses that follow from shelf life (old PRBC is EXPIRED, not AVAILABLE)
 *
 * Scale is per city. `--units 5000000` across the ten cities seeds 50,000,000
 * blood units plus the donors, donations and read-model rows behind them.
 *
 * Bulk-load performance choices (and why):
 *   - synchronous_commit=off: a seed that dies mid-run is re-runnable, so we do
 *     not need a flush per batch.
 *   - FK + outbox triggers disabled: the ids are derived deterministically, so
 *     every donation/unit reference is correct by construction. Skipping the
 *     per-row FK lookups and the outbox append is what makes 50M rows feasible.
 *   - secondary indexes dropped and rebuilt: building a btree once at the end is
 *     several times faster than maintaining it across 5M random-uuid inserts.
 *   - read model backfilled directly and outbox left empty: the applier has no
 *     backlog to drain, which is the whole point of not going through it.
 */

import { createHash } from "node:crypto";

import { CITY_CODES, schemasFor } from "../backend/src/db/shard-router.js";
import {
  cityScriptPool,
  connectForCity,
  endAllScriptPools,
  withCatalogScriptClient,
} from "./db.js";
import {
  BLOOD_BANKS,
  CITY_NAMES,
  DONATION_NOTES,
  FEMALE_FIRST_NAMES,
  HOSPITALS,
  LOCALITIES,
  MALE_FIRST_NAMES,
  MOBILE_PREFIXES,
  STATUS_REASONS,
  STREETS,
  SURNAMES,
} from "./pakistan-reference.js";

const DEFAULT_UNITS_PER_CITY = 5_000_000;
const DEFAULT_BATCH_SIZE = 200_000;
const DEFAULT_DONATIONS_PER_DONOR = 4;
const DEFAULT_CONCURRENCY = 5;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

const unitsPerCity = positiveInteger(
  argumentValue("--units") ?? process.env.SEED_UNITS_PER_CITY ?? DEFAULT_UNITS_PER_CITY,
  "SEED_UNITS_PER_CITY",
);
const batchSize = positiveInteger(
  argumentValue("--batch") ?? process.env.SEED_BATCH_SIZE ?? DEFAULT_BATCH_SIZE,
  "SEED_BATCH_SIZE",
);
const donationsPerDonor = positiveInteger(
  argumentValue("--donations-per-donor") ??
    process.env.SEED_DONATIONS_PER_DONOR ??
    DEFAULT_DONATIONS_PER_DONOR,
  "SEED_DONATIONS_PER_DONOR",
);
const concurrency = positiveInteger(
  argumentValue("--concurrency") ?? process.env.SEED_CONCURRENCY ?? DEFAULT_CONCURRENCY,
  "SEED_CONCURRENCY",
);

const cityFilter = (argumentValue("--cities") ?? CITY_CODES.join(","))
  .split(",")
  .map((code) => code.trim().toUpperCase())
  .filter(Boolean);

for (const code of cityFilter) {
  if (!CITY_CODES.includes(code)) throw new Error(`Unknown city code: ${code}`);
}

const truncateFirst = !process.argv.includes("--no-truncate");
const seedRelated = !process.argv.includes("--no-related");

/** One whole-blood donation yields ~2.5 component units (PRBC + plasma + platelets). */
const UNITS_PER_DONATION_NUM = 2;
const UNITS_PER_DONATION_DEN = 5;

const donationsPerCity = Math.ceil((unitsPerCity * UNITS_PER_DONATION_NUM) / UNITS_PER_DONATION_DEN);
const donorsPerCity = Math.ceil(donationsPerCity / donationsPerDonor);

/** Must mirror Postgres `md5(key)::uuid`. */
function uuidFromKey(key) {
  const hex = createHash("md5").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function intFromKey(key, salt) {
  return createHash("sha256").update(`${key}:${salt}`).digest().readUInt32BE(0);
}

function phoneFromKey(key) {
  const prefix = MOBILE_PREFIXES[intFromKey(key, "prefix") % MOBILE_PREFIXES.length];
  const line = String(intFromKey(key, "line") % 10_000_000).padStart(7, "0");
  return `${prefix}-${line}`;
}

function log(message) {
  process.stdout.write(`[seed:pk] ${new Date().toISOString().slice(11, 19)} ${message}\n`);
}

const startedAt = Date.now();
function elapsed() {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

/** `(hashtextextended(k, seed) & 2147483647)` — a stable 31-bit value. */
const rnd = (seed) => `(hashtextextended(k, ${seed}) & 2147483647)`;

/**
 * Zipf-ish index into a name pool: raising a uniform value to 2.2 makes the
 * early (most common) names appear far more often, which is how Pakistani given
 * and family names actually distribute.
 */
function skewedNameIndex(hashExpression, arrayParameter) {
  return `(1 + LEAST(
    array_length(${arrayParameter}::text[], 1) - 1,
    floor(pow((${hashExpression})::numeric / 2147483647.0, 2.2)
      * array_length(${arrayParameter}::text[], 1))::int
  ))`;
}

/** Collected `age` in days, biased towards recent stock: 55% in the last 45 days. */
function ageDaysExpression(hashExpression) {
  return `(CASE
    WHEN (${hashExpression}) % 1000 < 550
      THEN floor(((${hashExpression}) % 1000) / 550.0 * 45)
    ELSE 45 + floor((((${hashExpression}) % 1000) - 550) / 450.0 * 675)
  END)::int`;
}

/** ABO frequencies for the Pakistani population: O 36%, A 30%, B 23%, AB 11%. */
function bloodGroupExpression(hashExpression) {
  return `(CASE
    WHEN (${hashExpression}) % 1000 < 360 THEN 'O'
    WHEN (${hashExpression}) % 1000 < 660 THEN 'A'
    WHEN (${hashExpression}) % 1000 < 890 THEN 'B'
    ELSE 'AB'
  END)::common.blood_group_t`;
}

/** Rh-negative is uncommon in Pakistan (~5%). */
function rhExpression(hashExpression) {
  return `(CASE WHEN (${hashExpression}) % 100 < 5 THEN 'NEG' ELSE 'POS' END)::common.rh_t`;
}

async function seedCatalog() {
  log("catalog: replacing placeholder banks/hospitals with the real network");
  await withCatalogScriptClient(async (client) => {
    await client.query("BEGIN");
    try {
      // No catalog.users reference a bank or hospital, so a clean replace is safe.
      await client.query("DELETE FROM catalog.blood_banks");
      await client.query("DELETE FROM catalog.hospitals");

      for (const cityCode of CITY_CODES) {
        const banks = BLOOD_BANKS[cityCode];
        const hospitals = HOSPITALS[cityCode];
        for (const [index, [name, area, latitude, longitude]] of banks.entries()) {
          const key = `pk:bank:${cityCode}:${index + 1}`;
          await client.query(
            `INSERT INTO catalog.blood_banks
               (blood_bank_id, name, city_code, address, latitude, longitude, phone, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
            [
              uuidFromKey(key),
              name,
              cityCode,
              `${area}, ${CITY_NAMES[cityCode]}`,
              latitude,
              longitude,
              phoneFromKey(key),
            ],
          );
        }
        for (const [index, [name, area, latitude, longitude]] of hospitals.entries()) {
          const key = `pk:hosp:${cityCode}:${index + 1}`;
          await client.query(
            `INSERT INTO catalog.hospitals
               (hospital_id, name, city_code, address, latitude, longitude, phone, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
            [
              uuidFromKey(key),
              name,
              cityCode,
              `${area}, ${CITY_NAMES[cityCode]}`,
              latitude,
              longitude,
              phoneFromKey(key),
            ],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

function bankIds(cityCode) {
  return BLOOD_BANKS[cityCode].map((_, index) => uuidFromKey(`pk:bank:${cityCode}:${index + 1}`));
}

function hospitalIds(cityCode) {
  return HOSPITALS[cityCode].map((_, index) => uuidFromKey(`pk:hosp:${cityCode}:${index + 1}`));
}

async function resetCity(client, cityCode) {
  const { hot, hist, read } = schemasFor(cityCode);
  await client.query(
    `TRUNCATE
       ${hot}.reservations,
       ${hot}.donor_requests,
       ${hot}.processed_requests,
       ${hot}.outbox,
       ${hot}.blood_units,
       ${read}.units_search,
       ${hist}.transfusions,
       ${hist}.unit_status_log,
       ${hist}.donations,
       ${hist}.donors
     RESTART IDENTITY`,
  );
  // The applier reads events above this id; the seed writes the read model itself.
  await client.query(
    `INSERT INTO ${read}.replication_state (id, last_applied_event_id, last_applied_at)
     VALUES (TRUE, 0, NULL)
     ON CONFLICT (id) DO UPDATE
       SET last_applied_event_id = 0, last_applied_at = NULL`,
  );
}

async function prepareBulkLoad(client, cityCode) {
  const { hot, read } = schemasFor(cityCode);
  await client.query("SET synchronous_commit = off");
  await client.query("SET maintenance_work_mem = '1GB'");
  await client.query("SET work_mem = '128MB'");
  await client.query("SET statement_timeout = 0");
  await client.query("SET lock_timeout = '30s'");
  // FK triggers are re-enabled and validated at the end; the outbox is filled
  // by the app, not by this archive seed.
  await client.query(
    `ALTER TABLE ${hot}.blood_units DISABLE TRIGGER ALL`,
  );
  await client.query(
    `ALTER TABLE ${histOf(cityCode)}.donations DISABLE TRIGGER ALL`,
  );
  await client.query(
    `ALTER TABLE ${hot}.donor_requests DISABLE TRIGGER ALL`,
  );
  await client.query(`ALTER TABLE ${hot}.reservations DISABLE TRIGGER ALL`);
  await client.query(`DROP INDEX IF EXISTS ${hot}.idx_units_available_search`);
  await client.query(`DROP INDEX IF EXISTS ${hot}.idx_units_bank_status`);
  await client.query(`DROP INDEX IF EXISTS ${hot}.idx_units_expiry_sweep`);
  await client.query(`DROP INDEX IF EXISTS ${read}.idx_units_search_filter_expiry`);
}

function histOf(cityCode) {
  return schemasFor(cityCode).hist;
}

async function insertDonors(client, cityCode, from, to) {
  const { hist } = schemasFor(cityCode);
  const sql = `
    WITH k AS MATERIALIZED (
      SELECT
        i,
        'pk:' || $1 || ':d' || i::text AS k,
        'pk:' || $1 || ':n' || LEAST($8::bigint * i, $9::bigint)::text AS kn
      FROM generate_series($2::bigint, $3::bigint) AS series(i)
    ),
    h AS (
      SELECT
        i, k, kn,
        ${rnd(1)} AS h1,
        ${rnd(2)} AS h2,
        ${rnd(3)} AS h3,
        ${rnd(4)} AS h4,
        ${rnd(5)} AS h5,
        ${rnd(6)} AS h6,
        ${rnd(7)} AS h7,
        ${rnd(8)} AS h8,
        ${rnd(9)} AS h9,
        (hashtextextended(kn, 4) & 2147483647) % 1000 AS r_age
      FROM k
    )
    INSERT INTO ${hist}.donors
      (donor_id, full_name, phone, date_of_birth, sex, weight_kg,
       blood_group, rh_factor, city_code, last_donation_date, is_available)
    SELECT
      md5(k || ':id')::uuid,
      (CASE WHEN h1 % 100 < 60
        THEN ($4::text[])[${skewedNameIndex("h2", "$4")}]
        ELSE ($5::text[])[${skewedNameIndex("h2", "$5")}]
      END) || ' ' || ($6::text[])[${skewedNameIndex("h7", "$6")}],
      ($7::text[])[1 + (h8 % array_length($7::text[], 1))]
        || '-' || lpad((h9 % 10000000)::text, 7, '0'),
      CURRENT_DATE - (6570 + (h5 % 17150))::integer,
      CASE WHEN h1 % 100 < 60 THEN 'M' ELSE 'F' END,
      (45.0 + (h6 % 551) / 10.0)::numeric(5, 1),
      ${bloodGroupExpression("h3")},
      ${rhExpression("h4")},
      $1::char(3),
      CURRENT_DATE - ${ageDaysExpression("r_age")},
      TRUE
    FROM h
    ON CONFLICT (donor_id) DO NOTHING`;
  const parameters = [
    cityCode,
    from,
    to,
    MALE_FIRST_NAMES,
    FEMALE_FIRST_NAMES,
    SURNAMES,
    MOBILE_PREFIXES,
    donationsPerDonor,
    donationsPerCity,
  ];
  await client.query(sql, parameters);
}

async function insertDonations(client, cityCode, from, to) {
  const { hist } = schemasFor(cityCode);
  const banks = bankIds(cityCode);
  const sql = `
    WITH k AS MATERIALIZED (
      SELECT i, 'pk:' || $1 || ':n' || i::text AS k
      FROM generate_series($2::bigint, $3::bigint) AS series(i)
    ),
    h AS (
      SELECT
        i, k,
        ${rnd(4)} AS r_age,
        ${rnd(5)} AS h5,
        ${rnd(6)} AS h6,
        ${rnd(7)} AS h7,
        ${rnd(8)} AS h8
      FROM k
    ),
    d AS (
      SELECT h.*, ${ageDaysExpression("r_age")} AS age_days
      FROM h
    )
    INSERT INTO ${hist}.donations
      (donation_id, donor_id, blood_bank_id, collected_at, volume_ml,
       screening_status, screened_at, notes)
    SELECT
      md5(k || ':id')::uuid,
      md5('pk:' || $1 || ':d' || (1 + ((i - 1) / $5::bigint))::text || ':id')::uuid,
      ($4::uuid[])[1 + ((h6 % array_length($4::uuid[], 1)))],
      ((CURRENT_DATE - age_days)::timestamp
        + ((h5 % 36000) * interval '1 second'))::timestamptz,
      450,
      CASE
        WHEN age_days = 0 THEN 'PENDING'
        WHEN h7 % 1000 < 3 THEN 'FAILED'
        ELSE 'PASSED'
      END,
      CASE
        WHEN age_days = 0 THEN NULL
        ELSE (((CURRENT_DATE - age_days)::timestamp
          + ((h5 % 36000) * interval '1 second')
          + (((h8 % 6) + 2) * interval '1 hour')))::timestamptz
      END,
      ($6::text[])[1 + ((h8 % array_length($6::text[], 1)))]
    FROM d
    ON CONFLICT (donation_id) DO NOTHING`;
  await client.query(sql, [
    cityCode,
    from,
    to,
    banks,
    donationsPerDonor,
    DONATION_NOTES,
  ]);
}

async function insertUnits(client, cityCode, from, to) {
  const { hot } = schemasFor(cityCode);
  const banks = bankIds(cityCode);
  const sql = `
    WITH base AS MATERIALIZED (
      SELECT
        i,
        'pk:' || $1 || ':u' || i::text AS k,
        1 + ((i - 1) * $5::bigint) / $6::bigint AS d
      FROM generate_series($2::bigint, $3::bigint) AS series(i)
    ),
    keys AS MATERIALIZED (
      SELECT
        i, k, d,
        'pk:' || $1 || ':n' || d::text AS kd,
        'pk:' || $1 || ':d' || (1 + ((d - 1) / $7::bigint))::text AS kdonor
      FROM base
    ),
    h AS (
      SELECT
        i, k, kd, kdonor,
        ${rnd(1)} AS r_comp,
        ${rnd(2)} AS r_vol,
        ${rnd(3)} AS r_shelf,
        ${rnd(4)} AS r_age,
        ${rnd(5)} AS r_status,
        ${rnd(6)} AS r_bank,
        (hashtextextended(kdonor, 3) & 2147483647) AS r_group,
        (hashtextextended(kdonor, 4) & 2147483647) AS r_rh
      FROM keys
    ),
    component AS (
      SELECT
        h.*,
        (CASE
          WHEN r_comp % 1000 < 880 THEN 'PRBC'
          WHEN r_comp % 1000 < 940 THEN 'PLATELETS'
          WHEN r_comp % 1000 < 980 THEN 'PLASMA'
          ELSE 'WHOLE_BLOOD'
        END) AS component_type
      FROM h
    ),
    dated AS (
      SELECT
        component.*,
        (CURRENT_DATE - ${ageDaysExpression("r_age")})::date AS collected_on,
        (CASE
          WHEN r_comp % 1000 < 880 THEN 35 + (r_shelf % 8)
          WHEN r_comp % 1000 < 940 THEN 5 + (r_shelf % 3)
          WHEN r_comp % 1000 < 980 THEN 365
          ELSE 21 + (r_shelf % 15)
        END)::int AS shelf_life_days
      FROM component
    ),
    resolved AS (
      SELECT
        dated.*,
        (collected_on + shelf_life_days)::date AS expiry_date
      FROM dated
    ),
    statused AS (
      SELECT
        resolved.*,
        (CASE
          WHEN expiry_date < CURRENT_DATE
            THEN CASE WHEN r_status % 100 < 80 THEN 'EXPIRED' ELSE 'DISCARDED' END
          ELSE CASE
            WHEN r_status % 100 < 72 THEN 'AVAILABLE'
            WHEN r_status % 100 < 80 THEN 'RESERVED'
            WHEN r_status % 100 < 85 THEN 'DISPATCHED'
            WHEN r_status % 100 < 92 THEN 'TRANSFUSED'
            WHEN r_status % 100 < 98 THEN 'QUARANTINE'
            ELSE 'DISCARDED'
          END
        END)::common.unit_status_t AS status
      FROM resolved
    )
    INSERT INTO ${hot}.blood_units
      (unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
       component_type, volume_ml, collected_on, expiry_date, status, version, updated_at)
    SELECT
      md5(k || ':id')::uuid,
      md5(kd || ':id')::uuid,
      ($4::uuid[])[1 + (r_bank % array_length($4::uuid[], 1))],
      ${bloodGroupExpression("r_group")},
      ${rhExpression("r_rh")},
      component_type::common.component_t,
      (CASE
        WHEN component_type = 'PRBC' THEN 250 + (r_vol % 101)
        WHEN component_type = 'PLATELETS' THEN 200 + (r_vol % 101)
        WHEN component_type = 'PLASMA' THEN 200 + (r_vol % 101)
        ELSE 450 + (r_vol % 51)
      END)::smallint,
      collected_on,
      expiry_date,
      status,
      (CASE
        WHEN status = 'QUARANTINE' THEN 1
        WHEN status IN ('AVAILABLE', 'EXPIRED', 'DISCARDED') THEN 2
        ELSE 3
      END),
      ((collected_on + 1)::timestamp + ((r_vol % 30000) * interval '1 second'))::timestamptz
    FROM statused
    ON CONFLICT (unit_id) DO NOTHING`;
  await client.query(sql, [
    cityCode,
    from,
    to,
    banks,
    UNITS_PER_DONATION_NUM,
    UNITS_PER_DONATION_DEN,
    donationsPerDonor,
  ]);
}

async function backfillReadModel(client, cityCode) {
  const { hot, read } = schemasFor(cityCode);
  await client.query(
    `INSERT INTO ${read}.units_search
       (unit_id, blood_bank_id, blood_group, rh_factor, component_type,
        volume_ml, collected_on, expiry_date)
     SELECT unit_id, blood_bank_id, blood_group, rh_factor, component_type,
            volume_ml, collected_on, expiry_date
     FROM ${hot}.blood_units
     WHERE status = 'AVAILABLE'
     ON CONFLICT (unit_id) DO UPDATE SET
       blood_bank_id = EXCLUDED.blood_bank_id,
       blood_group = EXCLUDED.blood_group,
       rh_factor = EXCLUDED.rh_factor,
       component_type = EXCLUDED.component_type,
       volume_ml = EXCLUDED.volume_ml,
       collected_on = EXCLUDED.collected_on,
       expiry_date = EXCLUDED.expiry_date`,
  );
}

const notes = (arrayParameter) => `(${arrayParameter}::text[])[1 + (hashtextextended(k, 10) & 2147483647) % array_length(${arrayParameter}::text[], 1)]`;

async function insertRelated(client, cityCode, counters) {
  const { hot, hist } = schemasFor(cityCode);
  const banks = bankIds(cityCode);
  const hospitals = hospitalIds(cityCode);
  const requestCount = Math.max(1, Math.floor(unitsPerCity / 200));
  const reservationCount = Math.max(1, Math.floor(unitsPerCity / 50));

  // Donor requests: hospitals and banks asking donors to come in.
  await client.query(
    `WITH k AS MATERIALIZED (
       SELECT
         i,
         'pk:' || $1 || ':r' || i::text AS k,
         1 + ((i - 1) % $2::bigint) AS donor_index
       FROM generate_series(1, $2::bigint) AS series(i)
     ),
     h AS (
       SELECT i, k, donor_index,
         ${rnd(1)} AS h1, ${rnd(2)} AS h2, ${rnd(3)} AS h3,
         ${rnd(4)} AS h4, ${rnd(5)} AS h5, ${rnd(6)} AS h6
       FROM k
     )
     INSERT INTO ${hot}.donor_requests
       (request_id, donor_id, requested_by_hospital_id, requested_by_blood_bank_id,
        patient_ref, required_blood_group, required_rh, urgency, slots_requested,
        notes, status, requested_at, responded_at, response_notes)
     SELECT
       md5(k || ':id')::uuid,
       md5('pk:' || $1 || ':d' || donor_index::text || ':id')::uuid,
       CASE WHEN h1 % 100 < 80 THEN ($3::uuid[])[1 + (h2 % array_length($3::uuid[], 1))] END,
       CASE WHEN h1 % 100 >= 80 THEN ($4::uuid[])[1 + (h2 % array_length($4::uuid[], 1))] END,
       'PT-' || lpad((h3 % 1000000)::text, 6, '0'),
       ${bloodGroupExpression("h4")},
       ${rhExpression("h5")},
       CASE WHEN h6 % 100 < 8 THEN 'CRITICAL' WHEN h6 % 100 < 35 THEN 'URGENT' ELSE 'ROUTINE' END,
       1 + (h6 % 4),
       ${notes("$5")},
       (CASE WHEN h3 % 100 < 15 THEN 'PENDING'
             WHEN h3 % 100 < 60 THEN 'ACCEPTED'
             WHEN h3 % 100 < 75 THEN 'DECLINED'
             WHEN h3 % 100 < 85 THEN 'CANCELLED'
             ELSE 'EXPIRED' END)::common.donor_request_status_t,
       now() - ((h2 % 90)::text || ' days')::interval - ((h5 % 86400)::text || ' seconds')::interval,
       CASE WHEN h3 % 100 < 15 THEN NULL
            ELSE now() - ((h2 % 90)::text || ' days')::interval - ((h5 % 86400)::text || ' seconds')::interval
                 + (((h6 % 47) + 1)::text || ' hours')::interval END,
       CASE WHEN h3 % 100 < 15 THEN NULL
            WHEN h3 % 100 < 60 THEN 'Donor confirmed, slot booked'
            WHEN h3 % 100 < 75 THEN 'Donor unavailable, referred to nearby bank'
            WHEN h3 % 100 < 85 THEN 'Request withdrawn'
            ELSE 'No response before expiry' END
     FROM h`,
    [cityCode, requestCount, hospitals, banks, ["Urgent requirement for surgery", "Dialysis patient needs units", "Trauma case in emergency", "Elective procedure scheduled", "Thalassaemia transfusion cycle", "Post-partum haemorrhage"]],
  );
  counters.donor_requests += requestCount;

  // Reservations drawn against real units.
  await client.query(
    `WITH k AS MATERIALIZED (
       SELECT
         i,
         'pk:' || $1 || ':v' || i::text AS k,
         1 + ((i * 7919) % $2::bigint) AS unit_index,
         1 + ((i * 104729) % $3::bigint) AS request_index
       FROM generate_series(1, $3::bigint) AS series(i)
     ),
     h AS (
       SELECT i, k, unit_index, request_index,
         ${rnd(1)} AS h1, ${rnd(2)} AS h2, ${rnd(3)} AS h3, ${rnd(4)} AS h4,
         'pk:' || $1 || ':d' || (1 + (((1 + ((unit_index - 1) * ${UNITS_PER_DONATION_NUM}) / ${UNITS_PER_DONATION_DEN}) - 1) / $4::bigint))::text AS kdonor
       FROM k
     )
     INSERT INTO ${hot}.reservations
       (reservation_id, request_id, unit_id, hospital_id, hospital_city_code,
        patient_blood_group, patient_rh, urgency, status, reserved_at,
        hold_expires_at, dispatched_at, completed_at, cancelled_at, cancel_reason)
     SELECT
       md5(k || ':id')::uuid,
       md5('pk:' || $1 || ':r' || request_index::text || ':id')::uuid,
       md5('pk:' || $1 || ':u' || unit_index::text || ':id')::uuid,
       ($5::uuid[])[1 + (h2 % array_length($5::uuid[], 1))],
       $1::char(3),
       ${bloodGroupExpression("(hashtextextended(kdonor, 3) & 2147483647)")},
       ${rhExpression("(hashtextextended(kdonor, 4) & 2147483647)")},
       CASE WHEN h3 % 100 < 10 THEN 'CRITICAL' WHEN h3 % 100 < 40 THEN 'URGENT' ELSE 'ROUTINE' END,
       (CASE WHEN h4 % 100 < 8 THEN 'ACTIVE'
             WHEN h4 % 100 < 18 THEN 'DISPATCHED'
             WHEN h4 % 100 < 80 THEN 'COMPLETED'
             WHEN h4 % 100 < 92 THEN 'CANCELLED'
             ELSE 'EXPIRED' END)::common.reservation_status_t,
       now() - ((h1 % 120)::text || ' days')::interval,
       now() - ((h1 % 120)::text || ' days')::interval + (((h2 % 48) + 24)::text || ' hours')::interval,
       CASE WHEN h4 % 100 >= 5 AND h4 % 100 < 18 THEN now() - ((h1 % 120)::text || ' days')::interval + (((h2 % 24) + 1)::text || ' hours')::interval END,
       CASE WHEN h4 % 100 >= 18 AND h4 % 100 < 80 THEN now() - ((h1 % 120)::text || ' days')::interval + (((h2 % 24) + 2)::text || ' hours')::interval END,
       CASE WHEN h4 % 100 >= 92 AND h4 % 100 < 100 THEN now() - ((h1 % 120)::text || ' days')::interval + (((h2 % 12) + 1)::text || ' hours')::interval END,
       CASE WHEN h4 % 100 >= 92 THEN 'Hospital cancelled before dispatch' END
     FROM h`,
    [cityCode, unitsPerCity, reservationCount, donationsPerDonor, hospitals],
  );
  counters.reservations += reservationCount;

  // Transfusions for the reservations that completed.
  const transfused = await client.query(
    `WITH completed AS (
       SELECT reservation_id, unit_id, hospital_id, completed_at, patient_blood_group, patient_rh
       FROM ${hot}.reservations
       WHERE status = 'COMPLETED'
     )
     INSERT INTO ${hist}.transfusions
       (transfusion_id, reservation_id, unit_id, hospital_id, patient_ref,
        transfused_at, outcome_notes)
     SELECT
       md5(reservation_id::text || ':transfusion')::uuid,
       reservation_id,
       unit_id,
       hospital_id,
       'PT-' || lpad((('x' || substr(md5(reservation_id::text), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0'),
       completed_at + ((('x' || substr(md5(reservation_id::text), 9, 6))::bit(24)::int % 120) * interval '1 minute'),
       (ARRAY['Transfusion completed without reaction', 'No adverse event observed', 'Mild febrile reaction, managed', 'Patient stable after transfusion', 'Follow-up haemoglobin improved'])[1 + (('x' || substr(md5(reservation_id::text), 15, 4))::bit(16)::int % 5)]
     FROM completed`,
  );
  counters.transfusions += transfused.rowCount;

  // Status audit trail: live units get their full history, old ones a sample.
  const statusLog = await client.query(
    `INSERT INTO ${hist}.unit_status_log
       (unit_id, from_status, to_status, reason, changed_at)
     SELECT unit_id, NULL::common.unit_status_t, 'QUARANTINE'::common.unit_status_t,
            'Collected, awaiting serology screening',
            (collected_on::timestamp + interval '4 hours')::timestamptz
     FROM ${hot}.blood_units
     WHERE status = 'QUARANTINE'
     UNION ALL
     SELECT unit_id, 'QUARANTINE'::common.unit_status_t, 'AVAILABLE'::common.unit_status_t,
            'Screening passed, released to inventory',
            (collected_on::timestamp + interval '18 hours')::timestamptz
     FROM ${hot}.blood_units
     WHERE status IN ('AVAILABLE', 'RESERVED', 'DISPATCHED', 'TRANSFUSED')
       AND (status <> 'AVAILABLE'
            OR (hashtextextended(unit_id::text, 11) & 2147483647) % 100 < 15)
     UNION ALL
     SELECT unit_id, 'AVAILABLE'::common.unit_status_t, status,
            CASE status
              WHEN 'RESERVED' THEN 'Reserved for hospital request'
              WHEN 'DISPATCHED' THEN 'Dispatched to requesting hospital'
              WHEN 'TRANSFUSED' THEN 'Transfused to patient'
              WHEN 'EXPIRED' THEN 'Expired - shelf life exceeded'
              ELSE 'Discarded after quality review'
            END,
            CASE status
              WHEN 'EXPIRED' THEN (expiry_date::timestamp + interval '2 hours')::timestamptz
              ELSE (collected_on::timestamp + interval '3 days')::timestamptz
            END
     FROM ${hot}.blood_units
     WHERE status IN ('RESERVED', 'DISPATCHED', 'TRANSFUSED')
        OR (status IN ('EXPIRED', 'DISCARDED')
            AND (hashtextextended(unit_id::text, 12) & 2147483647) % 100 < 10)`,
  );
  counters.unit_status_log += statusLog.rowCount;
}

async function finishBulkLoad(client, cityCode) {
  const { hot, hist, read } = schemasFor(cityCode);
  log(`${cityCode}: rebuilding indexes`);
  await client.query(
    `CREATE INDEX idx_units_available_search ON ${hot}.blood_units
       (component_type, blood_group, rh_factor, expiry_date)
       WHERE status = 'AVAILABLE'::common.unit_status_t`,
  );
  await client.query(
    `CREATE INDEX idx_units_bank_status ON ${hot}.blood_units (blood_bank_id, status)`,
  );
  await client.query(
    `CREATE INDEX idx_units_expiry_sweep ON ${hot}.blood_units (expiry_date)
       WHERE status = ANY (ARRAY['QUARANTINE'::common.unit_status_t,
                                 'AVAILABLE'::common.unit_status_t,
                                 'RESERVED'::common.unit_status_t])`,
  );
  await client.query(
    `CREATE INDEX idx_units_search_filter_expiry ON ${read}.units_search
       (component_type, blood_group, rh_factor, expiry_date)`,
  );

  await client.query(`ALTER TABLE ${hot}.blood_units ENABLE TRIGGER ALL`);
  await client.query(`ALTER TABLE ${hist}.donations ENABLE TRIGGER ALL`);
  await client.query(`ALTER TABLE ${hot}.donor_requests ENABLE TRIGGER ALL`);
  await client.query(`ALTER TABLE ${hot}.reservations ENABLE TRIGGER ALL`);

  log(`${cityCode}: validating foreign keys`);
  const orphans = await client.query(
    `SELECT
       (SELECT count(*) FROM ${hot}.blood_units u
          LEFT JOIN ${hist}.donations d ON d.donation_id = u.donation_id
          WHERE d.donation_id IS NULL) AS units_without_donation,
       (SELECT count(*) FROM ${hist}.donations d
          LEFT JOIN ${hist}.donors n ON n.donor_id = d.donor_id
          WHERE n.donor_id IS NULL) AS donations_without_donor,
       (SELECT count(*) FROM ${hot}.reservations r
          LEFT JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
          WHERE u.unit_id IS NULL) AS reservations_without_unit`,
  );
  const row = orphans.rows[0];
  const broken =
    Number(row.units_without_donation) +
    Number(row.donations_without_donor) +
    Number(row.reservations_without_unit);
  if (broken > 0) {
    throw new Error(`${cityCode}: ${JSON.stringify(row)}`);
  }

  log(`${cityCode}: analyzing`);
  await client.query(`ANALYZE ${hot}.blood_units`);
  await client.query(`ANALYZE ${hist}.donations`);
  await client.query(`ANALYZE ${hist}.donors`);
  await client.query(`ANALYZE ${read}.units_search`);
  await client.query("RESET synchronous_commit");
}

async function seedCity(cityCode) {
  const { hot, hist, read } = schemasFor(cityCode);
  const client = await connectForCity(cityCode)();
  const cityStartedAt = Date.now();
  const counters = {
    donor_requests: 0,
    reservations: 0,
    transfusions: 0,
    unit_status_log: 0,
  };
  try {
    if (truncateFirst) {
      log(`${cityCode}: truncating previous seed`);
      await resetCity(client, cityCode);
    }
    await prepareBulkLoad(client, cityCode);

    const batches = (total) => Math.ceil(total / batchSize);
    const runBatched = async (label, total, insert) => {
      const totalBatches = batches(total);
      for (let batch = 0; batch < totalBatches; batch += 1) {
        const from = batch * batchSize + 1;
        const to = Math.min((batch + 1) * batchSize, total);
        const batchStartedAt = Date.now();
        await insert(from, to);
        const seconds = (Date.now() - batchStartedAt) / 1000;
        const rate = Math.round((to - from + 1) / Math.max(seconds, 0.001));
        log(
          `${cityCode}: ${label} ${to.toLocaleString("en-US")}/${total.toLocaleString("en-US")} ` +
            `(${rate.toLocaleString("en-US")} rows/s)`,
        );
      }
    };

    log(
      `${cityCode}: seeding ${donorsPerCity.toLocaleString("en-US")} donors, ` +
        `${donationsPerCity.toLocaleString("en-US")} donations, ` +
        `${unitsPerCity.toLocaleString("en-US")} units`,
    );
    await runBatched("donors", donorsPerCity, (from, to) =>
      insertDonors(client, cityCode, from, to),
    );
    await runBatched("donations", donationsPerCity, (from, to) =>
      insertDonations(client, cityCode, from, to),
    );
    await runBatched("units", unitsPerCity, (from, to) =>
      insertUnits(client, cityCode, from, to),
    );

    log(`${cityCode}: backfilling read model`);
    await backfillReadModel(client, cityCode);

    if (seedRelated) {
      log(`${cityCode}: seeding requests, reservations, transfusions, status log`);
      await insertRelated(client, cityCode, counters);
    }

    await finishBulkLoad(client, cityCode);

    const counts = await client.query(
      `SELECT
         (SELECT count(*) FROM ${hist}.donors) AS donors,
         (SELECT count(*) FROM ${hist}.donations) AS donations,
         (SELECT count(*) FROM ${hot}.blood_units) AS units,
         (SELECT count(*) FROM ${read}.units_search) AS read_units,
         (SELECT count(*) FROM ${hot}.outbox) AS outbox,
         (SELECT count(*) FROM ${hot}.reservations) AS reservations,
         (SELECT count(*) FROM ${hist}.transfusions) AS transfusions,
         (SELECT count(*) FROM ${hot}.donor_requests) AS donor_requests,
         (SELECT count(*) FROM ${hist}.unit_status_log) AS unit_status_log`,
    );
    const seconds = Math.round((Date.now() - cityStartedAt) / 1000);
    log(`${cityCode}: done in ${Math.floor(seconds / 60)}m${seconds % 60}s ${JSON.stringify(counts.rows[0])}`);
  } finally {
    client.release();
  }
}

async function verify(cityCodes) {
  log("verification");
  for (const cityCode of cityCodes) {
    const { hot, read } = schemasFor(cityCode);
    const result = await cityScriptPool(cityCode).query(
      `SELECT
         (SELECT count(*) FROM ${hot}.blood_units) AS units,
         (SELECT count(*) FROM ${hot}.blood_units WHERE status = 'AVAILABLE') AS available,
         (SELECT count(*) FROM ${read}.units_search) AS read_units,
         (SELECT count(*) FROM ${hot}.outbox) AS outbox,
         (SELECT round(avg(volume_ml)) FROM ${hot}.blood_units) AS avg_volume,
         (SELECT min(collected_on) FROM ${hot}.blood_units) AS oldest,
         (SELECT max(collected_on) FROM ${hot}.blood_units) AS newest`,
    );
    log(`${cityCode}: ${JSON.stringify(result.rows[0])}`);
  }
}

async function main() {
  if (!truncateFirst) log("--no-truncate: appending to existing seed rows");
  await seedCatalog();

  const queue = [...cityFilter];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const cityCode = queue.shift();
      await seedCity(cityCode);
    }
  });
  await Promise.all(workers);

  await verify(cityFilter);
  log(`complete in ${elapsed()}`);
}

main()
  .catch((error) => {
    process.stderr.write(`[seed:pk] failed: ${error.stack}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await endAllScriptPools();
  });
