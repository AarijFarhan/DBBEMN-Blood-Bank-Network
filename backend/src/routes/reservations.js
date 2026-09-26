import { Router } from "express";
import { z } from "zod";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { withSerializableRetryFor } from "../db/pool.js";
import { getCatalogPool, getPoolForCity } from "../db/registry.js";
import { authenticate, requireBankScope, requireHospitalScope, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery, validate } from "../middleware/validate.js";
import { getActiveBank, getActiveHospital } from "../services/catalog.js";
import {
  assertCityWritable,
  compensateCityReservations,
  reserveSpecificUnit,
  reserveUnitsInCity,
} from "../services/reservations.js";
import {
  cityCodeSchema,
  manualReservationSchema,
  reservationRequestSchema,
  uuidSchema,
} from "../utils/validators.js";

const router = Router();
const actionQuerySchema = z.object({ city: cityCodeSchema.optional() });
const manualQuerySchema = z.object({ city: cityCodeSchema });
const listQuerySchema = z.object({
  hospitalId: uuidSchema.optional(),
  city: cityCodeSchema.optional(),
  status: z.enum(["ACTIVE", "DISPATCHED", "COMPLETED", "CANCELLED", "EXPIRED"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const dispatchSchema = z.object({ note: z.string().trim().max(500).optional() });
const transfuseSchema = z.object({
  patientRef: z.string().trim().min(1).max(120),
  outcomeNotes: z.string().trim().max(1000).optional(),
});
const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300).optional() });

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function rankedCityCodes(hospital, scope) {
  if (scope === "LOCAL_FIRST") return [hospital.city_code.trim()];
  const cities = await getCatalogPool().query(
    `SELECT city_code, latitude, longitude FROM catalog.cities`,
  );
  const originLat = Number(hospital.latitude ?? cities.rows.find((city) =>
    city.city_code.trim() === hospital.city_code.trim(),
  )?.latitude);
  const originLon = Number(hospital.longitude ?? cities.rows.find((city) =>
    city.city_code.trim() === hospital.city_code.trim(),
  )?.longitude);
  const local = hospital.city_code.trim();
  return cities.rows
    .map((city) => ({
      cityCode: city.city_code.trim(),
      distance: haversineKm(
        originLat,
        originLon,
        Number(city.latitude),
        Number(city.longitude),
      ),
    }))
    .sort((a, b) => {
      if (a.cityCode === local) return -1;
      if (b.cityCode === local) return 1;
      return a.distance - b.distance;
    })
    .map((city) => city.cityCode);
}

async function writableCitiesForUser(req, requestedCity) {
  if (req.user.role === "BLOODBANK_ADMIN") {
    const bank = await getActiveBank(req.user.blood_bank_id);
    const city = bank.city_code.trim();
    if (requestedCity && requestedCity !== city) {
      throw new AppError(403, "TENANT_SCOPE_VIOLATION", "This blood bank can only access its own city.");
    }
    return [city];
  }
  if (req.user.role === "HOSPITAL_ADMIN") {
    return requestedCity ? [requestedCity] : CITY_CODES;
  }
  return requestedCity ? [requestedCity] : CITY_CODES;
}

async function readReservation(cityCode, reservationId) {
  const { hot } = schemasFor(cityCode);
  const result = await getPoolForCity(cityCode).query(
    `SELECT r.reservation_id AS "reservationId", r.request_id AS "requestId",
            r.unit_id AS "unitId", r.hospital_id AS "hospitalId",
            r.hospital_city_code AS "hospitalCityCode",
            r.patient_blood_group AS "patientBloodGroup", r.patient_rh AS "patientRh",
            r.urgency, r.status, r.reserved_at AS "reservedAt",
            r.hold_expires_at AS "holdExpiresAt", r.dispatched_at AS "dispatchedAt",
            r.completed_at AS "completedAt", r.cancelled_at AS "cancelledAt",
            r.cancel_reason AS "cancelReason", u.blood_bank_id AS "bloodBankId",
            u.status AS "unitStatus", u.expiry_date AS "expiryDate"
     FROM ${hot}.reservations r
     JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
     WHERE r.reservation_id = $1`,
    [reservationId],
  );
  return result.rows[0] ? { cityCode, ...result.rows[0] } : null;
}

async function locateReservation(req, reservationId, requestedCity) {
  const cities = await writableCitiesForUser(req, requestedCity);
  for (const cityCode of cities) {
    const reservation = await readReservation(cityCode, reservationId);
    if (!reservation) continue;
    if (req.user.role === "HOSPITAL_ADMIN") {
      requireHospitalScope(req, reservation.hospitalId);
    }
    if (req.user.role === "BLOODBANK_ADMIN") {
      requireBankScope(req, reservation.bloodBankId);
    }
    return reservation;
  }
  throw new AppError(404, "RESERVATION_NOT_FOUND", "The reservation was not found.");
}

async function lockReservation(client, hot, reservationId) {
  const result = await client.query(
    `SELECT r.reservation_id, r.request_id, r.unit_id, r.hospital_id,
            r.hospital_city_code, r.patient_blood_group, r.patient_rh,
            r.urgency, r.status, r.hold_expires_at,
            u.blood_bank_id, u.status AS unit_status, u.expiry_date
     FROM ${hot}.reservations r
     JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
     WHERE r.reservation_id = $1
     FOR UPDATE OF r, u`,
    [reservationId],
  );
  return result.rows[0] ?? null;
}

async function doDispatch(cityCode, reservationId, bankId) {
  const { hot } = schemasFor(cityCode);
  return withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
    await assertCityWritable(client, cityCode);
    const row = await lockReservation(client, hot, reservationId);
    if (!row) throw new AppError(404, "RESERVATION_NOT_FOUND", "The reservation was not found.");
    if (row.blood_bank_id !== bankId) {
      throw new AppError(403, "TENANT_SCOPE_VIOLATION", "This reservation belongs to another blood bank.");
    }
    if (row.status !== "ACTIVE" || new Date(row.hold_expires_at) <= new Date()) {
      throw new AppError(409, "RESERVATION_NOT_DISPATCHABLE", "The reservation is not active or its hold has expired.");
    }
    const reservation = await client.query(
      `UPDATE ${hot}.reservations
       SET status = 'DISPATCHED', dispatched_at = now()
       WHERE reservation_id = $1 AND status = 'ACTIVE'
         AND hold_expires_at > now()
       RETURNING reservation_id AS "reservationId", unit_id AS "unitId", status`,
      [reservationId],
    );
    if (reservation.rowCount !== 1) {
      throw new AppError(409, "RESERVATION_NOT_DISPATCHABLE", "The reservation changed before dispatch.");
    }
    const unit = await client.query(
      `UPDATE ${hot}.blood_units SET status = 'DISPATCHED'
       WHERE unit_id = $1 AND status = 'RESERVED'
       RETURNING unit_id AS "unitId", status`,
      [row.unit_id],
    );
    if (unit.rowCount !== 1) throw new AppError(409, "UNIT_NOT_RESERVED", "The reserved unit is no longer available.");
    return { ...reservation.rows[0], cityCode };
  });
}

async function doTransfuse(cityCode, reservationId, hospitalId, body) {
  const { hot, hist } = schemasFor(cityCode);
  return withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
    await assertCityWritable(client, cityCode);
    const row = await lockReservation(client, hot, reservationId);
    if (!row) throw new AppError(404, "RESERVATION_NOT_FOUND", "The reservation was not found.");
    if (row.hospital_id !== hospitalId) {
      throw new AppError(403, "TENANT_SCOPE_VIOLATION", "This reservation belongs to another hospital.");
    }
    if (row.status !== "DISPATCHED") {
      throw new AppError(409, "RESERVATION_NOT_TRANSFUSABLE", "Only dispatched reservations can be transfused.");
    }
    const reservation = await client.query(
      `UPDATE ${hot}.reservations
       SET status = 'COMPLETED', completed_at = now()
       WHERE reservation_id = $1 AND status = 'DISPATCHED'
       RETURNING reservation_id AS "reservationId", unit_id AS "unitId", status`,
      [reservationId],
    );
    if (reservation.rowCount !== 1) {
      throw new AppError(409, "RESERVATION_NOT_TRANSFUSABLE", "The reservation changed before transfusion.");
    }
    const unit = await client.query(
      `UPDATE ${hot}.blood_units SET status = 'TRANSFUSED'
       WHERE unit_id = $1 AND status = 'DISPATCHED'
       RETURNING unit_id`,
      [row.unit_id],
    );
    if (unit.rowCount !== 1) throw new AppError(409, "UNIT_NOT_DISPATCHED", "The unit is not in dispatch.");
    await client.query(
      `INSERT INTO ${hist}.transfusions
         (transfusion_id, reservation_id, unit_id, hospital_id, patient_ref, outcome_notes)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [reservationId, row.unit_id, hospitalId, body.patientRef, body.outcomeNotes ?? null],
    );
    return { ...reservation.rows[0], cityCode };
  });
}

async function doCancel(cityCode, reservationId, reason) {
  const { hot } = schemasFor(cityCode);
  return withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
    await assertCityWritable(client, cityCode);
    const row = await lockReservation(client, hot, reservationId);
    if (!row) throw new AppError(404, "RESERVATION_NOT_FOUND", "The reservation was not found.");
    if (!["ACTIVE", "DISPATCHED"].includes(row.status)) {
      throw new AppError(409, "RESERVATION_NOT_CANCELLABLE", "This reservation is already terminal.");
    }
    const cancelled = await client.query(
      `UPDATE ${hot}.reservations
       SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = $2
       WHERE reservation_id = $1 AND status IN ('ACTIVE', 'DISPATCHED')
       RETURNING reservation_id AS "reservationId", unit_id AS "unitId", status`,
      [reservationId, reason ?? "Cancelled by user"],
    );
    if (cancelled.rowCount !== 1) throw new AppError(409, "RESERVATION_NOT_CANCELLABLE", "The reservation changed before cancellation.");

    const nextStatus = row.status === "DISPATCHED"
      ? "QUARANTINE"
      : (await client.query(
        "SELECT CASE WHEN $1::date > CURRENT_DATE THEN 'AVAILABLE' ELSE 'EXPIRED' END AS status",
        [row.expiry_date],
      )).rows[0].status;
    const unit = await client.query(
      `UPDATE ${hot}.blood_units SET status = $1::common.unit_status_t
       WHERE unit_id = $2 AND status = $3::common.unit_status_t
       RETURNING unit_id AS "unitId", status`,
      [
        nextStatus,
        row.unit_id,
        row.status === "DISPATCHED" ? "DISPATCHED" : "RESERVED",
      ],
    );
    if (unit.rowCount !== 1) throw new AppError(409, "UNIT_STATE_MISMATCH", "The unit state changed before cancellation.");
    return { ...cancelled.rows[0], unitStatus: unit.rows[0].status, cityCode };
  });
}

router.post(
  "/reservations",
  authenticate,
  requireRole("HOSPITAL_ADMIN"),
  validate(reservationRequestSchema),
  asyncRoute(async (req, res) => {
    requireHospitalScope(req, req.body.hospitalId);
    const hospital = await getActiveHospital(req.body.hospitalId);
    const request = { ...req.body, hospitalCityCode: hospital.city_code.trim() };
    const cities = await rankedCityCodes(hospital, request.searchScope);
    const cityResults = [];
    const unavailableCities = [];
    let remaining = request.unitsNeeded;

    for (const cityCode of cities) {
      if (remaining === 0) break;
      try {
        const result = await reserveUnitsInCity(cityCode, request, remaining);
        cityResults.push(result);
        remaining -= result.reservations.length;
      } catch (error) {
        if (error.status === 503 && error.code === "SHARD_WRITE_UNAVAILABLE") {
          unavailableCities.push(cityCode);
          continue;
        }
        throw error;
      }
    }

    const reservations = cityResults.flatMap((result) => result.reservations);
    const reservationsByCity = Object.fromEntries(
      cityResults.map((result) => [result.cityCode, result.reservations]),
    );
    if (remaining > 0 && !request.allowPartial) {
      const compensationResults = await Promise.allSettled(
        cityResults.map((result) => compensateCityReservations(result.cityCode, request, result.reservations)),
      );
      const compensationFailures = compensationResults
        .map((result, index) => ({ result, cityCode: cityResults[index].cityCode }))
        .filter(({ result }) => result.status === "rejected");
      if (compensationFailures.length > 0) {
        throw new AppError(
          503,
          "RESERVATION_COMPENSATION_FAILED",
          "The reservation could not be fully rolled back.",
          {
            requested: request.unitsNeeded,
            unavailableCities,
            compensated: false,
            compensation: compensationResults.map((result, index) => ({
              cityCode: cityResults[index].cityCode,
              status: result.status,
              compensated: result.status === "fulfilled" ? result.value.compensated : 0,
            })),
          },
          { "Retry-After": "5" },
        );
      }
      if (reservations.length === 0 && unavailableCities.length > 0) {
        throw new AppError(
          503,
          "SHARD_WRITE_UNAVAILABLE",
          "No reservation shard was available.",
          { unavailableCities, simulation: "SIMULATED" },
          { "Retry-After": "5" },
        );
      }
      throw new AppError(409, "INSUFFICIENT_STOCK", "There is not enough compatible inventory to fulfill the request.", {
        requested: request.unitsNeeded,
        unavailableCities,
        compensated: true,
        reservationsByCity,
      });
    }
    if (reservations.length === 0 && unavailableCities.length > 0) {
      throw new AppError(
        503,
        "SHARD_WRITE_UNAVAILABLE",
        "No reservation shard was available.",
        { unavailableCities, simulation: "SIMULATED" },
        { "Retry-After": "5" },
      );
    }
    res.json({
      requestId: request.requestId,
      reservations,
      reservationsByCity,
      unavailableCities,
      partial: remaining > 0 || unavailableCities.length > 0,
    });
  }),
);

router.post(
  "/units/:id/reserve",
  authenticate,
  requireRole("HOSPITAL_ADMIN"),
  validate(manualReservationSchema),
  asyncRoute(async (req, res) => {
    const unitId = uuidSchema.safeParse(req.params.id);
    const { city } = parseQuery(manualQuerySchema, req.query);
    if (!unitId.success) throw new AppError(422, "VALIDATION_ERROR", "Unit ID must be a UUID.");
    requireHospitalScope(req, req.body.hospitalId);
    const hospital = await getActiveHospital(req.body.hospitalId);
    const request = { ...req.body, hospitalCityCode: hospital.city_code.trim() };
    const result = await reserveSpecificUnit(city, request, unitId.data);
    res.json(result);
  }),
);

router.get(
  "/reservations/:id",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const query = parseQuery(actionQuerySchema, req.query);
    if (!id.success) throw new AppError(422, "VALIDATION_ERROR", "Reservation ID must be a UUID.");
    const reservation = await locateReservation(req, id.data, query.city);
    res.json({ reservation });
  }),
);

router.get(
  "/reservations",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const query = parseQuery(listQuerySchema, req.query);
    let hospitalId = query.hospitalId ?? null;
    let bankId = null;
    let cities = query.city ? [query.city] : CITY_CODES;

    if (req.user.role === "HOSPITAL_ADMIN") {
      requireHospitalScope(req, hospitalId ?? req.user.hospital_id);
      await getActiveHospital(req.user.hospital_id);
      hospitalId = req.user.hospital_id;
      cities = query.city ? [query.city] : CITY_CODES;
    } else if (req.user.role === "BLOODBANK_ADMIN") {
      const bank = await getActiveBank(req.user.blood_bank_id);
      const city = bank.city_code.trim();
      if (query.city && query.city !== city) {
        throw new AppError(403, "TENANT_SCOPE_VIOLATION", "A blood bank can only view reservations in its city.");
      }
      cities = [city];
      bankId = req.user.blood_bank_id;
    }

    const rows = await Promise.all(cities.map(async (cityCode) => {
      const { hot } = schemasFor(cityCode);
      const result = await getPoolForCity(cityCode).query(
        `SELECT r.reservation_id AS "reservationId", r.request_id AS "requestId",
                r.unit_id AS "unitId", r.hospital_id AS "hospitalId",
                r.patient_blood_group AS "patientBloodGroup", r.patient_rh AS "patientRh",
                r.urgency, r.status, r.reserved_at AS "reservedAt",
                r.hold_expires_at AS "holdExpiresAt", r.dispatched_at AS "dispatchedAt",
                r.completed_at AS "completedAt", r.cancelled_at AS "cancelledAt",
                r.cancel_reason AS "cancelReason", u.blood_bank_id AS "bloodBankId",
                u.status AS "unitStatus"
         FROM ${hot}.reservations r
         JOIN ${hot}.blood_units u ON u.unit_id = r.unit_id
         WHERE ($1::uuid IS NULL OR r.hospital_id = $1)
           AND ($2::uuid IS NULL OR u.blood_bank_id = $2)
           AND ($3::common.reservation_status_t IS NULL OR r.status = $3)
         ORDER BY r.reserved_at DESC, r.reservation_id
         LIMIT $4`,
        [hospitalId, bankId, query.status ?? null, query.limit],
      );
      return result.rows.map((row) => ({ ...row, cityCode }));
    }));
    res.json({ reservations: rows.flat() });
  }),
);

router.post(
  "/reservations/:id/dispatch",
  authenticate,
  requireRole("BLOODBANK_ADMIN"),
  validate(dispatchSchema),
  asyncRoute(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const query = parseQuery(actionQuerySchema, req.query);
    if (!id.success) throw new AppError(422, "VALIDATION_ERROR", "Reservation ID must be a UUID.");
    const bank = await getActiveBank(req.user.blood_bank_id);
    const city = query.city ?? bank.city_code.trim();
    if (city !== bank.city_code.trim()) {
      throw new AppError(403, "TENANT_SCOPE_VIOLATION", "This blood bank can only dispatch its own units.");
    }
    res.json({ reservation: await doDispatch(city, id.data, req.user.blood_bank_id) });
  }),
);

router.post(
  "/reservations/:id/transfuse",
  authenticate,
  requireRole("HOSPITAL_ADMIN"),
  validate(transfuseSchema),
  asyncRoute(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const query = parseQuery(actionQuerySchema, req.query);
    if (!id.success) throw new AppError(422, "VALIDATION_ERROR", "Reservation ID must be a UUID.");
    const reservation = await locateReservation(req, id.data, query.city);
    res.json({
      reservation: await doTransfuse(reservation.cityCode, id.data, req.user.hospital_id, req.body),
    });
  }),
);

router.post(
  "/reservations/:id/cancel",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  validate(cancelSchema),
  asyncRoute(async (req, res) => {
    const id = uuidSchema.safeParse(req.params.id);
    const query = parseQuery(actionQuerySchema, req.query);
    if (!id.success) throw new AppError(422, "VALIDATION_ERROR", "Reservation ID must be a UUID.");
    const reservation = await locateReservation(req, id.data, query.city);
    res.json({
      reservation: await doCancel(reservation.cityCode, id.data, req.body.reason),
    });
  }),
);

export default router;