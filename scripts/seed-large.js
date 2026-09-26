import { CITY_CODES, schemasFor } from "../backend/src/db/shard-router.js";
import { connectWithRetry, pool, withClient } from "./db.js";

const DEFAULT_DONORS_PER_CITY = 5_000;
const DEFAULT_UNITS_PER_CITY = 50_000;
const DEFAULT_BATCH_SIZE = 1_000;
const CITY_BANK_COUNT = 2;
const CITY_HOSPITAL_COUNT = 3;

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

const donorsPerCity = positiveInteger(
  argumentValue("--donors") ??
    process.env.SEED_DONORS_PER_CITY ??
    DEFAULT_DONORS_PER_CITY,
  "SEED_DONORS_PER_CITY",
);
const unitsPerCity = positiveInteger(
  argumentValue("--units") ??
    process.env.SEED_UNITS_PER_CITY ??
    DEFAULT_UNITS_PER_CITY,
  "SEED_UNITS_PER_CITY",
);
const batchSize = positiveInteger(
  argumentValue("--batch") ?? process.env.SEED_BATCH_SIZE ?? DEFAULT_BATCH_SIZE,
  "SEED_BATCH_SIZE",
);

function fixedUuid(prefix, value) {
  return `${prefix}-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

const catalog = Object.fromEntries(
  CITY_CODES.map((cityCode, cityIndex) => {
    const bankBase = cityIndex * 10 + 1;
    const hospitalBase = cityIndex * 10 + 1;
    return [
      cityCode,
      {
        banks: Array.from({ length: CITY_BANK_COUNT }, (_, index) => ({
          id: fixedUuid("11000000", bankBase + index),
          name: `SIMULATED Large Seed Blood Bank ${cityCode} ${index + 1}`,
          address: `SIMULATED seed address ${cityCode} ${index + 1}`,
          latitude: 24.8607 + cityIndex * 3.6,
          longitude: 67.0011 + cityIndex * 3.7,
        })),
        hospitals: Array.from({ length: CITY_HOSPITAL_COUNT }, (_, index) => ({
          id: fixedUuid("21000000", hospitalBase + index),
          name: `SIMULATED Large Seed Hospital ${cityCode} ${index + 1}`,
          address: `SIMULATED seed address ${cityCode} ${index + 1}`,
          latitude: 24.8607 + cityIndex * 3.6,
          longitude: 67.0011 + cityIndex * 3.7,
        })),
      },
    ];
  }),
);

async function insertCatalogSeed() {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      for (const cityCode of CITY_CODES) {
        for (const bank of catalog[cityCode].banks) {
          await client.query(
            `INSERT INTO catalog.blood_banks
               (blood_bank_id, name, city_code, address, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (blood_bank_id) DO NOTHING`,
            [
              bank.id,
              bank.name,
              cityCode,
              bank.address,
              bank.latitude,
              bank.longitude,
            ],
          );
        }
        for (const hospital of catalog[cityCode].hospitals) {
          await client.query(
            `INSERT INTO catalog.hospitals
               (hospital_id, name, city_code, address, latitude, longitude)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (hospital_id) DO NOTHING`,
            [
              hospital.id,
              hospital.name,
              cityCode,
              hospital.address,
              hospital.latitude,
              hospital.longitude,
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

async function insertDonors(client, cityCode, hist) {
  const sql = `
    WITH generated AS (
      SELECT
        i,
        CASE
          WHEN ((i - 1) % 100) < 35 THEN 'O'
          WHEN ((i - 1) % 100) < 65 THEN 'A'
          WHEN ((i - 1) % 100) < 89 THEN 'B'
          ELSE 'AB'
        END::common.blood_group_t AS blood_group,
        CASE
          WHEN ((i - 1) % 100) < 7 THEN 'NEG'
          WHEN ((i - 1) % 100) BETWEEN 42 AND 47 THEN 'NEG'
          WHEN ((i - 1) % 100) BETWEEN 78 AND 80 THEN 'NEG'
          WHEN ((i - 1) % 100) BETWEEN 90 AND 92 THEN 'NEG'
          ELSE 'POS'
        END::common.rh_t AS rh_factor
      FROM generate_series($2::bigint, $3::bigint) AS series(i)
    )
    INSERT INTO ${hist}.donors
      (donor_id, full_name, phone, date_of_birth, sex, weight_kg,
       blood_group, rh_factor, city_code, last_donation_date, is_available)
    SELECT
      md5('dbbemn-large-donor:' || $1 || ':' || i::text)::uuid,
      'SIMULATED large seed donor ' || $1 || '-' || i::text,
      '+92-SIM-' || lpad(i::text, 8, '0'),
      DATE '1980-01-01' + (i % 10000)::integer,
      CASE WHEN i % 2 = 0 THEN 'M' ELSE 'F' END,
      (55 + ((i % 4500)::numeric / 100))::numeric(5,1),
      blood_group,
      rh_factor,
      $1::char(3),
      CURRENT_DATE - 180,
      TRUE
    FROM generated
    ON CONFLICT (donor_id) DO NOTHING`;
  for (let start = 1; start <= donorsPerCity; start += batchSize) {
    const end = Math.min(start + batchSize - 1, donorsPerCity);
    await client.query(sql, [cityCode, start, end]);
  }
}

async function insertDonations(client, cityCode, hist) {
  const bankIds = catalog[cityCode].banks.map((bank) => bank.id);
  const sql = `
    WITH generated AS (
      SELECT
        i,
        md5('dbbemn-large-donation:' || $1 || ':' || i::text)::uuid AS donation_id,
        CASE (i % 2)
          WHEN 0 THEN $4::uuid
          ELSE $5::uuid
        END AS blood_bank_id
      FROM generate_series($2::bigint, $3::bigint) AS series(i)
    )
    INSERT INTO ${hist}.donations
      (donation_id, donor_id, blood_bank_id, collected_at, volume_ml,
       screening_status, screened_at, notes)
    SELECT
      donation_id,
      md5('dbbemn-large-donor:' || $1 || ':' || (((i - 1) % $6::bigint) + 1)::text)::uuid,
      blood_bank_id,
      now() - ((i % 45)::text || ' days')::interval,
      450,
      'PASSED',
      now() - ((i % 45)::text || ' days')::interval,
      'SIMULATED large seed'
    FROM generated
    ON CONFLICT (donation_id) DO NOTHING`;
  for (let start = 1; start <= unitsPerCity; start += batchSize) {
    const end = Math.min(start + batchSize - 1, unitsPerCity);
    await client.query(sql, [
      cityCode,
      start,
      end,
      bankIds[0],
      bankIds[1],
      donorsPerCity,
    ]);
  }
}

async function insertUnits(client, cityCode, hot, hist) {
  const bankIds = catalog[cityCode].banks.map((bank) => bank.id);
  const sql = `
    WITH generated AS (
      SELECT
        i,
        md5('dbbemn-large-unit:' || $1 || ':' || i::text)::uuid AS unit_id,
        md5('dbbemn-large-donation:' || $1 || ':' || i::text)::uuid AS donation_id,
        CASE (i % 4)
          WHEN 0 THEN 'WHOLE_BLOOD'::common.component_t
          WHEN 1 THEN 'PRBC'::common.component_t
          WHEN 2 THEN 'PLATELETS'::common.component_t
          ELSE 'PLASMA'::common.component_t
        END AS component_type,
        CASE (i % 4)
          WHEN 0 THEN 300
          WHEN 1 THEN 250
          WHEN 2 THEN 220
          ELSE 200
        END AS volume_ml,
        CASE (i % 4)
          WHEN 0 THEN 35
          WHEN 1 THEN 42
          WHEN 2 THEN 5
          ELSE 365
        END AS shelf_life_days
      FROM generate_series($2::bigint, $3::bigint) AS series(i)
    )
    INSERT INTO ${hot}.blood_units
      (unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
       component_type, volume_ml, collected_on, expiry_date, status)
    SELECT
      generated.unit_id,
      generated.donation_id,
      CASE (generated.i % 2)
        WHEN 0 THEN $4::uuid
        ELSE $5::uuid
      END,
      donors.blood_group,
      donors.rh_factor,
      generated.component_type,
      generated.volume_ml,
      CURRENT_DATE - (generated.i % 30)::integer,
      CURRENT_DATE + generated.shelf_life_days,
      'AVAILABLE'::common.unit_status_t
    FROM generated
    JOIN ${hist}.donors donors
      ON donors.donor_id = md5(
        'dbbemn-large-donor:' || $1 || ':'
        || (((generated.i - 1) % $6::bigint) + 1)::text
      )::uuid
    ON CONFLICT (unit_id) DO NOTHING`;
  for (let start = 1; start <= unitsPerCity; start += batchSize) {
    const end = Math.min(start + batchSize - 1, unitsPerCity);
    await client.query(sql, [
      cityCode,
      start,
      end,
      bankIds[0],
      bankIds[1],
      donorsPerCity,
    ]);
  }
}

async function backfillReadModel(client, cityCode, hot, read) {
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

async function seedCity(cityCode) {
  const { hot, hist, read } = schemasFor(cityCode);
  const client = await connectWithRetry();
  try {
    await client.query("BEGIN");
    await insertDonors(client, cityCode, hist);
    await insertDonations(client, cityCode, hist);
    await insertUnits(client, cityCode, hot, hist);
    await backfillReadModel(client, cityCode, hot, read);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  await insertCatalogSeed();
  for (const cityCode of CITY_CODES) {
    process.stdout.write(
      `[seed:large] SIMULATED ${cityCode} donors=${donorsPerCity} units=${unitsPerCity}\n`,
    );
    await seedCity(cityCode);
  }

  for (const cityCode of CITY_CODES) {
    const { hot, hist, read } = schemasFor(cityCode);
    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM ${hist}.donors) AS donors,
         (SELECT count(*)::int FROM ${hist}.donations) AS donations,
         (SELECT count(*)::int FROM ${hot}.blood_units) AS units,
         (SELECT count(*)::int FROM ${read}.units_search) AS read_units`,
    );
    process.stdout.write(
      `[seed:large] ${cityCode} ${JSON.stringify(counts.rows[0])}\n`,
    );
  }
  process.stdout.write(
    `[seed:large] completed target donors/city=${donorsPerCity} units/city=${unitsPerCity}; seed rows are SIMULATED\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`[seed:large] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
