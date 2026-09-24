import { Router } from "express";
import { z } from "zod";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { pool, withSerializableRetry } from "../db/pool.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery } from "../middleware/validate.js";
import { bloodGroupSchema, cityCodeSchema, uuidSchema } from "../utils/validators.js";
import { getActiveBank } from "../services/catalog.js";

const router = Router();
const donorIdSchema = uuidSchema;
const donorQuerySchema = z.object({
  city: cityCodeSchema.optional(),
  bloodGroup: bloodGroupSchema.optional(),
  rh: z.enum(["POS", "NEG"]).optional(),
  available: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const availabilitySchema = z.object({ isAvailable: z.boolean() });

async function findDonor(donorId, cities) {
  for (const cityCode of cities) {
    const { hist } = schemasFor(cityCode);
    const result = await pool.query(
      `SELECT donor_id AS "donorId", full_name AS "fullName", phone,
              date_of_birth AS "dateOfBirth", sex, weight_kg AS "weightKg",
              blood_group AS "bloodGroup", rh_factor AS "rhFactor",
              city_code AS "cityCode", last_donation_date AS "lastDonationDate",
              is_available AS "isAvailable", created_at AS "createdAt"
       FROM ${hist}.donors WHERE donor_id = $1`,
      [donorId],
    );
    if (result.rowCount > 0) return { donor: result.rows[0], cityCode };
  }
  return null;
}

router.get(
  "/donors/:id",
  authenticate,
  requireRole("DONOR", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const parsedId = donorIdSchema.safeParse(req.params.id);
    if (!parsedId.success) throw new AppError(422, "VALIDATION_ERROR", "Donor ID must be a UUID.");

    let cities;
    if (req.user.role === "DONOR") {
      if (req.user.donor_id !== parsedId.data) {
        throw new AppError(403, "TENANT_SCOPE_VIOLATION", "Donors can only view their own profile.");
      }
      cities = [req.user.donor_city_code];
    } else if (req.user.role === "BLOODBANK_ADMIN") {
      const bank = await getActiveBank(req.user.blood_bank_id);
      cities = [bank.city_code.trim()];
    } else {
      const query = parseQuery(z.object({ city: cityCodeSchema.optional() }), req.query);
      cities = query.city ? [query.city] : CITY_CODES;
    }

    const match = await findDonor(parsedId.data, cities);
    if (!match) throw new AppError(404, "DONOR_NOT_FOUND", "The donor was not found.");
    res.json({ donor: match.donor });
  }),
);

router.patch(
  "/donors/:id/availability",
  authenticate,
  requireRole("DONOR"),
  asyncRoute(async (req, res) => {
    const id = donorIdSchema.safeParse(req.params.id);
    const body = availabilitySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      throw new AppError(422, "VALIDATION_ERROR", "A valid donor ID and isAvailable boolean are required.");
    }
    if (req.user.donor_id !== id.data) {
      throw new AppError(403, "TENANT_SCOPE_VIOLATION", "Donors can only update their own profile.");
    }
    const { hist } = schemasFor(req.user.donor_city_code);
    const result = await withSerializableRetry((client) =>
      client.query(
        `UPDATE ${hist}.donors
         SET is_available = $1
         WHERE donor_id = $2
         RETURNING donor_id AS "donorId", is_available AS "isAvailable"`,
        [body.data.isAvailable, id.data],
      ),
    );
    if (result.rowCount === 0) throw new AppError(404, "DONOR_NOT_FOUND", "The donor was not found.");
    res.json({ donor: result.rows[0] });
  }),
);

router.get(
  "/search/donors",
  authenticate,
  requireRole("BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
  asyncRoute(async (req, res) => {
    const query = parseQuery(donorQuerySchema, req.query);
    let cities = query.city ? [query.city] : CITY_CODES;
    if (req.user.role === "BLOODBANK_ADMIN") {
      const bank = await getActiveBank(req.user.blood_bank_id);
      const bankCity = bank.city_code.trim();
      if (query.city && query.city !== bankCity) {
        throw new AppError(403, "TENANT_SCOPE_VIOLATION", "A blood bank can only search donors in its city.");
      }
      cities = [bankCity];
    }

    const results = await Promise.all(
      cities.map(async (cityCode) => {
        const { hist } = schemasFor(cityCode);
        const result = await pool.query(
          `SELECT donor_id AS "donorId", full_name AS "fullName", phone,
                  date_of_birth AS "dateOfBirth", weight_kg AS "weightKg",
                  blood_group AS "bloodGroup", rh_factor AS "rhFactor",
                  city_code AS "cityCode", last_donation_date AS "lastDonationDate",
                  is_available AS "isAvailable"
           FROM ${hist}.donors
           WHERE ($1::common.blood_group_t IS NULL OR blood_group = $1)
             AND ($2::common.rh_t IS NULL OR rh_factor = $2)
             AND ($3::boolean IS NULL OR is_available = $3)
           ORDER BY created_at DESC
           LIMIT $4`,
          [
            query.bloodGroup ?? null,
            query.rh ?? null,
            query.available === undefined ? null : query.available === "true",
            query.limit,
          ],
        );
        return result.rows;
      }),
    );
    res.json({ donors: results.flat() });
  }),
);

export default router;