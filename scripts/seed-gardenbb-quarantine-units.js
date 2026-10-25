import { createHash } from "node:crypto";
import { cityScriptPool, catalogScriptPool, endAllScriptPools } from "./db.js";
import { schemasFor } from "../backend/src/db/shard-router.js";
import { invalidateCityInventory } from "../backend/src/cache/store.js";
import { cancelCreated, KIND, noteCreated, rememberCreated } from "../backend/src/services/presence.js";

const cityCode = "KHI";
const bankName = "gardenbb";
const donorCount = 18_902;
const defaultCount = 98_789;
const donationBatchSize = 500;
const unitsPerDonation = 3;
const sampleNote = "[SAMPLE DATA] GardenBB: synthetic quarantined demo unit; not real inventory and not eligible for screening or transfusion.";
const countIndex = process.argv.indexOf("--count");
const count = countIndex >= 0 ? Number(process.argv[countIndex + 1]) : defaultCount;
const apply = process.argv.includes("--apply");
const { hot, hist } = schemasFor(cityCode);
const catalog = catalogScriptPool();
const cityPool = cityScriptPool(cityCode);

function deterministicIds(kind, start, limit) {
  return Array.from({ length: limit }, (_, index) => {
    const digest = createHash("md5")
      .update(`gardenbb-synthetic-${kind}:${cityCode}:${start + index}`)
      .digest("hex");
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
  });
}

try {
  if (!Number.isInteger(count) || count < 1 || count > defaultCount) {
    throw new Error("--count must be a whole number from 1 to 98,789.");
  }

  const banks = await catalog.query(
    `SELECT blood_bank_id AS id, name
       FROM catalog.blood_banks
      WHERE lower(name) = $1 AND city_code = $2 AND is_active = TRUE`,
    [bankName, cityCode],
  );
  if (banks.rowCount !== 1) {
    throw new Error(`Expected exactly one active ${bankName} blood bank in ${cityCode}; found ${banks.rowCount}.`);
  }

  const donorCheck = await cityPool.query(
    `SELECT count(*) FILTER (WHERE d.full_name LIKE '[SYNTHETIC] GardenBB donor %')::int AS profiles
       FROM generate_series(1, $1::int) AS series(i)
       JOIN ${hist}.donors d
         ON d.donor_id = md5('gardenbb-synthetic-donor:${cityCode}:' || i::text)::uuid`,
    [donorCount],
  );
  if (donorCheck.rows[0].profiles !== donorCount) {
    throw new Error(`Expected ${donorCount} approved synthetic donor profiles; found ${donorCheck.rows[0].profiles}.`);
  }

  const existing = await cityPool.query(
    `SELECT
       count(DISTINCT d.donation_id)::int AS donations,
       count(u.unit_id)::int AS units,
       count(u.unit_id) FILTER (WHERE u.status = 'QUARANTINE')::int AS quarantined,
       count(u.unit_id) FILTER (WHERE u.status = 'AVAILABLE')::int AS available
     FROM ${hist}.donations d
     LEFT JOIN ${hot}.blood_units u ON u.donation_id = d.donation_id
     WHERE d.blood_bank_id = $1::uuid
       AND d.notes = $2
       AND d.collected_at >= CURRENT_DATE - 32
       AND d.collected_at < CURRENT_DATE - 30`,
    [banks.rows[0].id, sampleNote],
  );
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    bank: { name: banks.rows[0].name, city: cityCode, id: banks.rows[0].id },
    requestedSyntheticQuarantinedUnits: count,
    existingSyntheticUnits: existing.rows[0].units,
    existingSyntheticDonations: existing.rows[0].donations,
    expectedNewUnits: Math.max(0, count - existing.rows[0].units),
    safety: "Every unit will be synthetic separated-component demo stock in QUARANTINE, linked to a [SAMPLE DATA] donation; never available or reserveable.",
  }, null, 2));

  if (!apply) {
    console.log("Dry run only. Pass --apply to create the labeled quarantined demo inventory.");
  } else {
    let insertedUnits = 0;
    const donationCount = Math.ceil(count / unitsPerDonation);
    for (let donationStart = 1; donationStart <= donationCount; donationStart += donationBatchSize) {
      const batchDonations = Math.min(donationBatchSize, donationCount - donationStart + 1);
      const unitStart = (donationStart - 1) * unitsPerDonation + 1;
      const batchUnits = Math.min(count - unitStart + 1, batchDonations * unitsPerDonation);
      const donationIds = deterministicIds("donation", donationStart, batchDonations);
      const unitIds = deterministicIds("unit", unitStart, batchUnits);

      await noteCreated(KIND.DONATION, cityCode);
      await noteCreated(KIND.UNIT, cityCode);
      try {
        const client = await cityPool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `INSERT INTO ${hist}.donations
               (donation_id, donor_id, blood_bank_id, collected_at, volume_ml,
                screening_status, screened_at, notes)
             SELECT
               md5('gardenbb-synthetic-donation:${cityCode}:' || i::text)::uuid,
               md5('gardenbb-synthetic-donor:${cityCode}:'
                 || (((i - 1) % $2::int) + 1)::text)::uuid,
               $1::uuid,
               CURRENT_DATE - 31,
               450,
               'PENDING',
               NULL,
               $4
             FROM generate_series($3::int, $3::int + $5::int - 1) AS series(i)
             ON CONFLICT (donation_id) DO NOTHING`,
            [banks.rows[0].id, donorCount, donationStart, sampleNote, batchDonations],
          );
          const inserted = await client.query(
            `WITH generated AS (
               SELECT i,
                      ((i - 1) / $3::int) + 1 AS donation_index,
                      (i - 1) % $3::int AS component_index
                 FROM generate_series($2::int, $2::int + $4::int - 1) AS series(i)
             )
             INSERT INTO ${hot}.blood_units
               (unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
                component_type, volume_ml, collected_on, expiry_date, status)
             SELECT
               md5('gardenbb-synthetic-unit:${cityCode}:' || generated.i::text)::uuid,
               md5('gardenbb-synthetic-donation:${cityCode}:'
                 || (generated.donation_index + $5::int - 1)::text)::uuid,
               $1::uuid,
               donor.blood_group,
               donor.rh_factor,
               CASE generated.component_index
                 WHEN 0 THEN 'PRBC'::common.component_t
                 WHEN 1 THEN 'PLATELETS'::common.component_t
                 ELSE 'PLASMA'::common.component_t
               END,
               CASE generated.component_index WHEN 0 THEN 250 WHEN 1 THEN 220 ELSE 200 END,
               CURRENT_DATE - (generated.i % 3)::int,
               CURRENT_DATE - (generated.i % 3)::int
                 + CASE generated.component_index WHEN 0 THEN 42 WHEN 1 THEN 5 ELSE 365 END,
               'QUARANTINE'::common.unit_status_t
             FROM generated
             JOIN ${hist}.donors donor
               ON donor.donor_id = md5(
                 'gardenbb-synthetic-donor:${cityCode}:'
                 || (((generated.donation_index + $5::int - 2) % $3::int) + 1)::text
               )::uuid
             ON CONFLICT (unit_id) DO NOTHING`,
            [banks.rows[0].id, unitStart, unitsPerDonation, batchUnits, donationStart],
          );
          await client.query("COMMIT");
          insertedUnits += inserted.rowCount;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }

        await Promise.all([
          rememberCreated(KIND.DONATION, cityCode, donationIds),
          rememberCreated(KIND.UNIT, cityCode, unitIds),
          invalidateCityInventory(cityCode),
        ]);
      } catch (error) {
        await Promise.all([
          cancelCreated(KIND.DONATION, cityCode),
          cancelCreated(KIND.UNIT, cityCode),
        ]);
        throw error;
      }
      console.log(`[gardenbb] ${Math.min(unitStart + batchUnits - 1, count)}/${count} quarantined demo units committed`);
    }

    const verified = await cityPool.query(
      `SELECT count(DISTINCT d.donation_id)::int AS donations,
              count(u.unit_id)::int AS units,
              count(u.unit_id) FILTER (WHERE u.status = 'QUARANTINE')::int AS quarantined,
              count(u.unit_id) FILTER (WHERE u.status = 'AVAILABLE')::int AS available,
              count(u.unit_id) FILTER (WHERE u.blood_bank_id = $1::uuid)::int AS bank_units
         FROM ${hist}.donations d
         LEFT JOIN ${hot}.blood_units u ON u.donation_id = d.donation_id
        WHERE d.blood_bank_id = $1::uuid
          AND d.notes = $2
          AND d.collected_at >= CURRENT_DATE - 32
          AND d.collected_at < CURRENT_DATE - 30`,
      [banks.rows[0].id, sampleNote],
    );
    const totals = verified.rows[0];
    if (totals.units !== count || totals.quarantined !== count || totals.available !== 0 || totals.bank_units !== count) {
      throw new Error(`Verification mismatch after import: ${JSON.stringify(totals)}`);
    }
    console.log(JSON.stringify({
      completed: true,
      requestedUnits: count,
      inserted: insertedUnits,
      verified: totals,
      loginAccountsCreated: 0,
      safety: "All added units remain synthetic and quarantined; no live/searchable stock was created.",
    }, null, 2));
  }
} finally {
  await endAllScriptPools();
}
