import { createRequire } from "node:module";
import { cityScriptPool, catalogScriptPool, endAllScriptPools } from "./db.js";
import { schemasFor } from "../backend/src/db/shard-router.js";
import { EVENT_TYPES, publish } from "../backend/src/lib/bus.js";
import { invalidateCityInventory } from "../backend/src/cache/store.js";
import { cancelCreated, KIND, noteCreated, rememberCreated } from "../backend/src/services/presence.js";

const require = createRequire(new URL("../backend/src/routes/catalog.js", import.meta.url));
const bcrypt = require("bcryptjs");
const cityCode = "KHI";
const bankName = "gardenbb";
const defaultCount = 1500;
const countIndex = process.argv.indexOf("--count");
const count = countIndex >= 0 ? Number(process.argv[countIndex + 1]) : defaultCount;
const apply = process.argv.includes("--apply");
const password = process.env.DONOR_DEFAULT_PASSWORD;
const firstNames = [
  "Ayesha", "Fatima", "Zainab", "Hira", "Sana", "Mariam", "Iqra", "Noor",
  "Ali", "Ahmed", "Hassan", "Usman", "Bilal", "Hamza", "Fahad", "Saad",
];
const lastNames = [
  "Khan", "Ahmed", "Malik", "Sheikh", "Butt", "Qureshi", "Raza", "Javed",
  "Iqbal", "Farooq", "Siddiqui", "Chaudhry", "Abbasi", "Shah", "Baig", "Mirza",
];
const { hot, hist } = schemasFor(cityCode);

function validCount(value) {
  return Number.isInteger(value) && value >= 1000 && value <= 3000;
}

async function inTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const catalog = catalogScriptPool();
const cityPool = cityScriptPool(cityCode);

try {
  if (!validCount(count)) throw new Error("--count must be a whole number from 1,000 to 3,000.");
  if (apply && (!password || password.length < 8 || Buffer.byteLength(password, "utf8") > 72)) {
    throw new Error("Set DONOR_DEFAULT_PASSWORD (8–72 UTF-8 bytes) before applying the sample data.");
  }

  const banks = await catalog.query(
    `SELECT blood_bank_id AS id, name, city_code AS city
     FROM catalog.blood_banks
     WHERE lower(name) = $1 AND city_code = $2 AND is_active = TRUE`,
    [bankName, cityCode],
  );
  if (banks.rowCount !== 1) {
    throw new Error(`Expected exactly one active ${bankName} blood bank in ${cityCode}; found ${banks.rowCount}.`);
  }
  const bank = banks.rows[0];
  const before = await cityPool.query(
    `SELECT
       count(*) FILTER (WHERE d.notes LIKE '[SAMPLE DATA] Gardenbb:%')::int AS sample_donations,
       count(*) FILTER (WHERE u.status = 'QUARANTINE')::int AS bank_quarantined
     FROM ${hist}.donations d
     LEFT JOIN ${hot}.blood_units u ON u.donation_id = d.donation_id
     WHERE d.blood_bank_id = $1`,
    [bank.id],
  );

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    bank: { name: bank.name, city: bank.city, id: bank.id },
    requestedSamples: count,
    existingSampleDonations: before.rows[0].sample_donations,
    note: "Sample donors are unavailable and sample units remain quarantined; they are not bookable stock.",
  }, null, 2));
  if (!apply) {
    console.log("Dry run only. Pass --apply to create the idempotent Gardenbb sample records.");
  } else {
    const ids = await cityPool.query(
      `SELECT
         array_agg(md5('gardenbb-sample-donor:${cityCode}:' || i::text)::uuid ORDER BY i) AS donors,
         array_agg(md5('gardenbb-sample-donation:${cityCode}:' || i::text)::uuid ORDER BY i) AS donations,
         array_agg(md5('gardenbb-sample-unit:${cityCode}:' || i::text)::uuid ORDER BY i) AS units
       FROM generate_series(1, $1::int) AS series(i)`,
      [count],
    );

    for (const kind of [KIND.DONOR, KIND.DONATION, KIND.UNIT]) await noteCreated(kind, cityCode);
    try {
      await inTransaction(cityPool, async (client) => {
        await client.query(
          `INSERT INTO ${hist}.donors
             (donor_id, full_name, phone, date_of_birth, sex, weight_kg,
              blood_group, rh_factor, city_code, last_donation_date, is_available)
           SELECT
             md5('gardenbb-sample-donor:${cityCode}:' || i::text)::uuid,
             '[SAMPLE] ' || first_names[((i - 1) % cardinality(first_names)) + 1]
               || ' ' || last_names[((i - 1) % cardinality(last_names)) + 1]
               || ' - Gardenbb ' || lpad(i::text, 4, '0'),
             '+92-SAMPLE-' || lpad(i::text, 8, '0'),
             CURRENT_DATE - (7300 + (i % 7300))::int,
             CASE WHEN i % 2 = 0 THEN 'M' ELSE 'F' END,
             (55 + (i % 3600)::numeric / 100)::numeric(5,1),
             (ARRAY['O','A','B','AB'])[((i - 1) % 4) + 1]::common.blood_group_t,
             CASE WHEN i % 10 < 2 THEN 'NEG'::common.rh_t ELSE 'POS'::common.rh_t END,
             $1::char(3),
             CURRENT_DATE - (90 + (i % 180))::int,
             FALSE
           FROM generate_series(1, $2::int) AS series(i)
           CROSS JOIN (SELECT $3::text[] AS first_names, $4::text[] AS last_names) AS names
           ON CONFLICT (donor_id) DO NOTHING`,
          [cityCode, count, firstNames, lastNames],
        );
        await client.query(
          `INSERT INTO ${hist}.donations
             (donation_id, donor_id, blood_bank_id, collected_at, volume_ml,
              screening_status, screened_at, notes)
           SELECT
             md5('gardenbb-sample-donation:${cityCode}:' || i::text)::uuid,
             md5('gardenbb-sample-donor:${cityCode}:' || i::text)::uuid,
             $1::uuid,
             now() - ((i % 3)::text || ' days')::interval,
             450,
             'PENDING',
             NULL,
             '[SAMPLE DATA] Gardenbb: synthetic display record; not a real donation and not for transfusion.'
           FROM generate_series(1, $2::int) AS series(i)
           ON CONFLICT (donation_id) DO NOTHING`,
          [bank.id, count],
        );
        await client.query(
          `WITH generated AS (
             SELECT
               i,
               md5('gardenbb-sample-unit:${cityCode}:' || i::text)::uuid AS unit_id,
               md5('gardenbb-sample-donation:${cityCode}:' || i::text)::uuid AS donation_id,
               CASE i % 4
                 WHEN 0 THEN 'WHOLE_BLOOD'::common.component_t
                 WHEN 1 THEN 'PRBC'::common.component_t
                 WHEN 2 THEN 'PLATELETS'::common.component_t
                 ELSE 'PLASMA'::common.component_t
               END AS component_type,
               CASE i % 4 WHEN 0 THEN 450 WHEN 1 THEN 250 WHEN 2 THEN 220 ELSE 200 END AS volume_ml,
               CASE i % 4 WHEN 0 THEN 35 WHEN 1 THEN 42 WHEN 2 THEN 5 ELSE 365 END AS shelf_days
             FROM generate_series(1, $2::int) AS series(i)
           )
           INSERT INTO ${hot}.blood_units
             (unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
              component_type, volume_ml, collected_on, expiry_date, status)
           SELECT
             generated.unit_id, generated.donation_id, $1::uuid,
             donor.blood_group, donor.rh_factor,
             generated.component_type, generated.volume_ml,
             CURRENT_DATE - (generated.i % 3)::int,
             CURRENT_DATE - (generated.i % 3)::int + generated.shelf_days,
             'QUARANTINE'::common.unit_status_t
           FROM generated
           JOIN ${hist}.donors donor
             ON donor.donor_id = md5('gardenbb-sample-donor:${cityCode}:' || generated.i::text)::uuid
           ON CONFLICT (unit_id) DO NOTHING`,
          [bank.id, count],
        );
      });
    } catch (error) {
      for (const kind of [KIND.DONOR, KIND.DONATION, KIND.UNIT]) await cancelCreated(kind, cityCode);
      throw error;
    }

    await inTransaction(catalog, async (client) => {
      const passwordHash = await bcrypt.hash(password, 12);
      await client.query(
        `INSERT INTO catalog.users
           (username, email, password_hash, role, donor_id, donor_city_code)
         SELECT
           'gardenbb-sample-' || lpad(i::text, 4, '0'),
           'gardenbb-sample-' || lpad(i::text, 4, '0') || '@donors.example.test',
           $2, 'DONOR',
           md5('gardenbb-sample-donor:${cityCode}:' || i::text)::uuid,
           $1::char(3)
         FROM generate_series(1, $3::int) AS series(i)
         ON CONFLICT DO NOTHING`,
        [cityCode, passwordHash, count],
      );
    });

    await Promise.all([
      rememberCreated(KIND.DONOR, cityCode, ids.rows[0].donors),
      rememberCreated(KIND.DONATION, cityCode, ids.rows[0].donations),
      rememberCreated(KIND.UNIT, cityCode, ids.rows[0].units),
      invalidateCityInventory(cityCode),
    ]);
    publish(EVENT_TYPES.DONATION_CREATED, { cityCode, bloodBankId: bank.id, units: count, sampleData: true });

    const after = await cityPool.query(
      `SELECT
         count(DISTINCT d.donation_id)::int AS donations,
         count(u.unit_id)::int AS units,
         count(u.unit_id) FILTER (WHERE u.status = 'QUARANTINE')::int AS quarantined,
         count(u.unit_id) FILTER (WHERE u.status = 'AVAILABLE')::int AS available,
         count(DISTINCT d.donor_id)::int AS donors
       FROM ${hist}.donations d
       LEFT JOIN ${hot}.blood_units u ON u.donation_id = d.donation_id
       WHERE d.blood_bank_id = $1
         AND d.notes LIKE '[SAMPLE DATA] Gardenbb:%'`,
      [bank.id],
    );
    const linkedAccounts = await catalog.query(
      `SELECT count(*)::int AS accounts FROM catalog.users
       WHERE role = 'DONOR' AND donor_city_code = $1::char(3)
         AND username LIKE 'gardenbb-sample-%'`,
      [cityCode],
    );
    console.log(JSON.stringify({
      completed: true,
      bank: bank.name,
      sampleRecords: after.rows[0],
      linkedDonorAccounts: linkedAccounts.rows[0].accounts,
      sharedDemoPassword: "same value configured as DONOR_DEFAULT_PASSWORD for this run",
      safety: "All donors unavailable; all units quarantined; sample donations cannot pass screening.",
    }, null, 2));
  }
} finally {
  await endAllScriptPools();
}
