import { Router } from "express";
import { z } from "zod";
import { CITY_CODES, schemasFor } from "../db/shard-router.js";
import { withSerializableRetryFor } from "../db/pool.js";
import { getPoolForCity } from "../db/registry.js";
import { authenticate, requireRole } from "../middleware/auth.js";
import { AppError, asyncRoute } from "../middleware/errors.js";
import { parseQuery } from "../middleware/validate.js";
import { bloodGroupSchema, cityCodeSchema, uuidSchema } from "../utils/validators.js";
import { getActiveBank, getActiveHospital } from "../services/catalog.js";
import { assertCityWritable } from "../services/chaos.js";
import { KIND, locateAcrossCities, rememberCreated } from "../services/presence.js";

const router = Router();
const donorIdSchema = uuidSchema;
const donorQuerySchema = z.object({
  city: cityCodeSchema.optional(),
  bloodGroup: bloodGroupSchema.optional(),
  rh: z.enum(["POS", "NEG"]).optional(),
  available: z.enum(["true", "false"]).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const availabilitySchema = z.object({ isAvailable: z.boolean() });

async function findDonor(donorId, cities) {
  return locateAcrossCities(KIND.DONOR, donorId, cities, async (cityCode) => {
    const { hist } = schemasFor(cityCode);
    const result = await getPoolForCity(cityCode).query(
      `SELECT donor_id AS "donorId", full_name AS "fullName", phone,
              date_of_birth AS "dateOfBirth", sex, weight_kg AS "weightKg",
              blood_group AS "bloodGroup", rh_factor AS "rhFactor",
              city_code AS "cityCode", last_donation_date AS "lastDonationDate",
              is_available AS "isAvailable", created_at AS "createdAt"
       FROM ${hist}.donors WHERE donor_id = $1`,
      [donorId],
    );
    if (result.rowCount > 0) return { donor: result.rows[0], cityCode };
    return null;
  });
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
    const result = await withSerializableRetryFor(getPoolForCity(req.user.donor_city_code))(async (client) => {
      await assertCityWritable(client, req.user.donor_city_code);
      const profile = await client.query(
        `SELECT full_name FROM ${hist}.donors WHERE donor_id = $1 FOR UPDATE`,
        [id.data],
      );
      if (profile.rowCount === 0) return null;
      if (profile.rows[0].full_name.startsWith("[SAMPLE]")) {
        throw new AppError(409, "SAMPLE_DONOR_NOT_UPDATABLE", "Sample donor profiles cannot be made available for real donation requests.");
      }
      return client.query(
        `UPDATE ${hist}.donors
         SET is_available = $1
         WHERE donor_id = $2
         RETURNING donor_id AS "donorId", is_available AS "isAvailable"`,
        [body.data.isAvailable, id.data],
      );
    });
    if (!result || result.rowCount === 0) throw new AppError(404, "DONOR_NOT_FOUND", "The donor was not found.");
    res.json({ donor: result.rows[0] });
  }),
);

router.get(
  "/search/donors",
  authenticate,
  requireRole("HOSPITAL_ADMIN", "BLOODBANK_ADMIN", "SYSTEM_ADMIN"),
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
    if (req.user.role === "HOSPITAL_ADMIN" && !query.city) {
      const hospital = await getActiveHospital(req.user.hospital_id);
      const local = hospital.city_code.trim();
      cities = [local, ...CITY_CODES.filter((code) => code !== local)];
    }

    const selectedCities = req.user.role === "SYSTEM_ADMIN" ? cities : cities.slice(0, 3);
    const offset = (query.page - 1) * query.limit;
    const fetchLimit = offset + query.limit + 1;
    const hasFilters = Boolean(
      query.bloodGroup || query.rh || query.available !== undefined || query.search,
    );
    const results = await Promise.all(
      selectedCities.map(async (cityCode) => {
        const { hist } = schemasFor(cityCode);
        const values = [];
        const conditions = [];
        if (query.bloodGroup) {
          values.push(query.bloodGroup);
          conditions.push(`blood_group = $${values.length}::common.blood_group_t`);
        }
        if (query.rh) {
          values.push(query.rh);
          conditions.push(`rh_factor = $${values.length}::common.rh_t`);
        }
        if (query.available !== undefined) {
          values.push(query.available === "true");
          conditions.push(`is_available = $${values.length}`);
        }
        if (query.search) {
          values.push(query.search);
          conditions.push(`(full_name ILIKE '%' || $${values.length} || '%'
                           OR phone ILIKE '%' || $${values.length} || '%'
                           OR donor_id::text ILIKE '%' || $${values.length} || '%')`);
        }
        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const cityPool = getPoolForCity(cityCode);
        try {
          const rowsPromise = cityPool.query(
            `SELECT donor_id AS "donorId", full_name AS "fullName", phone,
                    date_of_birth AS "dateOfBirth", weight_kg AS "weightKg",
                    blood_group AS "bloodGroup", rh_factor AS "rhFactor",
                    city_code AS "cityCode", last_donation_date AS "lastDonationDate",
                    is_available AS "isAvailable", created_at AS "createdAt"
             FROM ${hist}.donors
             ${where}
             ORDER BY created_at DESC, donor_id DESC
             LIMIT $${values.length + 1}`,
            [...values, fetchLimit],
          );
          const totalPromise = hasFilters
            ? cityPool.query(
                `SELECT count(*)::int AS total FROM ${hist}.donors ${where}`,
                values,
              )
            : cityPool.query(
                `SELECT GREATEST(reltuples, 0)::bigint AS total
                 FROM pg_class
                 WHERE oid = to_regclass($1)`,
                [`${hist}.donors`],
              );
          const [rows, counted] = await Promise.all([rowsPromise, totalPromise]);
          return { cityCode, rows: rows.rows, total: Number(counted.rows[0]?.total ?? 0) };
        } catch (error) {
          req.log?.warn({ err: error, cityCode }, "donor search shard unavailable");
          return { cityCode, rows: [], total: 0, unavailable: true };
        }
      }),
    );
    const byCity = Object.fromEntries(results.map((item) => [item.cityCode, item.total]));
    const total = results.reduce((sum, item) => sum + item.total, 0);
    const unavailableCities = results.filter((item) => item.unavailable).map((item) => item.cityCode);
    const donors = results
      .flatMap((item) => item.rows)
      .sort((left, right) => {
        const timeDifference = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        return timeDifference || right.donorId.localeCompare(left.donorId);
      });
    const pageDonors = donors.slice(offset, offset + query.limit);
    res.json({
      donors: pageDonors,
      page: query.page,
      limit: query.limit,
      total,
      byCity,
      totalApproximate: !hasFilters,
      truncated: total > offset + pageDonors.length,
      hasMore: total > offset + pageDonors.length || donors.length > offset + query.limit,
      meta: unavailableCities.length
        ? { partial: true, unavailableCities }
        : { partial: false, unavailableCities: [] },
    });
  }),
);

export default router;