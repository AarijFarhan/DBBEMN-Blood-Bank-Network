import { createHash, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { schemasFor } from "../db/shard-router.js";
import { withSerializableRetryFor } from "../db/pool.js";
import { getPoolForCity } from "../db/registry.js";
import { AppError } from "../middleware/errors.js";
import { assertCityWritable } from "./chaos.js";
import { invalidateCityInventory } from "../cache/store.js";
import { KIND, rememberCreated } from "./presence.js";

export { assertCityWritable };

function hashRequest(request, unitId = null) {
  const canonical = [
    request.requestId,
    request.hospitalId,
    request.patientBloodGroup,
    request.patientRh,
    request.component,
    request.unitsNeeded ?? 1,
    request.urgency,
    request.allowPartial ?? false,
    request.searchScope ?? "LOCAL_FIRST",
    unitId,
  ];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function claimRequest(client, hot, request, requestHash) {
  const claim = await client.query(
    `INSERT INTO ${hot}.processed_requests
       (request_id, hospital_id, request_hash, result)
     VALUES ($1, $2, $3, '{}'::jsonb)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING request_id`,
    [request.requestId, request.hospitalId, requestHash],
  );
  if (claim.rowCount > 0) return null;

  const existing = await client.query(
    `SELECT hospital_id, request_hash, result
     FROM ${hot}.processed_requests
     WHERE request_id = $1
     FOR UPDATE`,
    [request.requestId],
  );
  const cached = existing.rows[0];
  if (!cached) {
    throw new AppError(409, "REQUEST_IN_PROGRESS", "The request is being processed; retry with the same requestId.");
  }
  if (cached.hospital_id !== request.hospitalId || cached.request_hash !== requestHash) {
    throw new AppError(422, "IDEMPOTENCY_KEY_REUSED", "requestId has already been used with a different request.");
  }
  return cached.result;
}

async function createReservation(client, hot, request, cityCode, unit) {
  const reservationId = randomUUID();
  const holdMinutes = request.urgency === "CRITICAL" ? env.criticalHoldMinutes : env.holdMinutes;

  const updatedUnit = await client.query(
    `UPDATE ${hot}.blood_units
     SET status = 'RESERVED'
     WHERE unit_id = $1 AND status = 'AVAILABLE'
       AND expiry_date > CURRENT_DATE
     RETURNING unit_id`,
    [unit.unit_id],
  );
  if (updatedUnit.rowCount !== 1) {
    throw new AppError(409, "UNIT_NOT_AVAILABLE", "The unit is no longer available.");
  }

  const inserted = await client.query(
    `INSERT INTO ${hot}.reservations
       (reservation_id, request_id, unit_id, hospital_id, hospital_city_code,
        patient_blood_group, patient_rh, urgency, hold_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             now() + make_interval(mins => $9::int))
     RETURNING reservation_id AS "reservationId", request_id AS "requestId",
               unit_id AS "unitId", hospital_id AS "hospitalId",
               patient_blood_group AS "patientBloodGroup",
               patient_rh AS "patientRh", urgency, status,
               reserved_at AS "reservedAt", hold_expires_at AS "holdExpiresAt"`,
    [
      reservationId,
      request.requestId,
      unit.unit_id,
      request.hospitalId,
      request.hospitalCityCode,
      request.patientBloodGroup,
      request.patientRh,
      request.urgency,
      holdMinutes,
    ],
  );
  return { ...inserted.rows[0], cityCode };
}

export async function reserveUnitsInCity(cityCode, request, unitsNeeded) {
  const { hot } = schemasFor(cityCode);
  const requestHash = hashRequest(request);
  const result = await withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
    await assertCityWritable(client, cityCode);
    const cached = await claimRequest(client, hot, request, requestHash);
    if (cached) return cached;

    const candidates = await client.query(
      `SELECT u.unit_id, u.blood_group, u.rh_factor, u.component_type,
              u.volume_ml, u.collected_on, u.expiry_date
       FROM ${hot}.blood_units u
       WHERE u.status = 'AVAILABLE'
         AND u.expiry_date > CURRENT_DATE
         AND u.component_type = $1::common.component_t
         AND (u.blood_group, u.rh_factor) IN (
           SELECT g, r
           FROM common.compatible_donor(
             $2::common.blood_group_t,
             $3::common.rh_t,
             $1::common.component_t
           )
         )
       ORDER BY
         (u.blood_group = $2::common.blood_group_t
          AND u.rh_factor = $3::common.rh_t) DESC,
         (u.blood_group = 'O'::common.blood_group_t
          AND u.rh_factor = 'NEG'::common.rh_t
          AND NOT ($2::common.blood_group_t = 'O' AND $3::common.rh_t = 'NEG')) ASC,
         u.expiry_date ASC,
         u.unit_id ASC
       LIMIT $4
       FOR UPDATE SKIP LOCKED`,
      [request.component, request.patientBloodGroup, request.patientRh, unitsNeeded],
    );

    const reservations = [];
    for (const unit of candidates.rows) {
      reservations.push(await createReservation(client, hot, request, cityCode, unit));
    }
    const result = { cityCode, reservations };
    await client.query(
      `UPDATE ${hot}.processed_requests
       SET result = $2::jsonb
       WHERE request_id = $1`,
      [request.requestId, JSON.stringify(result)],
    );
    return result;
  }).catch((error) => {
    if (error.code === "23505" && error.constraint === "uq_one_live_reservation_per_unit") {
      throw new AppError(409, "UNIT_ALREADY_RESERVED", "The unit already has an active reservation.");
    }
    throw error;
  });

  // Units just moved to RESERVED, so any cached search or summary that still
  // lists them as available is now showing stock that is spoken for. Bump only
  // after the commit succeeded.
  if (result.reservations.length > 0) {
    await invalidateCityInventory(cityCode);
    // Index the new reservations so detail lookups can skip other shards.
    // Best-effort: a failure here untrusts the filter rather than lying.
    for (const reservation of result.reservations) {
      await rememberCreated(KIND.RESERVATION, cityCode, reservation.reservationId);
    }
  }
  return result;
}

export async function reserveSpecificUnit(cityCode, request, unitId) {
  const { hot } = schemasFor(cityCode);
  const requestHash = hashRequest(request, unitId);
  const result = await withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
    await assertCityWritable(client, cityCode);
    const cached = await claimRequest(client, hot, request, requestHash);
    if (cached) return cached;

    const found = await client.query(
      `SELECT unit_id, blood_group, rh_factor, component_type,
              volume_ml, collected_on, expiry_date, status
       FROM ${hot}.blood_units
       WHERE unit_id = $1
       FOR UPDATE`,
      [unitId],
    );
    const unit = found.rows[0];
    if (!unit) throw new AppError(404, "UNIT_NOT_FOUND", "The unit was not found in this city.");
    if (unit.status !== "AVAILABLE" || new Date(unit.expiry_date) <= new Date()) {
      throw new AppError(409, "UNIT_NOT_AVAILABLE", "The unit is no longer available.");
    }
    if (unit.component_type !== request.component) {
      throw new AppError(422, "INCOMPATIBLE_UNIT", "The unit component does not match the request.");
    }
    const compatibility = await client.query(
      `SELECT 1
       FROM common.compatible_donor(
         $1::common.blood_group_t,
         $2::common.rh_t,
         $3::common.component_t
       )
       WHERE g = $4::common.blood_group_t AND r = $5::common.rh_t`,
      [
        request.patientBloodGroup,
        request.patientRh,
        request.component,
        unit.blood_group,
        unit.rh_factor,
      ],
    );
    if (compatibility.rowCount === 0) {
      throw new AppError(422, "INCOMPATIBLE_UNIT", "The unit is not compatible with the patient.");
    }

    const reservation = await createReservation(client, hot, request, cityCode, unit);
    const result = { cityCode, reservations: [reservation] };
    await client.query(
      `UPDATE ${hot}.processed_requests SET result = $2::jsonb WHERE request_id = $1`,
      [request.requestId, JSON.stringify(result)],
    );
    return result;
  }).catch((error) => {
    if (error.code === "23505" && error.constraint === "uq_one_live_reservation_per_unit") {
      throw new AppError(409, "UNIT_NOT_AVAILABLE", "The unit already has an active reservation.");
    }
    throw error;
  });

  if (result.reservations.length > 0) {
    await invalidateCityInventory(cityCode);
    for (const reservation of result.reservations) {
      await rememberCreated(KIND.RESERVATION, cityCode, reservation.reservationId);
    }
  }
  return result;
}

export async function compensateCityReservations(cityCode, request, reservations) {
  if (reservations.length === 0) return { cityCode, compensated: 0 };
  const { hot } = schemasFor(cityCode);
  const requestHash = hashRequest(request);
  const result = await withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
    await assertCityWritable(client, cityCode);
    let compensated = 0;
    for (const reservation of reservations) {
      const current = await client.query(
        `SELECT r.reservation_id, r.unit_id, r.status, u.expiry_date
         FROM ${hot}.reservations r
         JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
         WHERE r.reservation_id = $1 AND r.request_id = $2
           AND r.hospital_id = $3
         FOR UPDATE OF r, u`,
        [reservation.reservationId, request.requestId, request.hospitalId],
      );
      if (current.rowCount === 0) {
        throw new AppError(409, "RESERVATION_COMPENSATION_FAILED", "A reservation could not be locked for compensation.");
      }
      const row = current.rows[0];
      if (["CANCELLED", "EXPIRED"].includes(row.status)) continue;
      if (row.status !== "ACTIVE") {
        throw new AppError(409, "RESERVATION_COMPENSATION_FAILED", "A reservation changed before compensation.");
      }
      const cancelled = await client.query(
        `UPDATE ${hot}.reservations
         SET status = 'CANCELLED', cancelled_at = now(),
             cancel_reason = 'CROSS_CITY_COMPENSATION'
         WHERE reservation_id = $1 AND status = 'ACTIVE'
         RETURNING reservation_id`,
        [reservation.reservationId],
      );
      if (cancelled.rowCount !== 1) {
        throw new AppError(409, "RESERVATION_COMPENSATION_FAILED", "A reservation changed before compensation.");
      }
      const nextStatus = await client.query(
        `SELECT CASE WHEN $1::date > CURRENT_DATE
                     THEN 'AVAILABLE'::common.unit_status_t
                     ELSE 'EXPIRED'::common.unit_status_t END AS status`,
        [row.expiry_date],
      );
      const unit = await client.query(
        `UPDATE ${hot}.blood_units
         SET status = $1::common.unit_status_t
         WHERE unit_id = $2 AND status = 'RESERVED'
         RETURNING unit_id`,
        [nextStatus.rows[0].status, row.unit_id],
      );
      if (unit.rowCount !== 1) {
        throw new AppError(409, "RESERVATION_COMPENSATION_FAILED", "A unit changed before compensation.");
      }
      compensated += 1;
    }
    const stored = await client.query(
      `SELECT request_hash FROM ${hot}.processed_requests
       WHERE request_id = $1 AND hospital_id = $2 FOR UPDATE`,
      [request.requestId, request.hospitalId],
    );
    if (stored.rowCount > 0 && stored.rows[0].request_hash === requestHash) {
      await client.query(
        `UPDATE ${hot}.processed_requests
         SET result = jsonb_build_object('cityCode', $2::text, 'reservations', '[]'::jsonb)
         WHERE request_id = $1`,
        [request.requestId, cityCode],
      );
    }
    return { cityCode, compensated };
  });

  // Compensation releases units back to AVAILABLE/EXPIRED, so it invalidates
  // just as a reservation does.
  if (result.compensated > 0) {
    await invalidateCityInventory(cityCode);
  }
  return result;
}