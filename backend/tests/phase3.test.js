import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import app from "../src/app.js";
import { pool, waitForDatabase } from "../src/db/pool.js";
import { schemasFor } from "../src/db/shard-router.js";
import { sweepCity } from "../src/jobs/maintenance.js";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const testPassword = "Phase3-Test-Password-Only";
const unitIds = [];
const donorIds = [];
const donationIds = [];
const requestIds = [];
let parkedUnits = [];
let hospitalId;
let bankId;
let hospitalToken;
let bankToken;
let server;
let baseUrl;

async function request(path, { method = "GET", token = hospitalToken, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : null };
}

async function createAvailableUnits(count, bloodGroup = "O", rh = "NEG") {
  const { hot, hist } = schemasFor("KHI");
  const result = await pool.query(
    `WITH donors AS (
       INSERT INTO ${hist}.donors
         (full_name, phone, date_of_birth, sex, weight_kg,
          blood_group, rh_factor, city_code)
       SELECT 'Phase 3 Fixture ' || i, '+92-300-' || lpad(i::text, 7, '0'),
              '1990-01-01'::date, 'F', 62, $2::common.blood_group_t,
              $3::common.rh_t, 'KHI'
       FROM generate_series(1, $1::int) AS i
       RETURNING donor_id, blood_group, rh_factor
     ), donations AS (
       INSERT INTO ${hist}.donations (donor_id, blood_bank_id, volume_ml, screening_status)
       SELECT donor_id, $4::uuid, 450, 'PASSED' FROM donors
       RETURNING donation_id, donor_id
     )
     INSERT INTO ${hot}.blood_units
       (donation_id, blood_bank_id, blood_group, rh_factor, component_type,
        volume_ml, collected_on, expiry_date, status)
     SELECT d.donation_id, $4::uuid, $2::common.blood_group_t,
            $3::common.rh_t, 'PRBC', 250, CURRENT_DATE,
            CURRENT_DATE + 42, 'AVAILABLE'
     FROM donations d
     RETURNING unit_id, donation_id`,
    [count, bloodGroup, rh, bankId],
  );
  unitIds.push(...result.rows.map((row) => row.unit_id));
  donationIds.push(...result.rows.map((row) => row.donation_id));
  const donorResult = await pool.query(
    `SELECT donor_id FROM ${hist}.donations WHERE donation_id = ANY($1::uuid[])`,
    [result.rows.map((row) => row.donation_id)],
  );
  donorIds.push(...donorResult.rows.map((row) => row.donor_id));
  return result.rows.map((row) => row.unit_id);
}

function reservationBody(overrides = {}) {
  const requestId = randomUUID();
  requestIds.push(requestId);
  return {
    requestId,
    hospitalId,
    patientBloodGroup: "O",
    patientRh: "NEG",
    component: "PRBC",
    unitsNeeded: 1,
    urgency: "ROUTINE",
    allowPartial: false,
    searchScope: "LOCAL_FIRST",
    ...overrides,
  };
}

async function reserve(body, token = hospitalToken) {
  return request("/reservations", { method: "POST", token, body });
}

before(async () => {
  await waitForDatabase();
  const hospital = await pool.query(
    `INSERT INTO catalog.hospitals (name, city_code, latitude, longitude)
     VALUES ($1, 'KHI', 24.860700, 67.001100)
     RETURNING hospital_id`,
    [`Phase3 Hospital ${suffix}`],
  );
  hospitalId = hospital.rows[0].hospital_id;
  const bank = await pool.query(
    `INSERT INTO catalog.blood_banks (name, city_code)
     VALUES ($1, 'KHI')
     RETURNING blood_bank_id`,
    [`Phase3 Blood Bank ${suffix}`],
  );
  bankId = bank.rows[0].blood_bank_id;
  const passwordHash = await bcrypt.hash(testPassword, 4);
  await pool.query(
    `INSERT INTO catalog.users (username, email, password_hash, role, hospital_id)
     VALUES ($1, $2, $3, 'HOSPITAL_ADMIN', $4)`,
    [`phase3-hospital-${suffix}`, `phase3-hospital-${suffix}@example.test`, passwordHash, hospitalId],
  );
  await pool.query(
    `INSERT INTO catalog.users (username, email, password_hash, role, blood_bank_id)
     VALUES ($1, $2, $3, 'BLOODBANK_ADMIN', $4)`,
    [`phase3-bank-${suffix}`, `phase3-bank-${suffix}@example.test`, passwordHash, bankId],
  );

  // Why: the small seed leaves one O NEG PRBC unit AVAILABLE in KHI. Every
  // contention assertion below counts exact candidate totals, so park the
  // seeded matches up front and let teardown put them back. Parking backdates
  // expiry_date instead of moving the status, because the shard trigger only
  // allows AVAILABLE -> RESERVED/EXPIRED/DISCARDED.
  const { hot } = schemasFor("KHI");
  // Why: a previously interrupted run can strand a seeded unit in
  // RESERVED/DISPATCHED with no live reservation, because the seed only resets
  // QUARANTINE units. Release those first so the shard starts from a state that
  // satisfies invariant I2.
  await pool.query(
    `UPDATE ${hot}.blood_units u
     SET status = CASE WHEN u.expiry_date > CURRENT_DATE
                       THEN 'AVAILABLE'::common.unit_status_t
                       ELSE 'EXPIRED'::common.unit_status_t END
     WHERE u.status IN ('RESERVED', 'DISPATCHED')
       AND NOT EXISTS (
         SELECT 1 FROM ${hot}.reservations r
         WHERE r.unit_id = u.unit_id AND r.status IN ('ACTIVE', 'DISPATCHED')
       )`,
  );
  parkedUnits = (
    await pool.query(
      `SELECT unit_id, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
       FROM ${hot}.blood_units
       WHERE status = 'AVAILABLE'
         AND blood_group = 'O' AND rh_factor = 'NEG'
         AND component_type = 'PRBC'
         AND expiry_date > CURRENT_DATE`,
    )
  ).rows;
  if (parkedUnits.length > 0) {
    await pool.query(
      `UPDATE ${hot}.blood_units
       SET expiry_date = CURRENT_DATE - 1
       WHERE unit_id = ANY($1::uuid[])`,
      [parkedUnits.map((row) => row.unit_id)],
    );
  }

  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  const hospitalLogin = await request("/auth/login", {
    method: "POST",
    token: null,
    body: { login: `phase3-hospital-${suffix}`, password: testPassword },
  });
  assert.equal(hospitalLogin.response.status, 200);
  hospitalToken = hospitalLogin.data.accessToken;
  const bankLogin = await request("/auth/login", {
    method: "POST",
    token: null,
    body: { login: `phase3-bank-${suffix}`, password: testPassword },
  });
  assert.equal(bankLogin.response.status, 200);
  bankToken = bankLogin.data.accessToken;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  const { hot, hist } = schemasFor("KHI");
  await pool.query(
    `DELETE FROM ${hot}.reservations WHERE request_id = ANY($1::uuid[])`,
    [requestIds],
  );
  await pool.query(
    `DELETE FROM ${hot}.processed_requests WHERE request_id = ANY($1::uuid[])`,
    [requestIds],
  );
  await pool.query(`DELETE FROM ${hist}.transfusions WHERE unit_id = ANY($1::uuid[])`, [unitIds]);
  await pool.query(`DELETE FROM ${hist}.unit_status_log WHERE unit_id = ANY($1::uuid[])`, [unitIds]);
  await pool.query(`DELETE FROM ${hot}.outbox WHERE unit_id = ANY($1::uuid[])`, [unitIds]);
  await pool.query(`DELETE FROM ${hot}.blood_units WHERE unit_id = ANY($1::uuid[])`, [unitIds]);
  for (const row of parkedUnits) {
    await pool.query(`UPDATE ${hot}.blood_units SET expiry_date = $2 WHERE unit_id = $1`, [
      row.unit_id,
      row.expiry_date,
    ]);
  }
  // Why: teardown drops this test's reservations, which strands every unit they
  // touched - including the parked seeded unit - in RESERVED/DISPATCHED with no
  // live reservation. Releasing them keeps invariant I2 true and the next run
  // reproducible.
  await pool.query(
    `UPDATE ${hot}.blood_units u
     SET status = CASE WHEN u.expiry_date > CURRENT_DATE
                       THEN 'AVAILABLE'::common.unit_status_t
                       ELSE 'EXPIRED'::common.unit_status_t END
     WHERE u.status IN ('RESERVED', 'DISPATCHED')
       AND NOT EXISTS (
         SELECT 1 FROM ${hot}.reservations r
         WHERE r.unit_id = u.unit_id AND r.status IN ('ACTIVE', 'DISPATCHED')
       )`,
  );
  await pool.query(`DELETE FROM ${hist}.donations WHERE donation_id = ANY($1::uuid[])`, [donationIds]);
  await pool.query(`DELETE FROM ${hist}.donors WHERE donor_id = ANY($1::uuid[])`, [donorIds]);
  await pool.query(
    `DELETE FROM catalog.users WHERE username = ANY($1::text[])`,
    [[`phase3-hospital-${suffix}`, `phase3-bank-${suffix}`]],
  );
  await pool.query("DELETE FROM catalog.hospitals WHERE hospital_id = $1", [hospitalId]);
  await pool.query("DELETE FROM catalog.blood_banks WHERE blood_bank_id = $1", [bankId]);
  await pool.end();
});

test("Phase 3: contention, auto-match, idempotency, hold expiry, and 500 random sequences", {
  timeout: 300_000,
}, async () => {
  const raceUnit = (await createAvailableUnits(1))[0];
  const raceBodies = Array.from({ length: 200 }, () => reservationBody());
  const raceResults = await Promise.all(raceBodies.map((body) => reserve(body)));
  assert.equal(raceResults.filter((item) => item.response.status === 200).length, 1);
  assert.equal(raceResults.filter((item) => item.response.status === 409).length, 199);

  const autoUnits = await createAvailableUnits(4);
  const autoResults = await Promise.all(
    Array.from({ length: 12 }, () => reserve(reservationBody())),
  );
  assert.equal(autoResults.filter((item) => item.response.status === 200).length, 4);
  assert.equal(autoResults.filter((item) => item.response.status === 409).length, 8);
  const autoAllocated = autoResults
    .filter((item) => item.response.status === 200)
    .flatMap((item) => item.data.reservations);
  assert.equal(new Set(autoAllocated.map((reservation) => reservation.unitId)).size, 4);
  assert.ok(autoUnits.every((unitId) => autoAllocated.some((reservation) => reservation.unitId === unitId)));

  const replayUnit = (await createAvailableUnits(1))[0];
  const replayBody = reservationBody();
  const replayResults = await Promise.all(
    Array.from({ length: 10 }, () => reserve(replayBody)),
  );
  assert.ok(replayResults.every((item) => item.response.status === 200));
  for (const item of replayResults.slice(1)) assert.deepEqual(item.data, replayResults[0].data);
  assert.equal(replayResults[0].data.reservations[0].unitId, replayUnit);
  const reusedKey = await reserve({ ...replayBody, urgency: "CRITICAL" });
  assert.equal(reusedKey.response.status, 422);
  assert.equal(reusedKey.data.error.code, "IDEMPOTENCY_KEY_REUSED");

  const expiringUnit = (await createAvailableUnits(1))[0];
  const expiryBody = reservationBody();
  const expiring = await reserve(expiryBody);
  assert.equal(expiring.response.status, 200);
  const expiringReservation = expiring.data.reservations[0];
  const { hot } = schemasFor("KHI");
  await pool.query(
    `UPDATE ${hot}.reservations SET hold_expires_at = now() - interval '1 second'
     WHERE reservation_id = $1`,
    [expiringReservation.reservationId],
  );
  await sweepCity("KHI");
  const released = await pool.query(
    `SELECT u.status AS unit_status, r.status AS reservation_status
     FROM ${hot}.blood_units u
     JOIN ${hot}.reservations r ON r.unit_id = u.unit_id
     WHERE u.unit_id = $1`,
    [expiringUnit],
  );
  assert.equal(released.rows[0].unit_status, "AVAILABLE");
  assert.equal(released.rows[0].reservation_status, "EXPIRED");
  const reservedAgain = await reserve(reservationBody());
  assert.equal(reservedAgain.response.status, 200);

  // 500 randomized reserve/dispatch/transfuse/cancel/expire sequences.
  const randomUnits = await createAvailableUnits(500);
  const randomReservations = [];
  const operations = new Set();
  let randomState = 391_007;
  const random = () => {
    randomState = (randomState * 48_271) % 2_147_483_647;
    return randomState / 2_147_483_647;
  };

  for (const unitId of randomUnits) {
    const item = await reserve(reservationBody());
    assert.equal(item.response.status, 200);
    randomReservations.push(item.data.reservations[0]);
    assert.ok(randomReservations.at(-1).unitId);
  }

  for (let offset = 0; offset < randomReservations.length; offset += 10) {
    const chunk = randomReservations.slice(offset, offset + 10);
    let hasExpiredHolds = false;
    for (let index = 0; index < chunk.length; index += 1) {
      const reservation = chunk[index];
      const choice = Math.floor(random() * 5);
      if (choice === 0) {
        operations.add("cancel");
        const result = await request(`/reservations/${reservation.reservationId}/cancel?city=KHI`, {
          method: "POST",
          token: hospitalToken,
          body: { reason: "Random sequence cancellation" },
        });
        assert.equal(result.response.status, 200);
      } else if (choice === 1 || choice === 2 || choice === 4) {
        operations.add("dispatch");
        const dispatched = await request(`/reservations/${reservation.reservationId}/dispatch?city=KHI`, {
          method: "POST",
          token: bankToken,
          body: {},
        });
        assert.equal(dispatched.response.status, 200);
        if (choice === 2) {
          operations.add("cancel");
          const cancelled = await request(`/reservations/${reservation.reservationId}/cancel?city=KHI`, {
            method: "POST",
            token: hospitalToken,
            body: { reason: "Random in-transit cancellation" },
          });
          assert.equal(cancelled.response.status, 200);
        } else {
          operations.add("transfuse");
          const transfused = await request(`/reservations/${reservation.reservationId}/transfuse?city=KHI`, {
            method: "POST",
            token: hospitalToken,
            body: { patientRef: `P3-${offset + index}` },
          });
          assert.equal(transfused.response.status, 200);
        }
      } else {
        operations.add("expire");
        await pool.query(
          `UPDATE ${hot}.reservations
           SET hold_expires_at = now() - interval '1 second'
           WHERE reservation_id = $1`,
          [reservation.reservationId],
        );
        hasExpiredHolds = true;
      }
    }
    if (hasExpiredHolds) await sweepCity("KHI");
  }
  operations.add("reserve");
  assert.deepEqual(
    [...operations].sort(),
    ["cancel", "dispatch", "expire", "reserve", "transfuse"],
  );

  const invariantOutput = execFileSync(process.execPath, ["./scripts/verify-invariants.js"], {
    encoding: "utf8",
    env: process.env,
  });
  assert.match(invariantOutput, /KHI I1=0 I2=0 I3=0 I4=0 I5=0/);
  assert.match(invariantOutput, /LHE I1=0 I2=0 I3=0 I4=0 I5=0/);
  assert.match(invariantOutput, /ISB I1=0 I2=0 I3=0 I4=0 I5=0/);
});