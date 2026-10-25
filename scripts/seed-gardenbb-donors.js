import { cityScriptPool, catalogScriptPool, endAllScriptPools } from "./db.js";
import { schemasFor } from "../backend/src/db/shard-router.js";
import { cancelCreated, KIND, noteCreated, rememberCreated } from "../backend/src/services/presence.js";

const cityCode = "KHI";
const bankName = "gardenbb";
const defaultCount = 18_902;
const countIndex = process.argv.indexOf("--count");
const count = countIndex >= 0 ? Number(process.argv[countIndex + 1]) : defaultCount;
const apply = process.argv.includes("--apply");
const firstNames = [
  "Ayesha", "Fatima", "Zainab", "Hira", "Sana", "Mariam", "Iqra", "Noor",
  "Ali", "Ahmed", "Hassan", "Usman", "Bilal", "Hamza", "Fahad", "Saad",
];
const lastNames = [
  "Khan", "Ahmed", "Malik", "Sheikh", "Butt", "Qureshi", "Raza", "Javed",
  "Iqbal", "Farooq", "Siddiqui", "Chaudhry", "Abbasi", "Shah", "Baig", "Mirza",
];
const { hist } = schemasFor(cityCode);
const catalog = catalogScriptPool();
const cityPool = cityScriptPool(cityCode);

try {
  if (!Number.isInteger(count) || count < 1 || count > 18_902) {
    throw new Error("--count must be a whole number from 1 to 18,902.");
  }

  const banks = await catalog.query(
    `SELECT blood_bank_id
       FROM catalog.blood_banks
      WHERE lower(name) = $1 AND city_code = $2 AND is_active = TRUE`,
    [bankName, cityCode],
  );
  if (banks.rowCount !== 1) {
    throw new Error(`Expected exactly one active ${bankName} blood bank in ${cityCode}; found ${banks.rowCount}.`);
  }

  const idsResult = await cityPool.query(
    `SELECT array_agg(md5('gardenbb-synthetic-donor:${cityCode}:' || i::text)::uuid ORDER BY i) AS ids
       FROM generate_series(1, $1::int) AS series(i)`,
    [count],
  );
  const donorIds = idsResult.rows[0].ids;
  const existing = await cityPool.query(
    `SELECT count(*)::int AS count
       FROM ${hist}.donors
      WHERE donor_id = ANY($1::uuid[])`,
    [donorIds],
  );
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    bank: { name: bankName, city: cityCode, id: banks.rows[0].blood_bank_id },
    requestedSyntheticDonorProfiles: count,
    alreadyPresent: existing.rows[0].count,
    expectedNewProfiles: count - existing.rows[0].count,
    safety: "Synthetic profiles are visibly labeled, use non-routable phone placeholders, and have no login, donation, or inventory records.",
  }, null, 2));

  if (!apply) {
    console.log("Dry run only. Pass --apply to create the synthetic donor profiles.");
  } else {
    await noteCreated(KIND.DONOR, cityCode);
    let insertedIds;
    try {
      const client = await cityPool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query(
          `INSERT INTO ${hist}.donors
             (donor_id, full_name, phone, date_of_birth, sex, weight_kg,
              blood_group, rh_factor, city_code, last_donation_date, is_available)
           SELECT
             md5('gardenbb-synthetic-donor:${cityCode}:' || i::text)::uuid,
             '[SYNTHETIC] GardenBB donor ' || lpad(i::text, 5, '0') || ' - '
               || first_names[((i - 1) % cardinality(first_names)) + 1] || ' '
               || last_names[((i - 1) % cardinality(last_names)) + 1],
             '+92-SYNTH-' || lpad(i::text, 8, '0'),
             CURRENT_DATE - (6570 + (i % 17155))::int,
             CASE WHEN i % 2 = 0 THEN 'M' ELSE 'F' END,
             (55 + (i % 4000)::numeric / 100)::numeric(5,1),
             (ARRAY['O','A','B','AB'])[((i - 1) % 4) + 1]::common.blood_group_t,
             CASE WHEN i % 5 = 0 THEN 'NEG'::common.rh_t ELSE 'POS'::common.rh_t END,
             $1::char(3),
             CURRENT_DATE - (90 + (i % 276))::int,
             TRUE
           FROM generate_series(1, $2::int) AS series(i)
           CROSS JOIN (
             SELECT $3::text[] AS first_names, $4::text[] AS last_names
           ) AS names
           ON CONFLICT (donor_id) DO NOTHING
           RETURNING donor_id`,
          [cityCode, count, firstNames, lastNames],
        );
        insertedIds = inserted.rows.map((row) => row.donor_id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await cancelCreated(KIND.DONOR, cityCode);
      throw error;
    }

    await rememberCreated(KIND.DONOR, cityCode, insertedIds);
    console.log(JSON.stringify({
      completed: true,
      city: cityCode,
      requestedSyntheticDonorProfiles: count,
      inserted: insertedIds.length,
      alreadyPresent: count - insertedIds.length,
      loginAccountsCreated: 0,
      donationsCreated: 0,
      inventoryUnitsCreated: 0,
    }, null, 2));
  }
} finally {
  await endAllScriptPools();
}
