import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { CITY_CODES, schemasFor } from "../src/db/shard-router.js";
import { compatibleDonors } from "../src/utils/compatibility.js";
import { getCatalogPool, getPoolForCity } from "../src/db/registry.js";

const GROUPS = ["O", "A", "B", "AB"];
const RH_FACTORS = ["NEG", "POS"];
const COMPONENTS = ["WHOLE_BLOOD", "PRBC", "PLATELETS", "PLASMA"];
// T1 exercises common.compatible_donor and T2 writes shard rows, so both tests name
// their node explicitly. Routing them through one shared pool was only ever correct
// while a single database held every schema; in distributed mode it would run T2
// against whichever node DATABASE_URL happened to point at.
const cityCode = CITY_CODES[0];
const cityPool = getPoolForCity(cityCode);
const ABO_RH_ORDER = new Map(
  GROUPS.flatMap((group, groupIndex) =>
    RH_FACTORS.map((rh, rhIndex) => [`${group}:${rh}`, groupIndex * 2 + rhIndex]),
  ),
);

const EXPECTED_PRBC = Object.freeze({
  "O-": ["O-"],
  "O+": ["O-", "O+"],
  "A-": ["O-", "A-"],
  "A+": ["O-", "O+", "A-", "A+"],
  "B-": ["O-", "B-"],
  "B+": ["O-", "O+", "B-", "B+"],
  "AB-": ["O-", "A-", "B-", "AB-"],
  "AB+": ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"],
});

const STATUS_ORDER = [
  "QUARANTINE",
  "AVAILABLE",
  "RESERVED",
  "DISPATCHED",
  "TRANSFUSED",
  "EXPIRED",
  "DISCARDED",
];
const ALLOWED_TRANSITIONS = Object.freeze({
  QUARANTINE: ["AVAILABLE", "DISCARDED"],
  AVAILABLE: ["RESERVED", "EXPIRED", "DISCARDED"],
  RESERVED: ["AVAILABLE", "DISPATCHED", "EXPIRED", "DISCARDED"],
  DISPATCHED: ["TRANSFUSED", "QUARANTINE"],
  TRANSFUSED: [],
  EXPIRED: [],
  DISCARDED: [],
});

function pairLabel({ group, rh }) {
  return `${group}${rh === "POS" ? "+" : "-"}`;
}

function sortedPairs(pairs) {
  return pairs.sort(
    (left, right) =>
      ABO_RH_ORDER.get(`${left.group}:${left.rh}`) -
      ABO_RH_ORDER.get(`${right.group}:${right.rh}`),
  );
}

function routeToStatus(targetStatus) {
  const queue = [["QUARANTINE"]];
  const visited = new Set();

  while (queue.length > 0) {
    const path = queue.shift();
    const current = path[path.length - 1];
    if (current === targetStatus) return path;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of ALLOWED_TRANSITIONS[current]) queue.push([...path, next]);
  }
  throw new Error(`No legal route to status ${targetStatus}.`);
}

after(async () => {
  // Only the pools this file opened, and only once: in single mode the catalog and
  // city lookups are the same object, so ending it twice would throw.
  for (const target of new Set([getCatalogPool(), cityPool])) {
    await target.end().catch(() => {});
  }
});

test("T1: SQL and JavaScript compatibility agree for all 8 × 4 combinations", async () => {
  let checkedCases = 0;

  for (const group of GROUPS) {
    for (const rh of RH_FACTORS) {
      for (const component of COMPONENTS) {
        const result = await getCatalogPool().query(
          `SELECT g::text AS "group", r::text AS rh
           FROM common.compatible_donor($1::common.blood_group_t,
                                       $2::common.rh_t,
                                       $3::common.component_t)`,
          [group, rh, component],
        );
        const sqlPairs = sortedPairs(
          result.rows.map(({ group: donorGroup, rh: donorRh }) => ({
            group: donorGroup,
            rh: donorRh,
          })),
        );
        const jsPairs = sortedPairs(compatibleDonors(group, rh, component));

        assert.deepEqual(sqlPairs, jsPairs, `${group}${rh} ${component}`);
        if (component === "PRBC") {
          assert.deepEqual(
            sqlPairs.map(pairLabel),
            EXPECTED_PRBC[`${group}${rh === "POS" ? "+" : "-"}`],
          );
        } else {
          assert.deepEqual(sqlPairs.map(pairLabel), [
            `${group}${rh === "POS" ? "+" : "-"}`,
          ]);
        }
        checkedCases += 1;
      }
    }
  }

  assert.equal(checkedCases, 32);
  process.stdout.write(`[test] T1 passed: ${checkedCases} SQL/JS cases; all 8 PRBC rows asserted\n`);
});

test("T2: PostgreSQL rejects every illegal blood-unit status transition", async () => {
  const { hot, hist } = schemasFor(cityCode);
  const client = await cityPool.connect();
  const donorId = randomUUID();
  const donationId = randomUUID();
  const bloodBankId = randomUUID();
  let rejectedTransitions = 0;

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO ${hist}.donors
         (donor_id, full_name, phone, date_of_birth, sex, weight_kg,
          blood_group, rh_factor, city_code)
       VALUES ($1, 'State Test Donor', '000', DATE '1990-01-01', 'M', 70,
               'O', 'NEG', $2)`,
      [donorId, cityCode],
    );
    await client.query(
      `INSERT INTO ${hist}.donations
         (donation_id, donor_id, blood_bank_id, volume_ml)
       VALUES ($1, $2, $3, 450)`,
      [donationId, donorId, bloodBankId],
    );

    for (const sourceStatus of STATUS_ORDER) {
      const unitId = randomUUID();
      await client.query(
        `INSERT INTO ${hot}.blood_units
           (unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
            component_type, volume_ml, collected_on, expiry_date)
         VALUES ($1, $2, $3, 'O', 'NEG', 'PRBC', 250,
                 CURRENT_DATE - 1, CURRENT_DATE + 41)`,
        [unitId, donationId, bloodBankId],
      );

      const legalPath = routeToStatus(sourceStatus);
      for (const nextStatus of legalPath.slice(1)) {
        await client.query(
          `UPDATE ${hot}.blood_units SET status = $1 WHERE unit_id = $2`,
          [nextStatus, unitId],
        );
      }

      for (const targetStatus of STATUS_ORDER) {
        if (
          targetStatus === sourceStatus ||
          ALLOWED_TRANSITIONS[sourceStatus].includes(targetStatus)
        ) {
          continue;
        }

        await client.query("SAVEPOINT illegal_status_transition");
        let transitionError;
        try {
          await client.query(
            `UPDATE ${hot}.blood_units SET status = $1 WHERE unit_id = $2`,
            [targetStatus, unitId],
          );
        } catch (error) {
          transitionError = error;
          await client.query("ROLLBACK TO SAVEPOINT illegal_status_transition");
        }
        await client.query("RELEASE SAVEPOINT illegal_status_transition");

        assert.ok(transitionError, `${sourceStatus} -> ${targetStatus} unexpectedly succeeded`);
        assert.equal(transitionError.code, "23514");
        assert.equal(transitionError.constraint, "ck_blood_unit_status_transition");
        rejectedTransitions += 1;
      }
    }

    await client.query("ROLLBACK");
    assert.equal(rejectedTransitions, 31);
    process.stdout.write(`[test] T2 passed: ${rejectedTransitions} illegal transitions rejected by trigger\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});