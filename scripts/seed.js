import { CITY_CODES, schemasFor } from "../backend/src/db/shard-router.js";
import { connectWithRetry, pool, withClient } from "./db.js";

const CITY_SEED = Object.freeze({
  KHI: {
    banks: [
      ["10000000-0000-4000-8000-000000000001", "Karachi Central Blood Bank", "Saddar, Karachi", 24.8611, 67.0099],
      ["10000000-0000-4000-8000-000000000002", "Karachi East Blood Centre", "Gulshan-e-Iqbal, Karachi", 24.9213, 67.0920],
    ],
    hospitals: [
      ["20000000-0000-4000-8000-000000000001", "Jinnah Emergency Hospital", "Rafiqui Shaheed Road", 24.8534, 67.0430],
      ["20000000-0000-4000-8000-000000000002", "North District Medical Centre", "Gulshan-e-Iqbal", 24.9220, 67.0870],
      ["20000000-0000-4000-8000-000000000003", "Harbour General Hospital", "Clifton", 24.8138, 67.0305],
    ],
  },
  LHE: {
    banks: [
      ["10000000-0000-4000-8000-000000000003", "Lahore Central Blood Bank", "Jail Road, Lahore", 31.5497, 74.3436],
      ["10000000-0000-4000-8000-000000000004", "Lahore South Blood Centre", "Model Town, Lahore", 31.4830, 74.3250],
    ],
    hospitals: [
      ["20000000-0000-4000-8000-000000000004", "Mayo Emergency Hospital", "Anarkali, Lahore", 31.5715, 74.3070],
      ["20000000-0000-4000-8000-000000000005", "Garden Town Medical Centre", "Garden Town", 31.5080, 74.3240],
      ["20000000-0000-4000-8000-000000000006", "Lahore North General", "Shadman", 31.5410, 74.3330],
    ],
  },
  ISB: {
    banks: [
      ["10000000-0000-4000-8000-000000000005", "Islamabad Central Blood Bank", "G-8, Islamabad", 33.6938, 73.0652],
      ["10000000-0000-4000-8000-000000000006", "Capital Blood Centre", "F-8, Islamabad", 33.7100, 73.0580],
    ],
    hospitals: [
      ["20000000-0000-4000-8000-000000000007", "Capital Emergency Hospital", "G-8, Islamabad", 33.6950, 73.0580],
      ["20000000-0000-4000-8000-000000000008", "Margalla Medical Centre", "F-10, Islamabad", 33.6900, 73.0100],
      ["20000000-0000-4000-8000-000000000009", "Islamabad South Hospital", "I-8, Islamabad", 33.6650, 73.0750],
    ],
  },
});

const DONOR_SEED = Object.freeze({
  KHI: [
    {
      donorId: "30000000-0000-4000-8000-000000000001",
      donationId: "40000000-0000-4000-8000-000000000001",
      bankId: CITY_SEED.KHI.banks[0][0],
      name: "Demo Donor KHI O",
      group: "O",
      rh: "NEG",
      sex: "M",
      weight: 72,
    },
    {
      donorId: "30000000-0000-4000-8000-000000000002",
      donationId: "40000000-0000-4000-8000-000000000002",
      bankId: CITY_SEED.KHI.banks[1][0],
      name: "Demo Donor KHI A",
      group: "A",
      rh: "POS",
      sex: "F",
      weight: 64,
    },
  ],
  LHE: [
    {
      donorId: "30000000-0000-4000-8000-000000000003",
      donationId: "40000000-0000-4000-8000-000000000003",
      bankId: CITY_SEED.LHE.banks[0][0],
      name: "Demo Donor LHE O",
      group: "O",
      rh: "NEG",
      sex: "M",
      weight: 75,
    },
    {
      donorId: "30000000-0000-4000-8000-000000000004",
      donationId: "40000000-0000-4000-8000-000000000004",
      bankId: CITY_SEED.LHE.banks[1][0],
      name: "Demo Donor LHE A",
      group: "A",
      rh: "POS",
      sex: "F",
      weight: 61,
    },
  ],
  ISB: [
    {
      donorId: "30000000-0000-4000-8000-000000000005",
      donationId: "40000000-0000-4000-8000-000000000005",
      bankId: CITY_SEED.ISB.banks[0][0],
      name: "Demo Donor ISB O",
      group: "O",
      rh: "NEG",
      sex: "M",
      weight: 78,
    },
    {
      donorId: "30000000-0000-4000-8000-000000000006",
      donationId: "40000000-0000-4000-8000-000000000006",
      bankId: CITY_SEED.ISB.banks[1][0],
      name: "Demo Donor ISB A",
      group: "A",
      rh: "POS",
      sex: "F",
      weight: 66,
    },
  ],
});

const COMPONENTS = Object.freeze([
  { type: "PRBC", volume: 250, shelfLifeDays: 42 },
  { type: "PLATELETS", volume: 220, shelfLifeDays: 5 },
]);

async function insertCatalogSeed(client) {
  for (const cityCode of CITY_CODES) {
    const city = CITY_SEED[cityCode];
    for (const [bankId, name, address, latitude, longitude] of city.banks) {
      await client.query(
        `INSERT INTO catalog.blood_banks
           (blood_bank_id, name, city_code, address, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (blood_bank_id) DO NOTHING`,
        [bankId, name, cityCode, address, latitude, longitude],
      );
    }
    for (const [hospitalId, name, address, latitude, longitude] of city.hospitals) {
      await client.query(
        `INSERT INTO catalog.hospitals
           (hospital_id, name, city_code, address, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (hospital_id) DO NOTHING`,
        [hospitalId, name, cityCode, address, latitude, longitude],
      );
    }
  }
}

async function seedCity(client, cityCode) {
  const { hot, hist } = schemasFor(cityCode);

  for (const donor of DONOR_SEED[cityCode]) {
    await client.query(
      `INSERT INTO ${hist}.donors
         (donor_id, full_name, phone, date_of_birth, sex, weight_kg,
          blood_group, rh_factor, city_code, last_donation_date, is_available)
       VALUES ($1, $2, $3, DATE '1990-01-01', $4, $5, $6, $7, $8,
               CURRENT_DATE - 3, TRUE)
       ON CONFLICT (donor_id) DO NOTHING`,
      [donor.donorId, donor.name, "+92-000-0000000", donor.sex, donor.weight, donor.group, donor.rh, cityCode],
    );

    await client.query(
      `INSERT INTO ${hist}.donations
         (donation_id, donor_id, blood_bank_id, collected_at, volume_ml,
          screening_status, screened_at, notes)
       VALUES ($1, $2, $3, now() - interval '3 days', 450,
               'PASSED', now() - interval '3 days', 'Development demo seed')
       ON CONFLICT (donation_id) DO NOTHING`,
      [donor.donationId, donor.donorId, donor.bankId],
    );

    for (let componentIndex = 0; componentIndex < COMPONENTS.length; componentIndex += 1) {
      const component = COMPONENTS[componentIndex];
      const unitId = `50000000-0000-4000-8000-${String(CITY_CODES.indexOf(cityCode) * 4 + DONOR_SEED[cityCode].indexOf(donor) * 2 + componentIndex + 1).padStart(12, "0")}`;
      await client.query(
        `INSERT INTO ${hot}.blood_units
           (unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
            component_type, volume_ml, collected_on, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 CURRENT_DATE - 3, CURRENT_DATE - 3 + $8::int)
         ON CONFLICT (unit_id) DO NOTHING`,
        [
          unitId,
          donor.donationId,
          donor.bankId,
          donor.group,
          donor.rh,
          component.type,
          component.volume,
          component.shelfLifeDays,
        ],
      );
      await client.query(
        `UPDATE ${hot}.blood_units
         SET status = 'AVAILABLE'
         WHERE unit_id = $1 AND status = 'QUARANTINE'`,
        [unitId],
      );
    }
  }
}

async function main() {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await insertCatalogSeed(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  // Why: city-specific seed transactions mirror the app's single-city write
  // rule and keep the demo seed safe to rerun using deterministic identifiers.
  for (const cityCode of CITY_CODES) {
    const client = await connectWithRetry();
    try {
      await client.query("BEGIN");
      await seedCity(client, cityCode);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  for (const cityCode of CITY_CODES) {
    const { hot, hist } = schemasFor(cityCode);
    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM ${hist}.donors) AS donors,
         (SELECT count(*)::int FROM ${hist}.donations) AS donations,
         (SELECT count(*)::int FROM ${hot}.blood_units) AS units,
         (SELECT count(*)::int FROM ${hot}.blood_units WHERE status = 'AVAILABLE') AS available_units`,
    );
    process.stdout.write(`[seed:small] ${cityCode} ${JSON.stringify(counts.rows[0])}\n`);
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[seed:small] failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });