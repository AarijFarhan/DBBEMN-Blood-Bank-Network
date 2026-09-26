import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { withSerializableRetryFor } from "../db/pool.js";
import { getPoolForCity } from "../db/registry.js";
import { env } from "../config/env.js";
import { authenticate, requireBankScope, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery, validate } from "../middleware/validate.js";
import { getActiveBank } from "../services/catalog.js";
import { assertCityWritable } from "../services/chaos.js";
import {
  cityCodeSchema,
  componentSchema,
  rhSchema,
  uuidSchema,
} from "../utils/validators.js";

const router = Router();
const SHELF_LIFE_DAYS = Object.freeze({
  WHOLE_BLOOD: 35,
  PRBC: 42,
  PLATELETS: 5,
  PLASMA: 365,
});
const donationSchema = z.object({
  donorId: uuidSchema,
  bloodBankId: uuidSchema,
  volumeMl: z.number().int().min(350).max(500),
  components: z.array(z.object({
    componentType: componentSchema,
    volumeMl: z.number().int().positive().max(1000),
  })).min(1).max(4).refine(
    (items) => new Set(items.map((item) => item.componentType)).size === items.length,
    "Each component type can appear only once.",
  ),
});
const screeningSchema = z.object({ screeningStatus: z.enum(["PASSED", "FAILED"]) });
const listQuerySchema = z.object({
  donorId: uuidSchema.optional(),
  city: cityCodeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const MINIMUM_AGE = 18;
const MAXIMUM_AGE = 65;
const MINIMUM_WEIGHT_KG = 50;

function eligibilityFailure(reason, message) {
  return new AppError(422, "DONOR_INELIGIBLE", message, { reason });
}

router.post(
  "/donations",
  authenticate,
  requireRole("BLOODBANK_ADMIN"),
  validate(donationSchema),
  asyncRoute(async (req, res) => {
    const body = req.body;
    requireBankScope(req, body.bloodBankId);
    const bank = await getActiveBank(body.bloodBankId);
    const cityCode = bank.city_code.trim();
    const { hot, hist } = schemasFor(cityCode);
    const donationId = randomUUID();
    const unitIds = body.components.map(() => randomUUID());

     const created = await withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
       await assertCityWritable(client, cityCode);
       const donorResult = await client.query(
        `SELECT donor_id, date_of_birth, weight_kg, last_donation_date,
                is_available, blood_group::text AS blood_group, rh_factor::text AS rh_factor
         FROM ${hist}.donors
         WHERE donor_id = $1 AND city_code = $2
         FOR UPDATE`,
        [body.donorId, cityCode],
      );
      const donor = donorResult.rows[0];
      if (!donor) throw new AppError(404, "DONOR_NOT_FOUND", "The donor was not found in this city.");
      if (!donor.is_available) throw eligibilityFailure("NOT_AVAILABLE", "The donor is not currently available.");

      const donorAge = await client.query(
        "SELECT EXTRACT(YEAR FROM age(CURRENT_DATE, $1::date))::int AS age",
        [donor.date_of_birth],
      );
      const age = donorAge.rows[0].age;
      if (age < MINIMUM_AGE || age > MAXIMUM_AGE) {
        throw eligibilityFailure("AGE_OUT_OF_RANGE", "Donors must be between 18 and 65 years old.");
      }
      if (Number(donor.weight_kg) < MINIMUM_WEIGHT_KG) {
        throw eligibilityFailure("WEIGHT_BELOW_MINIMUM", "Donors must weigh at least 50 kg.");
      }
      if (donor.last_donation_date) {
        const elapsed = await client.query(
          "SELECT CURRENT_DATE - $1::date AS days_since_last",
          [donor.last_donation_date],
        );
        if (Number(elapsed.rows[0].days_since_last) < env.donationIntervalDays) {
          throw eligibilityFailure(
            "DONATION_INTERVAL_NOT_MET",
            `At least ${env.donationIntervalDays} days must pass between donations.`,
          );
        }
      }

      await client.query(
        `INSERT INTO ${hist}.donations
           (donation_id, donor_id, blood_bank_id, volume_ml, screening_status)
         VALUES ($1, $2, $3, $4, 'PENDING')`,
        [donationId, body.donorId, body.bloodBankId, body.volumeMl],
      );

      const units = [];
      for (let index = 0; index < body.components.length; index += 1) {
        const component = body.components[index];
        const unitId = unitIds[index];
        await client.query(
          `INSERT INTO ${hot}.blood_units
             (unit_id, donation_id, blood_bank_id, blood_group, rh_factor,
              component_type, volume_ml, collected_on, expiry_date, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE,
                   CURRENT_DATE + $8::int, 'QUARANTINE')`,
          [
            unitId,
            donationId,
            body.bloodBankId,
            donor.blood_group,
            donor.rh_factor,
            component.componentType,
            component.volumeMl,
            SHELF_LIFE_DAYS[component.componentType],
          ],
        );
        units.push({ unitId, componentType: component.componentType, status: "QUARANTINE" });
      }
      return { donationId, cityCode, units };
    });

    res.status(201).json({ donation: created });
  }),
);

router.patch(
  "/donations/:id/screening",
  authenticate,
  requireRole("BLOODBANK_ADMIN"),
  validate(screeningSchema),
  asyncRoute(async (req, res) => {
    const donationId = uuidSchema.safeParse(req.params.id);
    if (!donationId.success) throw new AppError(422, "VALIDATION_ERROR", "Donation ID must be a UUID.");
    const screeningStatus = req.body.screeningStatus;
    const bank = await getActiveBank(req.user.blood_bank_id);
    const cityCode = bank.city_code.trim();
    const { hot, hist } = schemasFor(cityCode);

     const result = await withSerializableRetryFor(getPoolForCity(cityCode))(async (client) => {
       await assertCityWritable(client, cityCode);
       const found = await client.query(
        `SELECT donation_id, donor_id, blood_bank_id, screening_status, collected_at
         FROM ${hist}.donations
         WHERE donation_id = $1
         FOR UPDATE`,
        [donationId.data],
      );
      const donation = found.rows[0];
      if (!donation) throw new AppError(404, "DONATION_NOT_FOUND", "The donation was not found.");
      requireBankScope(req, donation.blood_bank_id);
      if (donation.screening_status !== "PENDING") {
        throw new AppError(409, "DONATION_ALREADY_SCREENED", "This donation has already been screened.");
      }

      await client.query(
        `UPDATE ${hist}.donations
         SET screening_status = $1, screened_at = now()
         WHERE donation_id = $2 AND screening_status = 'PENDING'`,
        [screeningStatus, donationId.data],
      );
      const unitStatus = screeningStatus === "PASSED" ? "AVAILABLE" : "DISCARDED";
      const unitResult = await client.query(
        `UPDATE ${hot}.blood_units
         SET status = $1
         WHERE donation_id = $2 AND status = 'QUARANTINE'
         RETURNING unit_id AS "unitId", status`,
        [unitStatus, donationId.data],
      );
      if (screeningStatus === "PASSED") {
        await client.query(
          `UPDATE ${hist}.donors
           SET last_donation_date = $1::date
           WHERE donor_id = $2`,
          [donation.collected_at, donation.donor_id],
        );
      }
      return { donationId: donationId.data, screeningStatus, units: unitResult.rows };
    });

    res.json({ donation: result });
  }),
);

router.get(
  "/donations",
  authenticate,
  requireRole("DONOR", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const query = parseQuery(listQuerySchema, req.query);
    let cities;
    let donorId = query.donorId;
    let bloodBankId = null;

    if (req.user.role === "DONOR") {
      if (donorId && donorId !== req.user.donor_id) {
        throw new AppError(403, "TENANT_SCOPE_VIOLATION", "Donors can only view their own donations.");
      }
      donorId = req.user.donor_id;
      cities = [req.user.donor_city_code];
    } else if (req.user.role === "BLOODBANK_ADMIN") {
      const bank = await getActiveBank(req.user.blood_bank_id);
      const bankCity = bank.city_code.trim();
      if (query.city && query.city !== bankCity) {
        throw new AppError(403, "TENANT_SCOPE_VIOLATION", "A blood bank can only view donations in its city.");
      }
      cities = [bankCity];
      bloodBankId = req.user.blood_bank_id;
    } else {
      cities = query.city ? [query.city] : CITY_CODES;
    }

    const rows = await Promise.all(
      cities.map(async (cityCode) => {
        const { hist } = schemasFor(cityCode);
        const result = await getPoolForCity(cityCode).query(
          `SELECT d.donation_id AS "donationId", d.donor_id AS "donorId",
                  d.blood_bank_id AS "bloodBankId", d.collected_at AS "collectedAt",
                  d.volume_ml AS "volumeMl", d.screening_status AS "screeningStatus",
                  d.screened_at AS "screenedAt", d.notes
           FROM ${hist}.donations d
           WHERE ($1::uuid IS NULL OR d.donor_id = $1)
             AND ($2::uuid IS NULL OR d.blood_bank_id = $2)
           ORDER BY d.collected_at DESC
           LIMIT $3`,
          [donorId ?? null, bloodBankId, query.limit],
        );
        return result.rows;
      }),
    );
    res.json({ donations: rows.flat() });
  }),
);

export default router;